# Changelog

## Unreleased

## 1.3.27

- The enforcer plugin's locked MCP tool list now matches the connector on production (enforcer-v3-mcp 2d60cef). It adds the GVNR tools `table_state`, `check_work`, `hand_over`, `log_decision`, `end_shift`, `fill_scorecard`, `suggest_recipe_change` and `decide_recipe_suggestion`, and six live tools the old list was missing (`graph_decide`, `graph_overview`, `graph_recall`, `plan_link`, `start_plan`, `update_task`). The version check no longer reports them as unknown.

## 1.3.26

- The governor's `deploy.publish` and `git.rewrite_history` rules now match only when the deploy or reset is the command itself. Unanchored, they fired on any mention of the words: on one machine every one of the 35 shadow hits in a fortnight was a `grep "terraform apply"` over docs or a log, with no deploy among them. `terraform -chdir=<dir> apply` and `git -C <dir> reset --hard` still match.

## 1.3.25

- The governor speaks plain English to people: allow, ask and block reasons describe the effect in everyday words (technical term in brackets), give money as amount, limit and period, and say what to do next. With a person present the Allow dialog shows only that sentence; headless sessions keep the machine line first, and stderr and receipts carry it as before. Messages name commands that exist in this plugin (`/enforcer:governor resume`, `/enforcer:governor limit 40`), and `resume` is now an `enforcer governor` subcommand.
- The governor README now covers Codex and Grok Build: install pointers (Grok marked experimental, Codex not yet run live), harness-specific spend readers, `codex`/`grok-cli` in receipts, summary-receipt token counts, and session registration (provenance levels 2–3). Docs only.
- Docs: `docs/HOSTED_DISPATCHER_TEMPORAL.md` proposes running the hosted dispatcher's loop and lease as Temporal workflows (one per graph, one per launch, durable attempts and holds, sandbox reattach after a worker restart), building on HOSTED_DISPATCHER.md. A design for review; nothing is implemented.

## 1.3.24

- Claude Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 are priced at Anthropic's published rates, each with its own cache-read rate (0.05x input on the 5.5 family, 0.025x on 5.1), and Haiku 5.5 at its higher rates for any request whose prompt is over 100,000 tokens. Unlisted, Haiku 5.5 had been metered as Opus 5 (50x high) and Fable 5.1 as Opus 5 (2x low). The Claude Code transcript reader now prices each message at its model's own rates instead of one weighting for every Claude model; a cursor kept by an older reader is read again once. Verified against Claude Code's own figure for a Haiku 5.5 session ($0.0042030).

## 1.3.23

- Summary receipts now carry the session's token counts as measured (`usage`: input, output, cache_read, cache_write, and Grok's reasoning), beside the dollar figure. Dollars are counts times a price table that can be wrong (an unlisted model such as Haiku 5.5 is priced as Opus); the counts let governance read the session without trusting it. The Claude Code, Grok and Codex readers all keep them; a cursor saved by 1.3.22 is read again from the top once so its counts are complete.

## 1.3.22

- Spend limits now work under Grok Build and Codex: the governor reads each harness's own session log (Grok's per-turn costUsdTicks, Codex's cumulative token_count priced at the turn's model) instead of the Claude Code reader, which found $0 there.

## 1.3.21

- Acceptance lines now run in two shapes graph workers write all the time, so the judge sees their output instead of a "not run" note: `grep -m N` (also `-mN`, `--max-count=N`), and a count threshold `test $(grep -c <literal> <one path>) -ge N` / `test $(wc -l|-c <one path>) -le N` (`wc -c < <path>` too). Still no shell: the inner command must be a single `grep -c` or `wc` on one path in the checkout, runs as argv, and the plugin does the comparison, printing `count 14 -ge 10: true` as evidence.

## 1.3.20

- **`enforcer dispatch` honours `--allow-browser-signin` and `--agent` at preflight**: the preflight identity check never received either flag (or `--workers`), so every plan estimated over 2 h failed it whatever was passed, and `--agent <name>` placed before the graph id was taken for the graph. Both flags now reach preflight as they reach the dispatcher.

## 1.3.19

