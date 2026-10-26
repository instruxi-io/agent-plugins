# Hosted dispatcher: design

**Status:** proposal, to be reviewed as a gate before any build. Nothing here is implemented.
**Follow-up:** [HOSTED_DISPATCHER_TEMPORAL.md](HOSTED_DISPATCHER_TEMPORAL.md) proposes running the dispatcher's loop and lease (sections 7 and 8 below) as Temporal workflows, keeping sections 3 to 6.
**Scope:** a dispatcher that runs as a service for one tenant, with no operator machine behind it. Today's dispatcher (`enforcer dispatch`, `src/dispatch/*.mjs`, flags in [graph/DISPATCHER.md](graph/DISPATCHER.md)) is a process on a person's workstation that keeps N headless workers busy, each in a local git worktree, under that person's sign-in, `gh` login and filesystem.

## 1. Goals and non-goals

Goals:

- A tenant turns dispatch on and a plan's ready nodes get worked, PR'd and landed with no person's laptop involved.
- A tenant's dispatcher can reach only that tenant's graphs, repos and credentials. A bug in one tenant's worker cannot read another's.
- Every worker runs in a throwaway sandbox that holds exactly one run's credentials and is destroyed afterwards.
- Safe under restarts and rescheduling: a container killed at any instant leaves no node stuck and no two dispatchers working one graph.
- Operable: logs and metrics leave the box through standard sinks; nothing needs SSH.

Non-goals (first release): a multi-tenant dispatcher process shared across tenants (one dispatcher per tenant, see section 2); running gates or releases (these stay with a person, as now); replacing the worker protocol (skill, hooks, agent are unchanged); Windows hosts.

## 2. Module split

`src/dispatch` already separates pure decisions from process effects. The hosted design keeps the decision code and replaces five effect modules behind interfaces. Each interface is one small object injected into `Dispatcher` (`run.mjs`), so the local dispatcher is the same code with the local implementations.

| Interface | Local implementation (today) | Hosted implementation |
|---|---|---|
| `CredentialSource` | the user's OAuth sign-in via `bin/enforcer-headers.mjs`; `mintWorkerToken` when `ENFORCER_WORKER_AGENT_ID` is set | tenant service credential, per-run worker token always minted (section 3) |
| `SandboxRunner` | `spawnWorker` + `killGroup`: detached child, own process group | one container or microVM per run (section 4) |
| `RepoAccess` | `worktree.mjs`: `git worktree add` from a local checkout under `--repo-root` | scoped token plus fresh clone into the sandbox (section 5) |
| `LogSink` / `Metrics` | `logs.mjs`: `dispatcher.jsonl` and per-run streams under the state dir, pruned by age and size | stdout JSON lines, object-store stream upload, `/metrics` (section 6) |
| `LeaseStore` | `lease.mjs`: `(host, pid, nonce)` in the data of a `dispatcher-lease` node | owner nonce, TTL, server compare-and-set (section 7) |

One dispatcher service instance serves exactly one tenant and is configured with that tenant's id and service credential. This is deliberate: tenant isolation is then a deployment boundary (separate credential, network policy and quota), not a property the dispatcher code must get right on every line. Many tenants means many small instances, orchestrated by the platform.

## 3. Credentials and tokens

Three kinds of secret, with different holders:

1. **Tenant service credential.** An agent credential (the same `POST /agents/{id}/credentials` route `mintWorkerToken` uses today) with scopes `graph:read`, `graph:write` and `agents:credentials:create`, bound to the tenant. It is held only by the dispatcher process, from the platform's secret store, and read through `CredentialSource.headers()` (replacing `GRAPH_AUTH_HELPER`). It is never placed in a sandbox. Rotation: the secret store supplies a new value; the dispatcher re-reads it on a 401 (retry once) and on a timer, so rotation needs no restart.
2. **Worker token, per run.** Minted by the dispatcher immediately before launch with `WORKER_SCOPES = ['graph:read','graph:write']`, `expires_in_days: 1` today. Hosted tightens this: expiry equals the run lease plus a grace (hours, not a day), the token name carries the run id, and the dispatcher revokes it when the run ends (new `DELETE` use of the credentials route; today it only expires). It reaches the worker as `GRAPH_API_KEY`, which `workerEnv` already does. Today minting is optional (`null` when no worker agent is configured); hosted makes a failed mint a failed launch, never a fallback to the service credential.
3. **Repo token.** A short-lived, repo-scoped token from the source host (section 5), delivered as `GH_TOKEN`. Same rule: per run, never the dispatcher's own.

The worker environment stays an allowlist, not a denylist. `ENV_ALLOW` and `ENV_ALLOW_PREFIX` in `launch.mjs` are reused as the starting list, minus the host-specific entries (`HOME` becomes the sandbox home, `CLAUDE_PLUGIN_ROOT` points into the image). The only secrets a sandbox may contain are the worker token and the repo token. A test asserts the service credential value appears in no sandbox environment, command line or mounted file (extending the existing worker-env allowlist test).

