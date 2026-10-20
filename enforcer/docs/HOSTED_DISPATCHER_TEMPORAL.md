# Hosted dispatcher on Temporal: design

**Status:** proposal, to be reviewed as a gate before any build. Nothing here is implemented.
**Builds on:** [HOSTED_DISPATCHER.md](HOSTED_DISPATCHER.md), the base proposal. Its sandbox runner (section 4), credentials (section 3), repo access (section 5) and logs and metrics (section 6) stand as written. This document replaces its run loop and its lease (section 7) with durable workflows on Temporal, and says what that changes in the server API it asks for (section 9).

## 1. Why Temporal, and why only here

The base proposal turns `run.mjs` into a long-running service. Most of the work in that is making a loop survive things a laptop process never had to: restarts at any instant, two instances at once, a sandbox that outlives the process that started it, holds that must last hours, and attempt counts that must not reset when the process does. Temporal provides each of these as a primitive:

| Need | `run.mjs` today | Base proposal | On Temporal |
|---|---|---|---|
| One dispatcher per graph | `dispatcher-lease` node, `host`/`pid` compare | nonce, server CAS, epoch fencing | workflow id uniqueness: one open `GraphDispatch` per graph id, enforced by the Temporal service |
| Survive a restart mid-run | workers die with the group; orphans swept from `pids.json` | drain on SIGTERM, fail unfinished runs as `dispatcher_shutdown` | the sandbox keeps running; the activity is retried on another worker and reattaches by the sandbox id in its last heartbeat |
| Attempt cap per node | `--max-attempts` per session, in memory | unchanged | per node per epoch, in workflow state, survives restarts |
| Usage-limit and CI holds | `limitedUntil` in memory, re-polled | unchanged | a durable timer |
| Hung worker | turn counting in the stream; `--max-turns` | adds `limits.wall_seconds` | activity heartbeat timeout plus start-to-close timeout |
| Who is running what | `pids.json`, `dispatcher.jsonl` | `/metrics`, a status endpoint | workflow queries and the Temporal UI, mirrored to the graph |

The graph stays the source of truth. Nothing in enforcer-graph moves into Temporal: nodes, runs, leases, verdicts, votes and memory are where they are, and the worker protocol (claim, heartbeat, report through the skill and hooks) is unchanged. Temporal holds only the dispatcher's own state: which nodes it launched, which sandbox each run is in, how many attempts it has spent, and what it is waiting for. Replacing the graph's lease engine with Temporal was considered and rejected (section 11).

## 2. Shape

```
                      tenant namespace "t-<tenant>"            sandbox k8s namespace "dispatch-<tenant>"
 graph API  <---+     +---------------------------------+      +------------------------------+
 (claim, report |     | GraphDispatch  (one per graph)  |      |  Job: run-<run uuid>         |
  by the worker)|     |   pass timer, slots, holds      |      |   claude -p --agent          |
                |     |   +-- NodeRun (one per launch)  |----->|   enforcer:graph-worker      |
                +-----|   |     mint -> sandbox -> final|      |   (claims, heartbeats and    |
   activities         |   +-- Land (merge nodes)        |      |    reports itself)           |
   call the graph     |   +-- RepoLock (one per repo)   |      +------------------------------+
                      +---------------------------------+
                         ^ polled by dispatch-worker pods (one Deployment per tenant)
```

- **Namespace per tenant.** One Temporal namespace per tenant with dispatch enabled, named `t-<tenant uuid>`. This keeps the base proposal's isolation rule (a tenant boundary is a deployment boundary): workflows, history, search attributes and retention are per tenant, and a worker holds credentials for one tenant only.
- **Worker per tenant.** A `dispatch-worker` Deployment per tenant polls task queue `dispatch` in that tenant's namespace. It holds the tenant service credential (base section 3.1) and a Kubernetes service account that may create and delete Jobs in `dispatch-<tenant>` and nothing else. It runs no repo content and no model.
- **Sandboxes as Kubernetes Jobs** in a per-tenant namespace with the base proposal's limits, egress NetworkPolicy and pod security. The microVM backend can come later behind the same `SandboxRunner` interface.

## 3. Language and code reuse