- **Agent ids name the harness**: a session's agent id is `grok:<8>` under Grok Build and `codex:<8>` under Codex, not `claude:<8>` for every harness. Receipts, the SessionStart attribution and registration, local state and the status line all use the same id, and `/resume <8>` finds an agent under any of the prefixes. Release only after enforcer-governance migration 016 is deployed (instruxi-io/enforcer-governance#27).

## 1.3.18

- Receipts and session registration now name the harness actually running: Grok Build sessions record `grok-cli` and Codex sessions `codex` (Codex loads its own `hooks/codex/hooks.json`, the Claude Code hooks plus `--harness codex`), where every receipt used to say `claude-code`. Codex sessions now register with the control plane. Codex will ask to re-trust the plugin's hooks once after this update.

## 1.3.17

- The governor's session start now also announces the session under the harness actually running it (Claude Code by `CLAUDECODE=1`, Grok by its shim's `ENFORCER_HARNESS`) with its full session id, so the control plane can hold that session's telemetry to that harness (enforcer-governance session registry, provenance level 2). Codex sets no marker yet and announces nothing; the project attribution is unchanged.
- The repo is now `instruxi-io/agent-plugins` (was `claude-plugins`); install commands, plugin `repository` fields and the receipt schema `$id` use the new name. GitHub redirects the old one, so existing marketplaces keep updating, and the marketplace name stays `instruxi`.

## 1.3.16

- When a plan waits on a person (a ready gate, an open review item, a node failed on a human decision), the `enforcer:graph` skill and `/enforcer:dispatch` now ask in the same turn with `AskUserQuestion`, or give the filled-in `! graphwatch decide|resolve` command, instead of ending on a passive list; the dispatcher's `ATTENTION` line and `enforcer dispatch status` print the exact answering command per item.

## 1.3.15

- Browser sign-in (`/enforcer:login`) no longer ends with `Sign-in failed: how is not defined`: a duplicated block of command branches from #268 is removed, so the real sign-in output (granted scopes, workspace, wrong-workspace hint, reconnect step) prints again.
- `/enforcer:login` registers this machine with Enforcer once and reuses that registration on every later sign-in (kept in `credentials.json` as `oauth_client`, which `logout` leaves in place). Consent on the server is per account and per client, so a client registered afresh on every sign-in left every other workspace's account without consent for it, and `/enforcer:workspace switch` answered `consent_required` for all of them. Now one sign-in per workspace is enough, after which switching between them works in both directions (with enforcer-v3 #523, which clips the switch to the target workspace's consent instead of refusing). A saved client the server no longer knows, or one from another server, is registered again; the sign-in says which happened.

## 1.3.14

- Dispatched workers get this plugin's `bin` first on PATH, so `enforcer` inside a worker is the dispatcher's own version rather than a stale harness shim; acceptance lines may run `pnpm [-C dir] [--filter pkg] test|lint|format:check|typecheck` (and the same after `run`), as npm already could.\n

## 1.3.13

- Acceptance lines run for the report are final records: `enforcer evidence run` output is captured one record per line (`line`), listed last and never cut by the cap; the report hook skips a line that already has one instead of noting it as unfinished, and tells the worker to run the lines itself before reporting.

## 1.3.12

This release keeps the dispatcher alive through a graph 404 and makes stranded nodes visible in `enforcer dispatch status`.