## 4. Sandbox runner

```ts
interface SandboxRunner {
  start(spec: SandboxSpec): Promise<Sandbox>;      // returns when the harness process is running
  // Sandbox: { id, stream: AsyncIterable<Buffer>, wait(): Promise<{exit, reason}>, kill(grace_ms): Promise<void> }
}
interface SandboxSpec {
  image: string;               // pinned digest containing node, git, gh, the harness CLI and the enforcer plugin
  cmd: string[];               // exactly what launchCmd() produces today
  env: Record<string,string>;  // workerEnv() output: the allowlist plus worker and repo tokens
  repo: { url, ref, base, branch };   // see section 5
  limits: { cpu, memory_mb, pids, disk_mb, wall_seconds };
  network: 'egress-allowlist';        // see below
  run_id: string; tenant: string;
}
```

- **Backends.** Container (Kubernetes Job or a container runtime on a worker node) first; a microVM backend (Firecracker class) for tenants who need a hard kernel boundary. The interface is the same, so the dispatcher does not know which it has.
- **One run, one sandbox.** No warm sessions across nodes: the local `--resume` warm-worker optimisation (`select.mjs` `affinityOrder`, `sessionUsable`) is disabled hosted, because it carries conversation and filesystem state between nodes. `--no-warm` behaviour is the hosted default; the warm code stays for local use.
- **Egress allowlist.** The sandbox may reach the graph API host, the source host (git and API), the model provider, and the package registries the repo's tests need (per-tenant, configured). Everything else is dropped, including the cloud metadata address and the dispatcher's own network.
- **Filesystem.** Read-only image, writable work volume and tmpfs home, destroyed on exit. No host mounts, no docker socket, non-root user, no extra capabilities, seccomp default.
- **Governor still runs.** The worker's own governor hooks are part of the image and run inside the sandbox as today (`ENFORCER_PROFILE` headless). The sandbox is the outer boundary; the governor is the inner policy and its decision records go to the log sink.
- **Kill and timeouts.** `kill(grace_ms)` replaces `killGroup` (SIGTERM, grace, SIGKILL): the runner stops the container with the same grace. `limits.wall_seconds` is a hard ceiling in addition to the existing turn cap and `--max-budget-usd` accounting (`run.mjs`, `data.max_turns`), because a hung process emits no turns to count.
- **Exit meaning.** `wait()` returns an exit code and a reason (`exited`, `oom`, `wall_clock`, `evicted`, `killed`). `evicted` and `killed` by the platform are infrastructure failures: the run is failed with that reason and no attempt is spent, the same treatment as a harness usage limit today.

## 5. Repo access

The local dispatcher assumes a checkout under `--repo-root` and uses `git worktree add` (`worktree.mjs`: `resolveBase`, `.worktreeinclude`, `.worktreeshare`, base resolution from `data.base`, graph bases, registry, then `origin/HEAD`). None of that exists in a container. Hosted replaces it with:

1. **Resolve** the repo from `data.repo` through a tenant repo registry (a graph-level mapping name to clone URL and default base; the `graph bases` and `registry` inputs of `resolveBase` already model this). A node naming an unregistered repo fails the launch with a clear message; it never becomes a free-form URL.
2. **Credential:** a deploy key or app installation token scoped to that one repository, minted per run by a `RepoTokenProvider` (GitHub App installation token with `contents:write` and `pull_requests:write` for the one repo; the equivalent for other hosts). Not a user PAT, not an org-wide token. Delivered as `GH_TOKEN` and used by `gh` and a credential helper; it expires within the run's wall limit.
3. **Clone** inside the sandbox by an init step, not by the dispatcher: shallow clone of the base, `git switch -c graph/<key>`. The base resolution logic (`resolveBase`) is reused unchanged; only the object it resolves against changes (remote refs, not a local checkout). `.worktreeinclude` becomes "files the tenant's registry entry says to inject", delivered from the secret store; `.worktreeshare` (symlinks to a shared dir) has no hosted equivalent and is dropped.
4. **Branch protection is the guard.** The token can push `graph/*` branches and open PRs. It cannot push the default branch; the tenant's branch protection and required checks are the authority, as they are today.
5. **Landing.** `bin/land-pr.sh` works with `gh` and a token and needs no checkout beyond the clone, so it runs unchanged inside the sandbox. The dispatcher-side salvage and landing-completion paths (`salvage.mjs`, `land-complete.mjs`) currently run in the worktree the dispatcher owns; hosted runs them in a short second sandbox over the same clone (the work volume is kept until the run is finalised), so the service never executes repo content itself.
6. **Prune.** `prune.mjs` (remove worktrees whose branch is merged or deleted) has no hosted analogue: the work volume is deleted with the sandbox. The remote branch deletion it does stays, through the repo token.