The dispatcher's decision code is JavaScript (`src/dispatch/*.mjs`), mostly pure. Temporal's TypeScript SDK lets the hosted dispatcher import it unchanged, so the first release uses TypeScript, not Go.

- **Activities** import the decision modules directly: `select.mjs` (contention, merge targets, ordering), `model.mjs`, `summarize.mjs` and `stream.mjs`, `remediate.mjs` and `triage.mjs`, `stranded.mjs`, `attention.mjs`, and from `launch.mjs` the `launchCmd`, `workerPrompt`, `remediationPrompt` and env allowlist functions.
- **Workflow code imports none of them.** Workflow code is replayed and must be deterministic; decision modules change between releases, and a changed decision replayed against an old history is a non-determinism failure. So every decision is computed in an activity and its result is recorded in history. Workflow code holds only control flow: timers, signals, child workflows, counters.
- `api.mjs` is the HTTP client for every activity that calls the graph, keeping its retries and `X-Graph-Client`.

Go remains possible later; nothing in the workflow contract depends on the SDK language.

## 4. Workflows

### 4.1 `GraphDispatch` (one per graph)

**Id:** `dispatch/<graph uuid>`, with id conflict policy *fail*: starting a second one for the same graph is refused by the service. That is the single-dispatcher guarantee. Started by `PUT /dispatch/config` enabling a graph (section 8) or by a person from the CLI; stopped by a `stop` signal.

**State:** slots in use, running `NodeRun` children by node key, attempts per `(node key, epoch)`, `heldUntil` and its reason (`harness_limit`, `ci`), the last pass summary, and the graph lease epoch.

**Loop:**

1. Activity `acquireGraphLease` (base section 7, kept for exclusion against a *local* dispatcher on the same graph): acquire with `owner_nonce` = this workflow's run id. 409 means a local dispatcher holds the graph: the workflow sleeps 5 minutes and retries, and reports `held_by_local` in its status query.
2. Every pass: activity `planPass(graph, state)` reads the frontier, live runs, verifying nodes and the tenant config, and runs the same decisions `run.mjs` makes on a tick: which ready nodes to launch, model and tier, contested resources, merge-target ordering, nodes to triage, and whether anything is still runnable, running or verifying. It returns a plan; the workflow starts children for it.
3. Children: `NodeRun` for agent nodes, `Land` for merge nodes, each with a deterministic id (section 4.2) so a pass replayed after a crash cannot launch twice.
4. Wait: a timer for `interval` (default 30 s), cut short by a `wake` signal or a child completing. While `heldUntil` is in the future the timer runs to it and no launches happen; children keep running.
5. Lease renewal: activity `renewGraphLease` on its own 30 s timer (a third of the 90 s TTL, as in the base proposal). Losing it (409 with another nonce) stops new launches and leaves running children to finish.
6. Exit: when `planPass` reports nothing runnable, running or verifying, release the lease and complete. A graph that only waits on verdicts keeps looping, as today without `--exit-when-idle`.
7. Continue-As-New every 500 passes or when history passes 10,000 events, carrying state forward, to stay well inside the 51,200-event limit.

**Signals:** `stop` (no new launches; children finish; then complete), `drain` (same, then hold until `resume`), `resume`, `wake` (pass now: sent by the graph-event bridge in section 7), `configChanged`.
**Queries:** `status` (running, holds, waiting on verdict, next pass time, attempts) for the CLI, the portal and the base proposal's status record.

### 4.2 `NodeRun` (one per launch)

**Id:** `run/<graph uuid>/<node key>/e<epoch>/a<attempt>`. Attempt numbers are the dispatcher's own, counted in `GraphDispatch` per node per epoch; they are not the graph's run attempt number, which the worker's claim creates.

**Steps**, each an activity:

1. `mintCredentials`: worker token (run-bound, expiry = wall limit + grace; base sections 3.2 and 9.3) and repo token (base section 5.2). Failure is a failed launch, never a fallback; it counts as `infra` (section 6).
2. `runSandbox`: create the Job from `SandboxSpec` (base section 4), then stream its output until it exits.
   - **Heartbeat** every 20 s with details `{sandbox_id, stream_offset, turns, last_event_at}`. Heartbeat timeout 90 s.
   - **Reattach.** If the activity is retried (the dispatch-worker pod died), it reads the last heartbeat details and, when `sandbox_id` is set and the Job still exists, resumes streaming from `stream_offset` without starting a new sandbox. This is the main reliability gain over a laptop process, and it removes the base proposal's `dispatcher_shutdown` failures.
   - **Turn cap** as today: the activity counts assistant turns in the stream and kills the sandbox past `--max-turns` or `data.max_turns`.
   - **Timeouts:** start-to-close = `limits.wall_seconds` + 5 minutes. Retry policy: up to 3 attempts, for infrastructure errors only (`sandbox_start_failed`, `evicted`). A harness exit is a result, not an error, and is never retried by Temporal.
   - **Cancellation** (a `stop` with `kill`, or a person cancelling the run in the graph): delivered on the next heartbeat; the activity calls `kill(grace_ms)` on the sandbox.