- The dispatcher now retries a 404 for ten minutes (--api-grace) instead of exiting on the first one, and `enforcer dispatch status` names stranded nodes (lease lapsed, with how long), running nodes with no dispatcher, gates that hold a run and quiet workers apart from live workers (#273).

## 1.3.11

This release makes `governor verify` report every broken receipt and how many still chain.

- Governor verify now names every broken line, counts how many lines still chain and says whether the last line is the recorded head; a broken record still fails with exit code 1.

## 1.3.10

This release makes switching sign-ins reach the tool server: login revokes the replaced token and tells you how to reconnect.

- Login now revokes the previous access token when a sign-in replaces one, and prints the reconnect step (docs/KNOWN_ISSUES.md Switching sign-ins).

## 1.3.9

This release is the audit fixes: acceptance lines stay inside the checkout, credentials cannot be redirected by a repo file, compaction is redacted, human latches survive, and attend rings reliably.

- Dispatcher: attend rings for every new item (gates keyed by epoch, seen set pruned) and during holds, reuses the tick's frontier, reaps only verified orphans; acceptance timeouts kill the process group; session hook shares one deadline.
- Eviction keeps human-set latches, the organisation floor is served stale instead of expiring, shipOn and adviseModel read as booleans, and PostToolUse peeks one key.
- Acceptance allow-list: grep -R is no longer allowed (it followed symlinks out of the checkout), plan check refuses an unsafe data.repo, and the gh pr view shape runs with the operator's GH_TOKEN or skips.
- Compaction summaries are redacted before they are written to graph memory, a cached context pack is re-hashed on every 304, and the node-scoped fallback runs only on a 404 or 405.
- Hooks refuse a repo graph.json that names a foreign host or a non-ENFORCER_/GRAPH_ key variable; a failed worker token mint no longer falls back to the agent key, minted tokens are revoked on exit, workers get an empty ENFORCER_HOME, and *.log streams are redacted.

## 1.3.8

This release stops the governor storing raw tool-call history, so its state file stays small.

- The governor no longer records or keeps the per-agent raw tool-call history (recent).

## 1.3.7

This release stops the governor's state from growing with every session and lets the dispatcher cap a worker's context.

- enforcer dispatch run --autocompact auto|100000..1000000 (or ENFORCER_DISPATCH_AUTOCOMPACT) caps a claude worker's context; off by default, and the done line counts compactions.
- The governor state file stays small: idle agents are evicted after sweepDays, `recent` and `unmapped` are capped, and the scratch sweep also runs from PreToolUse once a day.

## 1.3.6

This release makes dispatched workers actually receive the context pack, and say why when they cannot.

- Dispatched workers get ENFORCER_BASE_URL and fetch the context pack from the graph's own route, and print one stderr line saying why when no pack is injected.

## 1.3.5

This release makes workers start with the graph's context pack and turns compactions into graph memory.

- Scout: documents the claude --autocompact flag and its measured cost (CONTEXT_BUDGET.md).
- enforcer dispatch run --attend rings (ATTENTION line, notify-send) when a review item or ready gate needs a person, stays up while waiting, and dispatch status shows needs you.
- Workers start with the graph's context pack (SessionStart), PreCompact writes graph-scoped summary observations, and dispatch gains --context on|off.

## 1.3.4

This release makes a gate a human decision: a person decides it with graph_decide, and a worker never claims or reports one.

- A gate is decided by a person with graph_decide, never claimed or reported by a worker: the governor classifies graph_decide as a write, and the report hook runs no acceptance line for a gate node.

## 1.3.3

This release makes the hooks cost far less per tool call: the pre-tool-use hook loads only what it needs, so the governor adds a few milliseconds instead of tens with decisioning off.

- The pre-tool-use hook is cheaper with decisioning off: the tenant lookup, shipper, HTTP client and attribution load lazily, and capability patterns compile straight to native code (`--no-regexp-tier-up`), so the shadow evaluation costs about 5 ms instead of about 23 ms; median overhead above bare node (`node enforcer/scripts/bench-hook.mjs`, before and after interleaved) went from 29-34 ms to 26-32 ms on a quiet machine and from 73-79 ms to 61-68 ms under load, with decisions and receipts unchanged (golden in enforcer/test/hook-latency.test.mjs).

## 1.3.2

This release makes acceptance evidence visible to the judge: pull request lines resolve and escaped literals match, and plan check flags lines that will not be run.

- Evidence runs resolve <n> to the node's pull request and match escaped literals (\t, \n, \\) in quoted output.
- enforcer plan check now prints a WARN with a specific hint for every acceptance line that will not be run, ends with a summary line, and exits 1 on skipped lines with --strict.

## 1.3.1

This release is security hardening from an independent audit: the governor fails closed when its config is unreadable, the organisation floor cannot be redirected away, and an environment variable can no longer silently turn rules off. Telemetry never exports prompts, and the dispatcher only runs allow-listed acceptance commands.

- Acceptance lines from a graph run only when they fully match a short shared allow list of read-only command shapes (src/acceptance-allowlist.mjs), without a shell, with a minimal environment and a temporary HOME, in evidence run, plan check, the report hook and the landing completion.
- A merge node lands only a pull request in its own data.repo (or --merge-allow) whose head is graph/<key of this graph>, the lander gets the worker env allowlist, orphan reaping verifies start time and launch nonce before killing, and node keys and repos are validated in worktreeFor, mcpConfigPath and preflight.
- Workers receive a minted worker token (not the agent key) when ENFORCER_WORKER_AGENT_ID is set; startup removes stale mcp configs and redacts old logs; the state dir is 0700; the env passes named CLAUDE and LC variables only.
- The whole repository is now licensed under FSL-1.1-ALv2 (root LICENSE, package licence fields, README section); the governor already was.
- Data minimization: `telemetry on` removes OTEL_LOG_USER_PROMPTS and OTEL_LOG_TOOL_DETAILS (status warns) and keeps the settings file mode; governor dirs are 0700 and files 0600; verify fails when receipts.jsonl is missing but state has a head; no health fetch without a credential; the report labels built-in rules by their code.
- Governor docs, collector config and receipt schema now match the code: localhost receivers, correct receipts path, no debug exporter, strict receipt schema.
- Governor: an environment `on` (ENFORCER_GOVERNOR_RULES, _BUDGET, _POLICY) always turns a check on, but an environment `off` is honored only when config.json sets the new `allowEnvOff` setting; an ignored `off` or an unrecognised value prints one stderr notice per process and shows in `governor status` and `governor config`.
- Governor fails closed on an unreadable or garbage config.json (capability rules stay on, one stderr notice), keeps the organisation floor cache at a fixed per-user path that GOVERNOR_HOME and ENFORCER_CONFIG_HOME cannot redirect, keeps the last floor on an ENFORCER_API_KEY change until a refresh succeeds, and asks before chmod, mv, rm or ln against the governor directory (rule governor.home).
- A boolean setting reads one way everywhere (true/on/yes/1 and false/off/no/0, any case), so governor status cannot disagree with the gate; an organisation floor sent as a string is honored; an unrecognised value is ignored with a notice.

## 1.3.0

The governor now reports first: decisioning (capability rules, spend and rate checks, tenant policy) is off by default and only on when configured. This release also adds a linter, formatter and type check to the test run, and improves doctor and the Grok install.

- dispatch --agent now gives workers the agent key as ENFORCER_API_KEY too, so claims made through the MCP tools are attributed to the agent and not to the operator's saved sign-in.
- dispatch --agent now gives each claude worker its own MCP connection (a 0600 per-run config with the agent key, launched with --strict-mcp-config), so a stored /mcp sign-in can no longer make claims as the operator; the key is redacted from worker logs and the file is removed when the worker exits.
- enforcer dispatch run takes --worker-rules on|off (default off) and tells you which mode workers run in.
- enforcer doctor reports hook commands whose script path is missing and a Grok runtime older than the plugin.
- doctor: the dead-hook path test compares native paths so the Windows CI job passes.
- enforcer doctor lists project-scope plugin installs whose directory no longer exists (report only).
- doctor builds hook script paths with the native separator, so the dead-hook check passes on Windows (it merged red in #204).
- The governor reports first: a fresh install has decisioning off (budgetOn, rulesOn and policyOn default to false), still writes a receipt for every call (allow, code checks_off), and an organisation's on still wins.
- ENFORCER_GOVERNOR_RULES, ENFORCER_GOVERNOR_BUDGET and ENFORCER_GOVERNOR_POLICY (`on` or `off`) turn a governor check on or off for one process tree over config.json, under any organisation floor; `governor config` marks them with `~` and `governor status` names them.
- The governor README now leads with reporting (status, report, receipts, OpenTelemetry) and documents decisioning as opt-in.
- The governor receipt line format is now a written, tested contract (otel/receipt.schema.json) for the OpenTelemetry collector.
- The governor no longer does loop detection (jev-hooks owns it): loopOn, loopLimit and loopWindow are retired settings and identical repeated tool calls are allowed.
- Add `enforcer governor report [--since 24h|7d|30d] [--json]`: offline summary of spend, tools, errors and decisions from local cost files and receipts.
- The governor's settings can be changed with enforcer governor set, enable, disable and telemetry, and /enforcer:governor.
- The governor records what its capability rules would have decided (`would` on each receipt) while decisioning is off, under the new `shadow` setting (on by default); it never blocks, asks the tenant policy or reads spend.
- `enforcer governor status` now opens with a Decisioning: ON or OFF line, repeated once in the session-start notice.
- `enforcer harness install grok` takes --graph-only, --no-hooks, --no-agent and --skills, records them in its manifest, and a plain reinstall reuses them.
- Add Biome as the linter and formatter (npm run lint, npm run format:check), run as suites of npm test, and format the tree once.
- Login presets now ask only for scopes the server offers (plan uses graph-graph-templates.write) and `--for agents` covers agent and key creation.
- `login status` lists the granted scopes, which capability families they cover, and the exact `enforcer login --for ...` command for each missing one.
- `enforcer event <name> [--graph-only]` is now the one hook command for Claude Code and Grok; `enforcer hook` stays as an alias of `--graph-only`.
- Add a real claude -p worker end to end test (skipped without ENFORCER_REAL_CLAUDE=1 and ANTHROPIC_API_KEY) with a shared stub graph server.
- `npm run bump <version>` now folds changes/*.md into a new CHANGELOG.md section and deletes them, and `node scripts/release.mjs notes <version>` prints that section (release-fold-fragments).
- Every read of the API base URL now goes through src/config.mjs, and a test keeps it so.
- The hand-written plugin source (src, lib/governor, lib/graph, hooks) is now type-checked in the test run (tsc checkJs baseline).

## 1.2.0

Dispatched workers can run on their own agent credential instead of your browser sign-in, run the code under test rather than the installed release, and report evidence that survives the hook's time limit. The report hook no longer loses evidence to NUL bytes or timeouts, long commands keep their lease, and the nightly smoke now actually runs.

- `enforcer dispatch --agent <name>` runs workers on a Tier 2 agent credential (key from the OS keychain or ENFORCER_AGENT_KEY); preflight prints the identity and refuses a browser sign-in for a plan over 2 hours without --allow-browser-signin (dispatch-agent-credential).
- `enforcer dispatch` launches each worker with `--plugin-dir` for its own checkout and a per-launch `--settings` that disables `enforcer@instruxi` for that child; preflight reports the plugin root and version workers will run; DISPATCHER.md documents the channel (worker-plugin-dir-override).
- Decision (2026-10-07): option B. Workers run the code under test, the dispatcher's checkout, not the installed release. Rejected: A (a prerelease marketplace channel: a second release train to maintain) and C (a patch release per governor change: tried this week, still lagged by the install step).
- `enforcer dispatch prune [--yes]` returns: removes worktrees whose PR merged and no live worker holds (dry run without --yes), also when the remote branch is already deleted (dispatch-prune-command).
- The dispatcher re-reads the node's current status and the latest run's verdict (polling while pending) after a worker exits, so a verified attempt is never logged FAILED and a done node is never left for a person (dispatcher-verdict-misreport).
- A succeeded graph_report now runs the node's acceptance commands (read-only allow-list, 120 s each, isolated env) and prepends their output to the evidence, failing first, so a true criterion is not rejected for a missing `ls` (report-attaches-acceptance-evidence).
- The report hook runs a node's acceptance lines within a 15 s budget (8 s per line, cheap read-only lines first) so it never overruns the PreToolUse timeout and drops the evidence it was attaching.
- An acceptance line the report hook's budget cuts short is attached as a note, not as a failed command record, so the judge reads the worker's own run of it instead.
- The report hook strips NUL bytes from the report and evidence, which the server cannot store and which made it refuse whole reports with 500.
- Long tool calls no longer lose the lease: PreToolUse on Bash starts a detached ticker that heartbeats every lease/3 until the call ends, the session ends, or a heartbeat answers anything but ok.
- A refused OAuth refresh is retried once, a refresh lock held by a dead pid is reclaimed, `login status` names the sign-in age and when it stops refreshing, and SessionStart and dispatch preflight say "sign in again" instead of blocking silently.
- A fresh install now creates the state dir 0700 regardless of umask, so `enforcer doctor` passes its own state-dir check.
- The last two hand-written API calls (MCP health in the version check, acceptance lint in plan check) go through the shared API client; the spec lock is refreshed so the lint endpoint is in graph.d.ts.
- The nightly smoke runs on a GitHub-hosted runner against the latest Claude Code CLI, with no credentials, instead of a self-hosted runner that never existed.
- Windows suites pass: tar gets --force-local for drive paths, Grok hook JSON is serialised not templated, tests use fileURLToPath and path-agnostic comparisons, and the win32 quarantine entries are gone (windows-suite-portability).
- test: heartbeat ticker tests no longer race the spawned ticker over the run file (macOS flake)

## 1.1.0

One runtime (the Python graph code is gone), generated API clients, a contract test against the server spec, and operations tooling.

- Supply chain: jev-hooks marketplace entry pinned by sha, workflow actions sha-pinned, Dependabot for actions and npm, `npm run sbom` (CycloneDX), ruleset check in the release checklist.

- enforcer-governor catalog entry is now an inert alias stub (aliases/enforcer-governor), so it no longer double-fires beside enforcer.

- - One shared Node API client (lib/api/client.mjs): timeouts, retry with jitter and Retry-After, X-Graph-Client/X-Request-Id on every call, typed ApiError; all Node callers routed through it.
- - Generated TypeScript types and openapi-fetch clients under lib/api from the pinned specs (npm run gen:api), with a staleness test and tsc in npm test.
- - The MCP tool manifest lives in the spec lock: check-allowlist reads it (with a per-profile view), the vendored fixture and the soft MCP_MANIFEST_TOKEN step are gone, and tool-result shape tests cover graph_next_work and graph_heartbeat.
- - Spec lock: pinned OpenAPI specs and the MCP manifest for every server the plugin calls, with a sync script and a test that fails on drift (#135).
- A checked-in manifest of every API call the plugin makes (test/contract/used.json, from scripts/extract-api-usage.mjs) and a contract test of it against the pinned specs on every run and against the deployed and main specs nightly (contract-nightly); the two audit drifts are recorded as known drift.
- CI runs on Ubuntu, macOS and Windows with a per-suite runner (skips with reasons, quarantine list, JUnit), p95 timing helper, and a nightly real-harness smoke job.
- - One config resolver (src/config.mjs, docs/CONFIG.md): base URL precedence flag > ENFORCER_BASE_URL > saved sign-in > default across hooks, login, doctor and the dispatcher; named errors for malformed env vars; docs/SELF_HOSTED.md recipe.
- - One run id joins the worker run, its PR, the judge's evidence and the governor receipts: X-Enforcer-Run on API calls, GRAPH_RUN_ID in worker env, graph_id on receipts, run_id on evidence items and hook log lines, and an Enforcer-Run footer on PR bodies.
- - Exit code 6's failed/denied list is recomputed from current graph status (failed or needs_review), not the session's denial memory; exit 0 when none remain.
- - `graph-dispatch prune` now removes a merged node's worktree even after the lander deleted its remote branch (PR found by head sha) and lists every directory with a classification instead of skipping silently.
- - The dispatcher logs JSONL (ts, level, event, key, run, fields) to dispatcher.jsonl beside the human dispatcher.log; worker streams are 0600, redacted on exit, and pruned on start past 14 days or 2 GB.
- Docs truth pass 2: graph README, WORKER_BRIEF, CANONICAL_RELEASE and README alias table match the current layout (lib/graph, src/graph, `enforcer event`, no plugin dependency); test/docs-truth.test.mjs guards removed paths and versions.
- - One error mapping (src/errors.mjs) from server machine codes to user and model messages: each code is announced once per session and logged locally, and the server's warnings[] (hooks_inactive, client_outdated) are surfaced once.
- Added `enforcer evidence run <graph>:<node>`: runs a node's acceptance lines (Go test flags, placeholders, cd prefix, one retry on collision, PR lines skipped) and prints evidence items; the dispatcher's landing completion, plan check and the graph skill use it.
- - test: the governor-denial dispatcher test no longer shadows the module it tests.
- - Governor: the headless-worker rules are one named profile (`lib/governor/profiles/headless-worker.mjs`: allow, deny, loop, spend, untrusted framing) that `core/worker.mjs` evaluates; the dispatcher sets `ENFORCER_PROFILE=headless-worker`; one adversarial test replays the 2026-10-06 incidents and the injection fixtures.
- - Governor: a headless worker may delete a tree inside its own worktree (`rm -rf dist`); deletes outside it, of the worktree itself or of .git keep the ask.
- - Governor: graph_heartbeat and graph_plan_status no longer count toward the loop detector; the dispatcher no longer treats a governor-issued denial of a graph tool as the harness refusing headless work (#148).
- ENFORCER_DEBUG=1 appends one JSON line per hook run to hooks.log.jsonl (rotated at 10 MB, two generations, 0600); the third failure of a hook in a session adds a one-line systemMessage naming the hook and the log (hook-debug-log).
- Design for a tenant-scoped hosted dispatcher (credential, sandbox, repo access, logs and metrics, container-safe lease, server API) in enforcer/docs/HOSTED_DISPATCHER.md; proposal only, for gate review.
- - Node text is untrusted: the worker prompt fences it as data, the headless governor profile denies edits to .github/, release/deploy scripts and secret files (release nodes excepted), headless tree deletes inside the worker's own worktree are allowed, and workers default to --max-budget-usd 5.
- - land-pr waits for every workflow run on the head sha to complete, not only the check runs already registered; #148 had merged with its test job still queued.
- - governor: loop-exempt.test.mjs runs under the isolating preload (fixes main CI after #148).
- Test temp dirs are realpath'd so the files, graph, dispatch/runtime and python capture suites pass on macOS, and their darwin quarantine entries are gone (macos-suite-portability).
- Added: enforcer plan check streams each result as it is known (running count on stderr), survives read-only temp trees (Go module cache), and takes --only <key> and --timeout <s>; the exit code reflects MISMATCH only.
- `enforcer plan check` posts each node's acceptance lines to the server lint and prints its warnings beside the local results (plan-check-uses-server-lint).
- - Plugin manifest conformance: validate-plugin test (six manifests agree, hooks.json loads in a real session, login passes arguments via stdin), `claude plugin validate` in CI, and /enforcer:login reads its arguments from stdin.
- - `enforcer dispatch status` prints each failed criterion of a review item with its probability and the threshold.
- - Dispatcher pure logic ported to Node (src/dispatch: select, model, summarize, triage, prune, stream) with the matching tests on node:test.
- - Dispatcher runtime ported to Node (src/dispatch: api, lease, worktree, launch, run): process-group kill, signal drain, pids.json orphan reaping, usage-limit and CI holds; `enforcer dispatch` runs it (not on Windows).
- - Salvage, remediation, triage gate and landing completion ported to Node (src/dispatch: salvage, remediate, land-complete): PR reuse, auto-link neutralising, lander heartbeats, acceptance output as landing evidence, no launch mid-landing.
- - Port the evidence store (locked O_APPEND append, 50 MB cap, sweep, failing-first select, merge) to src/graph/evidence.mjs, byte-identical to the Python jsonl, with a differential test.
- - Run attach_evidence (evidence gate, gh PR resolution, enforcer-files upload, client attestation, usage) in-process in Node (src/graph/hooks/attach.mjs); the PreToolUse graph hook no longer needs python3.
- - Run track_run, heartbeat and capture_evidence in-process in Node (src/graph/hooks/*), so a graph-live PostToolUse spawns no python3; differential test against the Python handlers.
- Port of four hooks: session.mjs/version-check.mjs; python3 probe and hooks=off:python3 removed from bin/enforcer and src/event.mjs; doctor and preflight drop the python3 and fcntl checks (port-hooks-session).
- - land-pr is now Node (`enforcer land <pr>`, src/land.mjs); bin/land-pr.sh is a two-line shim to it, same exit codes.
- test/run.sh's 116 checks became node:test against a Node stub graph server (test/graph/run.test.mjs); npm test runs every suite and writes test-results/junit.xml; privateDir no longer spins on an unwritable /proc path.
- - Port lib.py state, run file, HTTP and redaction to src/graph (state, run, http, redact, clip) with node:test ports and a Python/Node redaction corpus test.
- - OAuth refresh retries once on timeout/5xx and keeps the current token until its real expiry; only invalid_grant/400/401 signs out, and the reason is recorded in oauth.last_refresh_error.
- - CI release gate accepts a `changes/<slug>.md` fragment instead of a version bump on PRs that touch enforcer/, so parallel fix PRs do not conflict on CHANGELOG.md.
- Removed the Python runtime (lib/graph, bin/graph-dispatch, python tests and checks); skill checks and credential-format test now run in Node, docs updated.
- - `enforcer doctor --bundle` writes a redacted tar.gz under the state dir (versions, config sources, credential metadata, doctor, log tails, receipts verify, outbox error, worker streams) and prints its path and size.
- The test script is now `node scripts/test.mjs`, which discovers every `*.test.mjs` under enforcer/test and lib/governor/test and runs each in its own process under the isolating preload with a per-suite timeout, so a new suite no longer edits a shared package.json line.
- - `enforcer uninstall [--purge]` removes the OTEL entries, headers shim, plugin-root and the Grok and Codex installs by manifest; state files carry schema_version and an older plugin refuses newer state; Codex install writes a manifest like Grok's.
- Doctor prints the Windows support position on win32 and README and graph docs state it: MCP, files and governor supported, graph hooks after the port, dispatcher POSIX only (windows-support-statement).
- - Dispatched workers now get an allowlisted environment (no operator keys) and a worker-scoped graph token minted per run via the agent credential route; gh gets only ENFORCER_WORKER_GH_TOKEN as GH_TOKEN.

## 1.0.5

Governor gate:
- Governor hooks fail closed (#76); default rules tokenise, strip wrappers, strictest wins (#81); settings guard denies anything but a plain read (#86).
- Headless worker denies unrecognised delivery shapes (#71); CLAUDE_PLUGIN_ROOT exported to workers (#91).
- Aliases become empty stubs, kit defaults off, README fixes (#74).

Evidence:
- Secrets redacted at capture time (#72); state, evidence and run files 0600 in 0700 dirs (#77).
- Evidence gate keyed by actor so subagents are captured (#70); failing commands captured (#80).

Other:
- CLI main guard works from any install path (#69); login logout revokes refresh token (#92); heartbeat by elapsed time (#89); `enforcer doctor` (#88); Codex marketplace shape and harness (#93).

## 1.0.4

- The governor announces itself: SessionStart (Claude, Codex, Grok shims and `bin/enforcer hook session-start`) sets `ENFORCER_GOVERNOR=1`.

## 1.0.3

- Governor: the secrets rule asks about credential-file access, not mentions (#64).

## 1.0.2

- graph-dispatch passes each plugin name once to a worker (#63); per-repo start-from base, missing base refused (#62).

## 1.0.1

- graph-dispatch: the worker agent is `enforcer:graph-worker` since the fold-in (#61); presets request `enforcer:workspace.write`, a 403 on switch names the scope and the re-login line (#60).

## 1.0.0 — enforcer

One plugin, `enforcer`, as an Agent Plugins 1.0 package that installs in Claude Code, Codex CLI and Grok Build. Claude Code stays the reference harness.

### Folded in
- **enforcer-governor**: the policy gate and tamper-evident decision records, history kept, wired into `enforcer`.
- **enforcer-graph**: the graph worker hooks (self-gating behind `bin/enforcer hook <event>`), skill, agent and dispatcher.
- **enforcer-files**: the files skill, `files.mjs`, upload and download commands.
- **State** moved to `~/.config/enforcer/` with first-run migration; no `~/.claude` path outside `hooks/claude/`.

### Adapters
- **Claude Code**: `.claude-plugin/plugin.json` fallback and hook shims in `hooks/claude/`.
- **Codex CLI**: `extensions.com.openai` overlay, `.agents/plugins/marketplace.json`, shims tested on Codex-shaped stdin.
- **Grok Build**: `harness/grok` hooks, `config.toml.snippet` MCP section, agent, `enforcer harness install grok` (experimental), hook fixtures captured from a grok 1.0.41 run.
- **MCP**: remote OAuth path proven without a shim; Codex and Grok MCP snippets.
- **Dispatcher**: `graph-dispatch --harness claude|codex|grok`. Claude and Grok parsers are tested on fixtures from real runs; Grok is experimental (`--experimental`); the Codex parser is a stub until a real `codex exec --json` sample exists.

### Deprecated aliases
`enforcer-graph`, `enforcer-files` and `enforcer-governor` are marketplace aliases for one release. Install `enforcer` instead: `claude plugin install enforcer@instruxi`.

### Related
`jev-hooks` 1.0.0 now depends on `enforcer` and contains no allow/deny policy.
