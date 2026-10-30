# Dispatcher flag reference

Moved from README.md. For the one-command front door see "Dispatch a plan" there.

## enforcer dispatch: keep N workers busy, with no model in the loop

```bash
GRAPH_AUTH_HELPER='node ~/.claude/plugins/cache/instruxi/enforcer/0.4.0/bin/enforcer-headers.mjs' \
  enforcer dispatch run --graph <id> [--workers 3] [--repo-root ~/apps] [--dry-run]
```

A Node loop (`src/dispatch/run.mjs`, no dependencies) that reads the frontier every `--interval` seconds
and, for each ready node, up to `--workers` at once:

- **One dispatcher per graph.** The running dispatcher holds a lease,
  `data.dispatcher {owner, host, pid, until}` on the graph's `dispatcher-lease`
  node, renewed each pass. A second dispatcher on the same graph exits (3)
  with a message unless `--takeover`. Graph and GitHub calls retry transient
  network errors (DNS blips, resets, 429/502/503/504) with backoff, 4 tries, and
  a pass that still fails is skipped, never fatal. A failed node is triaged only
  once its last run ended `--triage-grace` minutes ago (default 10) and it is
  still failed when the triage launches. Worker pids are recorded in
  `<state-dir>/pids.json`.
- **Agent nodes** (`--types`, default `task,bug,chore,merge,scout,milestone,ops`; `release`
  and `gate` stay with a person): a git worktree of `data.repo` at
  `<repo-root>/<repo>-<key>` on `graph/<key>` (off `data.base` or origin's
  default branch; reused on a re-claim; a scratch dir when the node has no
  repo), then `claude -p` with `--agent enforcer:graph-worker`, `--model`,
  `--plugin-dir` for this plugin AND the cached `enforcer` plugin (so the hooks
  and the MCP server load whatever `enabledPlugins` says; an inline plugin
  replaces an installed copy of the same name), `--allowedTools` naming the five
  graph tools under all three prefixes, `--permission-prompts none` (anything
  that would prompt is denied, so a worker never hangs), `--output-format
  stream-json --verbose` to `<state>/logs/<key>.<attempt>.jsonl`, and
  `GRAPH_ID` in its environment. The worker claims, heartbeats and reports
  itself, so its own hooks capture its evidence.