3. `finalize`: run `summarize.mjs` over the stored stream; read the graph run. If the worker claimed and exited without reporting, fail the graph run with the log object key (today's behaviour). Classify the outcome (section 6). Record `log_object` and `sandbox_id` on the run (base section 9.6). Revoke the worker token.
4. **Branch on the outcome**, exactly as `run.mjs` does, using the governor decision codes (DISPATCHER.md "What a denial means"):
   - `push_needs_approval_surface` → child `Salvage` (a short second sandbox over the same work volume: push, open the PR, land it).
   - `graph_run_not_open` → return `remediate` to `GraphDispatch`, which launches the next attempt with the remediation prompt if attempts remain.
   - `destructive_*` → no salvage; triage.
   - harness usage limit → return `hold` with the reset time; `GraphDispatch` sets `heldUntil`. No attempt spent.
   - success → return `done`.

### 4.3 `Land` (merge nodes)

Merge nodes need no agent (DISPATCHER.md "Merge nodes"). `Land` runs the existing path durably:

1. Acquire the repo lock: signal-with-start `RepoLock` id `lock/<repo>`, wait for a `granted` signal. This gives "one land per repo at a time" across every graph in the tenant, not just within one dispatcher.
2. Activity `checkPr`: the existing `gh pr view` guard (repo, not a fork, head `graph/<key>` in this graph). Refusals are final.
3. Activity `claimMergeNode` with `Idempotency-Key` = the workflow id (the graph replays the same run for 24 h).
4. Activity `landPr`: `bin/land-pr.sh` in a sandbox with a repo token. It heartbeats the graph run (`POST .../heartbeat`) every lease/3 from inside the activity, and honours `cancel_requested`.
5. Activity `completeRun` with land-pr's verbatim output as evidence; exit 0 succeeded, 2 to 5 failed.
6. Release the lock.

### 4.4 `RepoLock` (one per repo)

A small entity workflow holding a FIFO of waiting `Land` workflow ids, granting one at a time, with a 2-hour hold timeout so a lost holder cannot block a repo forever. It completes when its queue is empty.

## 5. Two leases, two owners

There are two different leases and they must not be confused.

- **The graph run lease** (5 minutes by default, on the node) belongs to whoever claimed the run. For agent nodes that is the worker in the sandbox: its hooks and ticker heartbeat it, exactly as on a laptop. The dispatcher never heartbeats an agent run. For merge nodes the dispatcher claims, so `landPr` heartbeats it.
- **The Temporal activity heartbeat** says only that the dispatcher is still watching the sandbox.

So a dispatch-worker pod dying does not touch the graph: the worker in the sandbox keeps its run alive, and the retried activity reattaches. A sandbox dying does not leave the graph wrong either: the worker stops heartbeating, the graph run lapses and is reclaimed as `abandoned`, and `finalize` records the infrastructure outcome.

## 6. Outcomes and attempts

`finalize` classifies every launch into one class. Only the first two spend an attempt.

| Class | Examples | Attempt spent | Graph run |
|---|---|---|---|
| `failed` | worker reported failure; tests failed; judge rejected | yes | as the worker reported |
| `silent` | claimed and exited without reporting | yes | failed by the dispatcher with the log object |
| `limited` | harness usage limit | no | failed `infra:harness_limit` |
| `infra` | `sandbox_start_failed`, `evicted`, `oom`, credential mint failed, `needs-auth` MCP | no | failed `infra:<reason>` (base section 9.5) |
| `denied` | governor denial with a known code | per the branch in 4.2 | as reported |
| `done` | reported success | n/a | as reported |

Attempts are counted per node per graph epoch, so a `graph_reset` starts every node fresh, as a person would expect. The default cap stays 2, plus one triage launch, and is now durable: a restart does not hand a node fresh attempts.

Three `infra` outcomes in a row for one tenant pause launches (`heldUntil` 15 minutes, reason `infra`) and raise the alert in section 9. This replaces "three `needs-auth` workers in a row stop the dispatcher".

## 7. Graph events into the dispatcher

Today the dispatcher polls. Polling stays as the floor (the 30 s pass), but a pass can start sooner:

- A small `graph-event-bridge` (in the dispatch-worker pod) follows the graph's activity stream (`GET /graphs/{id}/stream`, the SSE feed) for each graph with an open `GraphDispatch`, and sends `wake` when a node becomes ready, a run ends, or a gate is decided.
- The stream is not at-least-once (STREAM_CONTRACT), so a missed event costs one pass interval, never a stuck node.

## 8. Server API

From the base proposal's section 9:

| Item | Status here |
|---|---|
| 9.1 dispatcher lease | **still needed**, for exclusion between a hosted and a local dispatcher on one graph. Hosted uses the workflow run id as `owner_nonce`. |
| 9.2 epoch fencing | **still needed** on `Land`'s claim and complete, and on the dispatcher failing a run. |
| 9.3 run-bound worker credentials | **still needed**. |
| 9.4 tenant dispatch config | **still needed**; `PUT` also starts or signals `GraphDispatch` through a dispatch control endpoint on the worker (an authenticated internal call) or a Temporal client in the API. |
| 9.5 infrastructure outcome | **still needed**: the classes in section 6. |
| 9.6 run artefacts | **still needed**. |
| 9.7 dispatcher status record | **simplified**: the `status` query is the source; an activity mirrors it to the graph once a minute so the portal needs no Temporal access. |
| 9.8 audit | **still needed**; add workflow start, stop and force-acquire. |

No new endpoint is needed for Temporal itself.

## 9. Operations

**Temporal service, self-hosted, first release.**

- Deployed with the official Helm chart into the instruxi cluster as Terraform scope `temporal` in enforcer-digital-ocean, pinned like every other service.
- Persistence and visibility both on **PostgreSQL** (supported since server 1.20), in a new database on the existing app Postgres cluster: no Cassandra, no Elasticsearch. If dispatch load ever competes with the app, move it to its own small cluster.
- Frontend reachable only inside the cluster; mTLS between workers and frontend; namespaces created by a migration job when a tenant enables dispatch.
- Retention 14 days of closed workflow history per namespace (the local stream default).
- Payloads carry node keys and ids, never tokens or stream content. A payload codec encrypts the rest at rest anyway, keyed per tenant.

**Temporal Cloud instead.** It works without changes (namespaces per tenant, API keys). A rough count is about 50 billable actions per agent node run (a workflow start, five or six activities, heartbeats every 20 s to the server, timers) and about 2 per pass per open graph, roughly 6,000 a day for a graph kept open around the clock. That is cents per day at $50 per million actions, so the cost question is the Business plan's $500 monthly minimum against running the service ourselves, plus data residency. Decide at review (section 12).

**Metrics.** The base proposal's series (section 6), emitted by activities and tagged with tenant and graph, plus Temporal's own SDK metrics (schedule-to-start latency, activity failures, workflow task failures). Alerts:

- launches paused by `infra`;
- any `GraphDispatch` with a workflow-task failure (non-determinism or a bug);
- a `NodeRun` older than its wall limit;
- a `RepoLock` holder older than 1 hour.

**Deploys.** Worker Versioning, with workflows pinned to the build that started them. `GraphDispatch` uses Continue-As-New, so long-lived graphs move to the new build at their next continue. A change to workflow control flow that existing histories would replay differently goes behind `patched()`.

## 10. Failure walk-through

| Event | What happens |
|---|---|
| dispatch-worker pod killed during a run | the sandbox keeps running; the worker in it keeps its graph run alive; `runSandbox` is retried on another pod, reads `sandbox_id` from its last heartbeat and reattaches at `stream_offset` |
| sandbox evicted | the activity sees the Job gone; `finalize` records `infra:evicted`; the graph run lapses and is reclaimed as `abandoned`; no attempt spent; next pass relaunches |
| Temporal service down | no new launches, no reattach; running sandboxes keep working and report to the graph directly; on recovery activities resume |
| graph API down | activities retry with backoff; the worker in the sandbox retries its own calls as today |
| two people enable dispatch on one graph | the second `GraphDispatch` start is refused by id; the API answers "already dispatching" |
| a person runs local `enforcer dispatch` on a hosted graph | the graph lease is held by the hosted workflow; local exits 3, as today |
| worker never reports | the turn cap or the wall limit ends the sandbox; `finalize` fails the graph run as `silent` |
| usage limit hit | one `NodeRun` returns `hold`; `GraphDispatch` sets a durable timer to the reset; nothing launches until then; restarts do not lose the hold |
| graph reset mid-run | the worker's heartbeat answers `reclaimed`; it stops; `finalize` sees the run cancelled; the new epoch's attempts start from zero |

## 11. Alternatives considered

- **Temporal as the graph's lease engine** (one activity per node, agents completing them from outside Temporal through task tokens). Rejected: two sources of truth for run state; tokens change on every retry, so an agent holding the old one is silently orphaned; foreign agents still need the graph's frontier to find work; and every heartbeat from every agent would be a Temporal action.
- **DBOS Transact (Go or TypeScript), as a library on the app Postgres.** No new service to run, durable steps and timers in our own database. Smaller and younger than Temporal (no equivalent of Worker Versioning or the history UI), and the reattach-by-heartbeat-details pattern would be our code. Worth a one-day spike against section 4.2 before the review decides.
- **LangGraph.** An in-process agent runtime; it does not run foreign agents such as a Claude Code session, and has no lease or heartbeat for a third party. Not a fit for the dispatcher. It can be a worker type later.
- **Keep `run.mjs` as a service** (the base proposal alone). Viable, but sections 1 and 10 are what we would be rebuilding by hand.

## 12. Phases

1. **P0, the service.** Temporal on the instruxi cluster (Postgres only), one namespace for the Instruxi Workspace tenant, an empty `dispatch-worker` that registers. Exit: the Temporal UI shows a test workflow.
2. **P1, merge nodes only.** `GraphDispatch` plus `Land` and `RepoLock`. No model, no agent sandbox; `land-pr.sh` in a minimal sandbox. Exit: a graph's merge nodes land through the hosted dispatcher with evidence identical to the local one, and a killed dispatch-worker pod mid-land finishes the land.
3. **P2, agent nodes, one tenant.** `NodeRun` with the Job sandbox, run-bound credentials, reattach, outcomes and holds. Exit: a 10-node internal plan runs end to end with no laptop. The P2 test kills a dispatch-worker pod during each of the four `NodeRun` steps and loses no node.
4. **P3, the rest of `run.mjs`.** Salvage, remediation, triage, warm-off defaults, the event bridge, metrics and alerts, the status mirror, and the CLI talking to a hosted graph (`enforcer dispatch status|stop` call the API, which signals the workflow).
5. **P4, more tenants.** Namespace and worker provisioning from `PUT /dispatch/config`, per-tenant quotas, and the microVM backend if a tenant needs it.

Local `enforcer dispatch` stays supported throughout and keeps passing its suites.

## 13. Open questions for the review

- Self-hosted Temporal or Temporal Cloud (section 9)?
- TypeScript for the first release (section 3): agreed?
- Is a DBOS spike worth a day before deciding (section 11)?
- Model credentials, carried over from the base proposal: the tenant's own provider key or a platform key with metering? The sandbox needs one of them as a third per-run secret.
- Headless MCP tools: DISPATCHER.md records that `claude -p` refused the graph tools when the hosted MCP server marked them `requiresUserInteraction` (2026-10-02). Confirm that is resolved for sandboxed workers before P2, or P2 cannot start.
- Should a node waiting on a verdict or a person past a deadline be escalated by the dispatcher (a durable timer per waiting node, notifying through the graph), or does that belong in enforcer-graph's worker? This design leaves it out.