## 6. Logs and metrics

- **Dispatcher log:** the existing JSON line shape (`jsonLine`: level, event, key, run, fields) written to stdout, one object per line, for the platform's collector. The `dispatcher.log` human file and age/size pruning (`pruneLogs`) are local-only. Every line carries `tenant`, `graph` and `run`; no line carries a token (the redaction in `logs.mjs` and `src/graph/redact.mjs` runs before the sink, not after).
- **Worker stream:** the sandbox's stream is redacted as it is read (today `redactFile` runs once the worker exits; hosted redacts in the pipe so unredacted text never reaches storage) and uploaded to tenant-scoped object storage at `runs/<run_id>/stream.jsonl` with the tenant's retention. The node's report and the run record carry the object key in place of today's local log path (the "failed with the log path" text in `run.mjs`).
- **Summaries:** `summarize.mjs` (denials, verification lines, usage-limit parsing, outcome classes) is pure over a stream and is reused unchanged on the uploaded stream.
- **Metrics:** a `/metrics` endpoint (Prometheus text) on the dispatcher, plus the same series as structured log lines for platforms without a scraper. Series, all labelled `tenant`, `graph`:
  - `dispatch_workers_running`, `dispatch_slots_total` (gauges)
  - `dispatch_launches_total{mode,model,result}`, `dispatch_runs_finished_total{outcome}` (outcome: merged, failed, denied, limit, infra)
  - `dispatch_run_seconds` and `dispatch_queue_wait_seconds` (histograms: claim to finish; ready to launched)
  - `dispatch_worker_tokens_total{kind}` and `dispatch_tokens_cost_usd` from the result event usage the dispatcher already parses
  - `dispatch_lease_renew_failures_total`, `dispatch_api_retries_total{status}`, `dispatch_sandbox_start_seconds`
  - `dispatch_harness_limited` (gauge, 1 while holding launches for a usage-limit reset)
- **Health:** `/healthz` (process up) and `/readyz` (holds the lease and can reach the graph API); the platform restarts on failed health and not on idle.

## 7. Container-safe lease

The current lease stores `{owner, host, pid, nonce, until}` on a `dispatcher-lease` node and decides "is this us" by `host` and `pid` (`Lease.isUs`). That breaks in containers: pids are 1 in every container, hostnames are reused or random, and the compare is read-then-patch followed by a re-read, so two dispatchers can both believe they won for a moment.

Design: ownership is the nonce and nothing else.

- **Fields:** `{ owner_nonce, owner_label, acquired_at, renewed_at, ttl_seconds, epoch }`. `owner_label` is free text for humans (pod name, region). The dispatcher never compares `host` or `pid`.
- **Nonce:** a fresh random value per process start. A restarted container is a different owner; it waits out the old TTL or, if it can prove the old one is gone (platform says the previous instance terminated), takes over explicitly.
- **TTL and renewal:** TTL 90 s, renew every 30 s (a third of the TTL, the same ratio the hook heartbeat uses). The dispatcher steps down (stops launching, then drains) if it cannot renew within the TTL, even if its renew calls are merely slow, using its own monotonic clock rather than comparing timestamps with the server's.
- **Compare-and-set on the server.** New endpoint (section 9): acquire and renew are one request, `POST /graphs/{id}/dispatcher-lease {owner_nonce, ttl_seconds, expect_epoch?}`. The server, in one transaction, grants if the lease is absent, expired by the server's clock, or already held by the same nonce; otherwise answers 409 with the holder's label and `expires_at`. `epoch` increments on each change of owner. This replaces write-then-re-read.
- **Fencing.** Every dispatcher-originated write that matters (claiming on a worker's behalf, failing a run, landing completion) sends `X-Dispatcher-Epoch`; the server rejects a stale epoch with 409. A paused-then-resumed dispatcher that lost the lease cannot act on it.
- **Takeover:** `--takeover` becomes an explicit `force: true` on acquire, recorded in the node history, available only to a person or an operator credential.
- **Drain on SIGTERM:** the platform's termination signal makes the dispatcher stop launching, let running sandboxes finish up to a drain window (shorter than the platform's kill delay), then fail the runs that did not finish with reason `dispatcher_shutdown` (no attempt spent) and release the lease. This matches today's stop behaviour in `run.mjs`.
- **Worker crash recovery** needs nothing new from the lease: a worker's own run lease (heartbeat) lapses on the server and the node returns to the frontier, which is how salvage and `lapsed()` in `select.mjs` already reason.
- **Local compatibility:** the local dispatcher moves to the same endpoint; `host` and `pid` stay in `owner_label` for readable messages. Until the server ships it, `LeaseStore` keeps the node-data implementation.