- **Model**: `data.model` (or the claim card's `model`) wins; a tier set by a
  person (`tier_source: user`) beats `--model`; otherwise `--model` caps it;
  otherwise `mechanical`/`standard` -> sonnet, `deep` -> opus, default sonnet.
  `enforcer dispatch` passes `--model` only when you give it.
- **Routes**: a route table (`--routes FILE`, `ENFORCER_ROUTES`, the graph's
  `node_defaults.routes`, `<config home>/dispatch/routes.json`; `--no-routes`
  ignores them) gives each tier a harness, model and optional endpoint, probed
  at `/v1/models` (cached `--route-probe-ttl` seconds, default 60) with a
  per-route fallback. A bad table exits 5 at startup. See ROUTES.md.
- **Turn cap**: `data.max_turns`, when set, is passed as `claude --max-turns`
  (accepted and enforced by Claude Code 2.1.288 though not in `--help`; the run
  ends `error_max_turns`). The dispatcher also counts assistant turns in the
  stream and stops a worker past `--max-turns` (150) or `data.max_turns`,
  whichever is larger; `--max-budget-usd` is passed through. A worker that
  claimed and exited without reporting has its run failed with the log path,
  so the node is claimable at once rather than after its lease.
- **Warm workers**: every launch names its session (`--session-id`). A worker
  that reports its node cleanly leaves its session warm for its
  `(data.repo, model)`; the next node there resumes it (`--resume <id>`, which
  finds the session from any cwd, so the new worktree is fine) with a "NEW
  NODE" prompt, and such nodes are scheduled first. The launch line says
  `mode=cold` or `mode=resume`; the done line carries `cache_read`,
  `cache_creation` and `output` tokens from the result event. A resume that
  does not start (no init event, e.g. `No conversation found with session ID`)
  is logged and the node is started cold at once, spending no attempt. A
  session is retired after `--warm-max-nodes` (5) nodes or `--warm-max-age`
  (120) minutes from its first launch; `--no-warm` starts everything cold.
  Each plugin directory is passed once (`--plugin-dir`, deduplicated by path).
- **Merge nodes** naming a PR (`data.pr`: a number, URL or `owner/repo#N`; or
  `data.branch`) get no agent and no slot: the dispatcher claims the run, runs
  `bin/land-pr.sh`, heartbeats while it waits, and completes the run with
  land-pr's verbatim output as `{kind: command, cmd, exit, output}` evidence:
  exit 0 succeeded, 2/3/4/5 failed with that output. One land per repo at a time.
- **Contested resources**: never two workers, ours or a live run elsewhere, on
  one `data.resources` value. A lapsed lease frees its resources and its node
  is re-dispatched (the server lists it as `looking_for_work`).
- **Drain**: `touch <state>/STOP` (default state `~/.config/enforcer/dispatch/<graph>`):
  no new launches, running workers finish, exit 0. `--max-attempts` (2) bounds
  launches per node per session.
- **Waits on verdicts.** A node in `verifying` (tenant gate: judges voting, or
  an escalation waiting for a person) holds its dependents back. While one
  exists and unfinished work remains, the dispatcher keeps polling at
  `--interval` instead of exiting "nothing runnable", and logs
  `waiting on verdict for <keys>` once per 10 minutes. It exits only when
  nothing is runnable, running or verifying. `--exit-when-idle` restores the
  old exit.
- **Auth**: `GRAPH_AUTH_HELPER` (any command printing JSON headers; default the
  newest cached `enforcer-headers.mjs`) or `GRAPH_API_KEY`; base
  `GRAPH_BASE_URL`. Process exit code, by value:
  - 0 everything done, or drained by the stop file;
  - 1 auth failure, API error at startup, or 404 (wrong workspace or graph id);
  - 2 blocked (below);
  - 3 another dispatcher holds the graph lease (or it was lost);
  - 4 harness usage limit with `--on-limit exit`;
  - 5 usage error (bad arguments);
  - 6 finished, but failed or denied nodes remain.
  A stale stop file is removed at startup; `pids.json` is written atomically and removed on exit.
  Each worker gets a launch nonce (`ENFORCER_LAUNCH_NONCE`) in its environment; `pids.json` records it with the
  worker's start time. At startup an orphan from a dead dispatcher is killed only when both still match, so a stale
  file naming a reused pid (a login shell, a tmux session) kills nothing; a pid that cannot be verified is left
  running and logged. After a worker's group is killed, any process still carrying its nonce (one that left the
  group with `setsid`) is killed too, where `/proc` exists (Linux); on macOS and Windows such a process survives.
- **Merge nodes land only this graph's pull requests.** Before claiming, the dispatcher reads the PR with
  `gh pr view` and refuses (`REFUSE <key>: will not land ...`) unless it is in the node's `data.repo` (or a repo
  named with `--merge-allow owner/repo`, repeatable, or `--merge-allow-file <path>`, one per line), its head is a
  branch of that repo (not a fork), and the head is `graph/<key>` for the merge node's key or another key in this
  graph. The lander runs with the worker environment allowlist, not the dispatcher's full environment.
- Node keys and `data.repo` are validated (`^[A-Za-z0-9._-]+$`, not `.` or `..`) by every function that turns them
  into a path (`worktreeFor`, the agent MCP config path, preflight's repo check), not only by the launcher.

### Headless workers: the graph tools are refused in `claude -p` (2026-10-02)

The hosted MCP server marks every write tool, the work loop included,
`_meta["anthropic/requiresUserInteraction"]` (enforcer-v3-mcp `src/tools.ts`,
`toolDefs`). Claude Code 2.1.287 refuses such a tool in `claude -p` **whatever
the allowlist says**: `--allowedTools`, `permissions.allow` in `--settings`,
`--permission-mode dontAsk` and `bypassPermissions` all end in
`MCPTool requires permission.`, and a `--permission-prompt-tool` is refused
with `MCP tool requires user interaction; not supported via
--permission-prompt-tool`. An MCP write tool WITHOUT that flag runs headless
when it is in `--allowedTools`, and is denied when it is not. So headless
workers need the server to drop the flag for `graph_next_work`,
`graph_heartbeat`, `graph_report` and `graph_remember` (the allowlist then
gates them as it does any MCP tool). Until it does, the dispatcher sees the
first denied graph tool, says `BLOCKED`, launches nothing more and exits 2
once the running workers finish. Merge nodes are unaffected (no MCP).

The MCP server can also come up `needs-auth` in a fresh `claude -p` (seen
intermittently on 2026-10-02). Such a worker never reaches the graph; it does
not spend an attempt, and three in a row stop the dispatcher.

## What a denial means to the dispatcher

The dispatcher reads the governor's decision records (from the governor log and the worker's stream-json denials) and branches on the machine `code`, not on log text:

| code | dispatcher action |
|---|---|
| `push_needs_approval_surface` | salvage: push, open the PR and land it, as the worker could not |
| `destructive_*` | never salvaged; the node goes to triage |
| `graph_run_not_open` | remediation launch, with the code in the prompt |
| any other deny/ask code | logged; neither salvaged nor relaunched |

When several codes are present the order is destructive, then `graph_run_not_open`, then the push. Only when a worker left no record (an older plugin or governor) does the dispatcher fall back to the old text match on the denial message.

The governor has no loop check, so a worker that heartbeats or polls plan status while it waits on CI is never stopped for repeating itself. Loop detection belongs to the `jev-hooks` plugin.

Salvage runs only for a node whose claim card carries the `deliver-via-github-pr` skill. The card's `skills` entries are the api's attached-skill rows, `{"position", "config", "skill": {"slug", ...}}` — the slug is nested under `skill` (0.27.1; before it the dispatcher read only a flat `slug`/`key`/`name`, saw no skill on any node, and skipped every salvage).

Salvage opens the PR against the node's resolved base (see below, as the worktree step does), counting commits ahead of `origin/<base>` and passing the base to the PR create step.

### The start-from ref per repo (`bases`, `repo-bases.json`)

A repo may not work off origin's default branch (`enforcer-v3-portal` works off `staging`). The dispatcher resolves a node's base in this order and never guesses past it:

1. the node's `data.base`;
2. the graph's `node_defaults.bases`, e.g. `{"bases": {"enforcer-v3-portal": "staging"}}` (keyed by `data.repo`);
3. the registry `~/.config/enforcer/dispatch/repo-bases.json` (or `$ENFORCER_CONFIG_HOME/dispatch/repo-bases.json`, or `--repo-bases FILE`), e.g. `{"enforcer-v3-portal": "staging"}`;
4. origin's default branch (`origin/HEAD`).

The worktree, the commits-ahead count and the PR base all use the resolved base, and the launch line logs `base=<ref>`. A declared base (steps 1 to 3) that does not exist on origin is refused with `refuse <key>: base origin/<b> (from <source>) does not exist on origin`; the node is not launched.

### Branch, worktree name and concurrency

- The worker checks out the claim card's `branch` (`node.branch`, or `data.branch`) when it is a safe ref; otherwise `graph/<key>`.
- The worktree directory is `<repo>-<plan code>-<node key>` under the repo root; the plan code is the graph id's first 8 characters, so two graphs with the same node key never share a directory.
- `git worktree add` and branch creation in one repo run under a lock file (`graph-dispatch-worktree.lock` in the repo's git dir), so several dispatchers can share a repo. A lock older than 120 s is taken over. A stale branch with no commits ahead of its base is recreated, not fatal.

### Flags the server sets

- **needs_person**: when a node's attempts are spent ("left for a person"), the dispatcher completes the run `failed` with `data.needs_person: true` and the reason in `data.reason` (best effort: a run the worker already closed may refuse it).
- **over_cap**: a heartbeat answer or claim card carrying `over_cap` stops that worker cleanly (logged `over cap: <key>`), spends no attempt, and the node is not relaunched this session.
- **Rejudge**: a verdict that a server rejudge (`rejudged`) flipped to verified is accepted: no relaunch.
- **Warm retry**: a remediation launch of a claude node whose previous session reported cleanly resumes it (`--resume <session>`, logged `mode=warm --resume`) instead of starting cold.

### Pruning worktrees safely

The pruning logic (`src/dispatch/prune.mjs`; the old `graph-dispatch prune` command went with the Python dispatcher and has no CLI front end yet) looks at every `<repo>-<plan code>-<key>` (or older `<repo>-<key>`) worktree (branch `graph/<key>`) under the repo root. It removes one only when (a) its tree is clean and (b) its branch head is an ancestor of origin's default branch (or the repo's registered base), or its PR is MERGED (`gh`). Everything else is kept and listed under `Review N branches` with the reason: `uncommitted changes`, `unmerged commits` or `open PR`. Without `--yes` it is a dry run and prints `would remove ...`.