## 8. Reused, replaced, new

Reused unchanged (pure or already host-neutral): `select.mjs` (contention, merge targets, ordering; warm affinity switched off by config), `model.mjs`, `util.mjs`, `summarize.mjs` and `stream.mjs` (over uploaded streams), `remediate.mjs` and `triage.mjs` decisions and prompts, `workerPrompt`/`remediationPrompt` (including the untrusted-input quoting), the `api.mjs` client with its retries and `X-Graph-Client`, `launchCmd`, `allowedTools` and the env allowlist logic, `land-pr.sh`, and the whole run loop in `run.mjs` (tick, reap, usage-limit and CI holds, turn counting) over the new interfaces.

Replaced: `Lease` (section 7); `spawnWorker`, `killGroup`, `pidAliveGroup` and the `pids.json` orphan sweep (a platform lists sandboxes by run label instead; no pid files); `worktree.mjs` and `prune.mjs` local parts (section 5); `logs.mjs` file handling and pruning (section 6); the `GRAPH_AUTH_HELPER` credential path (section 3); `dispatch-command.mjs`'s `start`/`status`/`stop` (a daemonised local process) become service lifecycle (deploy, `/readyz`, SIGTERM drain), though the `status` content (running, waiting, needs you) is served from the graph by the same queries.

New: the tenant dispatch configuration and registry (repos, egress allowlist, concurrency, budgets), the repo token provider, the sandbox backends, the metrics endpoint, a worker-token revoke call, and the server API below.

Local mode remains supported and keeps passing its current suites; hosted mode is a configuration of the same `Dispatcher` with different implementations, selected at construction. Tests for each interface use a fake implementation, as the existing dispatcher tests use a fake API and a fake harness.

## 9. API the enforcer-graph server must add

1. **Dispatcher lease:** `POST /graphs/{graph}/dispatcher-lease` (acquire or renew with owner nonce, TTL, optional `force`; 200 with `epoch` and `expires_at`, or 409 with the holder), `DELETE` (release if the nonce matches), `GET` (holder, for status). Server-side time only; transactional. Replaces the `dispatcher-lease` node hack, which stays as the fallback.
2. **Epoch fencing:** `X-Dispatcher-Epoch` accepted on run-fail, run-complete and claim-on-behalf routes; 409 `stale_epoch` when it is older than the lease's.
3. **Worker credential lifecycle:** per-run worker credentials bound to a run (`POST /agents/{id}/credentials` with `run_id`, `expires_in_seconds`; scope check that the token can touch only that graph; `DELETE /agents/{id}/credentials/{cid}` for revoke on run end). Today credentials are day-granular and are not tied to a run.
4. **Tenant dispatch config:** `GET/PUT /dispatch/config` per tenant: enabled, max concurrent workers, node types, daily budget, repo registry (name to clone URL, default base, injected-file references), egress allowlist. The dispatcher reads it; changes apply on its next pass.
5. **Run infrastructure outcome:** a way to fail a run with `reason` in an `infra` class (`evicted`, `oom`, `dispatcher_shutdown`, `sandbox_start_failed`) that does not count against `max_attempts`, mirroring the existing harness-limit handling.
6. **Run artefacts:** the run record accepts `log_object` (the stored stream's key) and `sandbox_id`, and the run read model returns them so a person can open the log from the graph.
7. **Dispatcher heartbeat record:** `POST /graphs/{graph}/dispatcher/status` (running workers, held-for-limit, last pass) so "what is running and what needs you" works without reaching the dispatcher's own endpoint.
8. **Audit:** takeover, force-acquire, credential mint and revoke are recorded in the tenant audit log with the dispatcher's label.

## 10. Threats and open questions

Threats considered: a hostile repo or prompt injection making a worker exfiltrate (mitigated by the token being the only secret, egress allowlist, per-run scoping and expiry); a worker escaping the sandbox (kernel boundary per backend, no host mounts, non-root); one tenant's failure reaching another (one dispatcher per tenant, separate credentials); a dispatcher split-brain (nonce, server CAS, epoch fencing); runaway cost (wall limit, turn cap, budget, per-tenant daily cap, metrics alert); log leakage (redaction before the sink).

Open questions for the review:

- Which sandbox backend ships first, and does the platform already run containers we can target or do we operate the nodes?
- Repo hosts beyond GitHub: is the GitHub App path enough for the first release?
- Who pays model usage: the tenant's own provider key (stored where, injected how) or a platform key with metering? The design assumes the harness credential is a third per-run secret and does not settle it.
- Do gates and review items need a hosted notification channel, or is the graph's own UI enough?
- Retention defaults for streams (the local default is 14 days or 2 GiB).
- Is a one-day worker token acceptable as an interim until credentials can be bound to a run?