### Per-repo worktree setup (`.worktreeinclude`, `.worktreeshare`)

A fresh worktree has no `.env` and no `node_modules`. When the dispatcher creates or reuses a worktree it reads two optional files at the root of the main checkout (`<repo-root>/<data.repo>/`), applies them and logs `worktree-setup <key>: copied N, linked M` (with a `; skip <path> (reason)` note for each entry it passed over). Both files list one path per line; blank lines and `#` comments are ignored.

- `.worktreeinclude`: files to COPY from the main checkout, e.g. `.env`, `.vscode/settings.json`. Only existing, gitignored files inside the repo are copied. A path git tracks is never copied (the worktree already has it), and a missing path is skipped.
- `.worktreeshare`: directories to SYMLINK from the main checkout, e.g. `node_modules`, `.cache`, or a sibling such as `../protos`. A sibling (`../x`) is linked only when the worktree sits beside the checkout.

An entry already present in the worktree is left alone, so a re-claimed node is not touched twice. `--dry-run` logs the counts without copying or linking.

## Which plugin workers run

Workers run the dispatcher's checkout; humans run the installed release. Each worker launch passes `--plugin-dir <this checkout>` and a per-launch `--settings '{"enabledPlugins":{"enforcer@instruxi":false}}'`, so the user-scope install is off for that child process only and exactly one copy of the hooks and MCP server runs. A governor fix merged to main reaches workers at the next dispatch, with no release. `enforcer dispatch` preflight prints a `worker-plugin` line with the root and version workers will run. Started through the `enforcer` PATH shim an older release wrote for Grok and Codex (removed by `enforcer harness uninstall <grok|codex>`), the command runs a runtime copy under `~/.config/enforcer/<harness>/` that Claude Code cannot load as `enforcer`; `enforcer dispatch` then hands off to the installed Claude Code plugin's own `bin/enforcer` and says so on stderr, and with no Claude Code plugin installed the `worker-plugin` line fails. The governor hooks are never disabled: the checkout supplies them. If a Claude Code version ignores the settings override for plugins, the child loads both copies; `CLAUDE_PLUGIN_ROOT` still points at the checkout.

## Gemini workers (`--harness gemini`, experimental)

`--harness gemini --experimental` launches `gemini -p <prompt> -o stream-json --approval-mode yolo [-m <model>]` (Gemini CLI 0.38; `GEMINI_BIN` or `args.gemini` overrides the binary). `-m` is passed only for a model starting `gemini` or `auto`. The NDJSON stream (`init`, `message` deltas, `tool_use`, `tool_result`, `result{stats}`) is read by `geminiEvents` in `src/dispatch/stream.mjs`, written from the recorded run in `test/fixtures/gemini-stream.jsonl`: a run of assistant deltas is one turn, each `tool_use` one more, and `run_shell_command` is reported as `Bash`. Usage comes from `result.stats` (`input_tokens`, `output_tokens`, `cached`).

The graph MCP server is wired with `enforcer harness install gemini`, which prints `gemini mcp add --scope user --transport http --trust enforcer "$ENFORCER_BASE_URL/mcp" -H "X-API-Key: $ENFORCER_API_KEY"` (there is no runtime copy to migrate). The gaps:

- **No hooks.** Gemini cannot load the plugin's Claude Code hooks, so a gemini worker gets no governor checks (path denials, piped-installer refusal), no evidence capture, no automatic heartbeat every 10th call and no report gating. Its evidence must be passed in `graph_report` by hand, and the judge sees only that.
- **No per-launch MCP config.** `--mcp-config`/`--strict-mcp-config` and `--agent` credentials have no gemini equivalent: the worker uses the user-scope `enforcer` server and that key.
- **No `--max-turns`, `--max-budget-usd`, `--allowedTools`, session resume or `--name`.** The dispatcher still counts turns from the stream and stops a worker past the cap; `--approval-mode yolo` approves every tool.
- **Auth is the user's.** The CLI needs a working sign-in (`GEMINI_API_KEY` in `~/.gemini/.env` with `selectedType: gemini-api-key`, or Vertex AI); the personal Code Assist OAuth tier is refused by Google (`IneligibleTierError`).

## Worker rules (`--worker-rules on|off`)

`enforcer dispatch run <graph> --worker-rules on|off` sets `ENFORCER_GOVERNOR_RULES` for every worker, which turns the governor's headless worker rules (push, pull request and land shapes, protected paths) on or off for that process tree without touching the machine-wide file. The default is `off`, because the governor reports data first and decisioning is on only when configured. The default lives in one constant, `DEFAULT_WORKER_RULES` in `src/dispatch/launch.mjs`. `on` always applies. `off` applies only when the user's own `config.json` sets `allowEnvOff: true` (`enforcer governor set allowEnvOff true`); without it the governor ignores the environment `off`, says so once per process on stderr, and the workers follow `config.json`. An organisation policy of `on` still beats `off`. Preflight prints a `worker-rules` line stating the mode, for example `workers run with the worker rules OFF (pass --worker-rules on to enforce them)`.

## Running workers on an agent credential (`--agent`)

`enforcer dispatch run <graph> --agent <name>` runs every worker on a Tier 2 agent credential (issued with `agent_credential_issue`) instead of your browser sign-in, which stops refreshing during long unattended plans. The key is read from `ENFORCER_AGENT_KEY`, else the OS keychain (macOS `security` service `enforcer-agent`, account `<name>`; Linux `secret-tool` with `service enforcer-agent account <name>`); it is never taken from argv. Workers receive it as their only credential (`GRAPH_API_KEY`), run with `ENFORCER_HOME` pointing at an empty per-run directory under the state dir (mode 0700, removed on exit) so the shared sign-in file is not visible to them, and `GOVERNOR_HOME` pointing at that agent's own governor record (`~/.config/enforcer/governor/agents/<id>`, mode 0700, kept across runs, your `config.json` copied in at each launch) so their receipts ship under the agent credential only and never mix with your own sessions' receipts, runs are attributed to the agent, and you are the steward. Preflight prints an `identity` line saying which identity workers will use. Without `--agent`, a plan estimated over 2 hours (30 minutes per unfinished node, or `data.estimate_minutes`, divided by `--workers`) is refused unless you pass `--allow-browser-signin`.

Claude Code prefers a stored `/mcp` OAuth sign-in for the plugin's MCP server over its header helper, so the environment alone cannot make that server speak as the agent. With `--agent`, each claude worker therefore gets its own MCP connection: the dispatcher writes `<state-dir>/mcp-<node-key>.json` (mode 0600) holding a server named `enforcer` with the agent key as its `X-API-Key` header, and launches the worker with `--mcp-config <file> --strict-mcp-config`, which leaves the stored sign-in and every other MCP server out. The key is never in argv, it is redacted from worker streams and `dispatcher.jsonl`, and the file is removed when the worker exits and on dispatcher shutdown. Without `--agent` nothing changes.

## Secret hygiene and what a worker can read

- The agent key stays in the dispatcher. When `ENFORCER_WORKER_AGENT_ID` is set, each worker gets a minted one-day token (scopes `graph:read`, `graph:write`) as `GRAPH_API_KEY` and `ENFORCER_API_KEY`, and in its MCP config. When it is not set, the agent key is the only credential there is and is passed to workers as before: the trust boundary is that a worker, its Bash tool and any test it runs can print it. Set the variable to avoid that.
- On start the dispatcher removes every stale `mcp-*.json`, redacts every existing `logs/*.jsonl`, and sets the state dir to 0700 and `pids.json` to 0600. Redaction also removes any bare `ag_` or `env3_` token.
- A worker's environment is an explicit list: `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`, `SHELL`, `USER`, `LOGNAME`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, the plugin and graph variables, and `GH_TOKEN` only from `ENFORCER_WORKER_GH_TOKEN`. No `CLAUDE_*` or `LC_*` prefix passes.
- A worker keeps the operator's `HOME`, so `gh`, `git` and `ssh` credentials there are reachable. A per-worker `HOME` was considered and not done: copying Claude's single-use refresh token into another `HOME` would sign the operator out.

A worker token that cannot be minted (`ENFORCER_WORKER_AGENT_ID` set) fails closed: the dispatcher logs `worker token mint failed: <status>`, does not launch the worker and retries on the next pass; it never falls back to the agent key. Minted tokens are deleted when the worker exits.
