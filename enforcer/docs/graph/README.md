# The graph worker in the enforcer plugin

A skill that teaches the claim / work / heartbeat / report loop, and hooks
that keep a session honest while it holds a node of a plan — including the two
that make the evidence in a report something the model did not author.

**No hook calls Jev, an LLM, or any model. No Jev key is needed.** Hooks are
plain HTTP to the graph API with the same credential the MCP server
uses: the Enforcer sign-in, or a key.
Judgment (verification, dedupe, contradiction) happens server-side, on the
tenant's opt-in, and reaches this plugin only as fields in the tool results.

## Install

One install. The graph worker is part of the `enforcer` plugin: there is no
separate plugin and no plugin dependency. Installing `enforcer` installs the
skill, the agent and the hooks:

```bash
claude plugin marketplace add instruxi-io/claude-plugins
claude plugin install enforcer@instruxi
```

Then, in Claude Code: `/enforcer:login`, then `/enforcer:setup` (shows the
allow rules for the worker loop and the plugin commands, applies only on your
yes).

**Existing installs:** the old `enforcer-graph`, `enforcer-files` and
`enforcer-governor` plugins are deprecated aliases now. Uninstall them, run
`claude plugin update enforcer@instruxi`, then `/reload-plugins`. The hooks
are loaded from `enforcer`'s own `hooks/hooks.json`; if `enforcer` is
disabled, no graph hook runs (`claude plugin enable enforcer@instruxi`).

### The client attestation

Every `graph_next_work`, `graph_heartbeat` and `graph_report` the model makes
is rewritten by the PreToolUse hook to carry
`client: "enforcer-graph-plugin/<version>; hooks=on"` (the version is read from
this plugin's manifest), and the hooks' own HTTP heartbeat sends the same string
as `X-Graph-Client`. The MCP server forwards the argument as that header and
the graph records it on the run; a run without it gets the `hooks_inactive`
warning. A `client` the model wrote is replaced, never trusted. In
`GRAPH_EVIDENCE_MODE=context` (a surface that does not apply rewrites) nothing
is stamped.

### The allowlist is checked against the server

`settings.example.json`, the graph-worker agent's `tools:`, `/enforcer:setup`'s
`allowed-tools` and the hook matchers are checked in CI against the MCP
server's published tool manifest (`node test/check-allowlist.mjs` at the repo
root), so a renamed tool fails the build instead of silently turning every
allow rule into a prompt. That one OAuth sign-in
is what the MCP server and these hooks both use (`~/.enforcer/credentials.json`,
refreshed by whichever reads it when the token is close to expiry). It grants the
work loop (claim, heartbeat, report, remember) and plan authoring (import,
templates, nodes, edges); deletes and sharing stay with a person.

From a checkout of this repo instead: `claude --plugin-dir ./enforcer`.

**CI and containers** can skip the sign-in and use a scoped key: set
`GRAPH_API_KEY` (or `ENFORCER_API_KEY`), and add the server with it:

```bash
claude mcp add --transport http enforcer-graph https://api.instruxi.dev/mcp \
  --header "X-API-Key: $GRAPH_API_KEY"
```

Portable skill install (any harness that reads SKILL.md):

```bash
npx skills add instruxi-io/claude-plugins --skill graph
```

## Configure

`.enforcer/graph.json` in the project (found by walking up from the cwd):

```json
{ "graph_id": "<uuid>" }
```

`base_url` defaults to the origin you signed in to; `api_key_env` names a key
variable if you use one. Environment overrides: `GRAPH_ID`, `GRAPH_BASE_URL`,
`GRAPH_API_KEY`. A key wins over the sign-in when both are present. With no
graph id, or no credential at all, every hook exits silently.

**Full command output beyond the clip** (optional). Evidence clips each
command's output to 4000 characters, keeping both ends. Set `files_base_url`
(env `GRAPH_FILES_BASE_URL`) to your enforcer-files base, including its
`/api/v1/files` prefix, for example `https://api.instruxi.dev/api/v1/files`.
The attach hook then uploads any longer output to **your** enforcer-files
storage under **your** credential, using the provider that
`GET /storage/provider` reports, and the evidence item carries `file` (the
file id) and `file_bytes`. The graph judges the clip as before and tells the
judge that the whole output is stored. It never downloads the file while it
judges. The uploads are ordinary files in your storage, named
`graph-evidence/<timestamp>-<id>.log`, and follow that service's retention
and visibility. If the setting is unset, no upload is attempted. If an upload
fails or runs past the hook's 10-second budget, the item stays as it was
(clipped, no file) and the report still goes through. The whole output is
kept in the capture file only when it is longer than the clip.

**Allow-list the five tools** or the loop is not autonomous: every graph write
tool carries `requiresUserInteraction`, so Claude Code asks before each
`graph_next_work` / `graph_report` / `graph_heartbeat` / `graph_remember`
unless they are allowed. The tool names depend on which server carries them
(`mcp__plugin_enforcer_enforcer__…` from the `enforcer` plugin, or
`mcp__enforcer-graph__…` for a key-based entry); the example lists both. Copy `settings.example.json` into
`.claude/settings.json` (project) or merge its `permissions.allow` list into
yours.

### A fact gets the recent record, not the whole run

`graph_remember` now goes through the same attach hook as `graph_report`, but
with a narrower window. Everything captured during a run supports the run's
report; only what just happened plausibly supports "the default lease is 300
seconds", so a fact carries the **most recent 3** records.

That heuristic is allowed to be rough because over-attaching is safe by
construction: the judge asks whether the record SHOWS the claim, so an
irrelevant record yields `asserted`, never a false `grounded`. Measured — a
false claim against a record that disproves it scored **0.01**. Attaching the
wrong thing costs a missed grounding, never a wrong one.

The server then classifies the fact: `grounded` (a record shows it),
`asserted` (checkable but nothing does — a lead, not a measurement),
`decision` (a choice or intention, never penalised for lacking evidence it
could not have). A contradiction where one side has a record says which to
believe.

### A claimed pull request is resolved, not trusted

A `pr` on `graph_report` was the one externally checkable claim that nothing
checked: a URL for a pull request that does not exist was stored and shown as a
result (measured against production with `.../pull/999999`). `gh` already holds
credentials the graph service does not and must not, so the attach hook resolves
the claim locally and records what `gh` says as evidence — a real title and
state, or the fact that it is not there.

It does not refuse: an unresolvable PR is itself a finding, and the judge should
see it. Measured live: a NOT FOUND record rejects the criterion at 0.02; a real
merged PR verifies at 0.95 **when the captured `gh pr create` command is in the
record too** — the resolved state alone shows a PR exists, not that it is for
this change. The two compose, because `gh pr create` is a Bash call the capture
hook already records.

Bounded and fails open: no `gh`, no network, a private repo or a timeout all
leave the report exactly as the model wrote it.

### Attended dispatch

With `--attend` (or `ENFORCER_DISPATCH_ATTEND=1`) the dispatcher tells you when it needs you and waits for your answer. On every pass it collects the open review items and the gates that are active with every prerequisite done, prints one `ATTENTION <kind> <key>: <why> (answer with: graphwatch attend <graph>, or graph_review / graph_decide)` line per new item (once per item, even across a restart; the seen set lives in the state dir) and calls `notify-send` when it is installed. When nothing is runnable but something needs you it does not exit: it polls every 15 seconds, logs `waiting on you: N item(s)` at most every 10 minutes, and launches as soon as a node becomes runnable. `enforcer dispatch status` shows `needs you: N`. Without the flag nothing changes.

## The graph-worker agent

`agents/graph-worker.md` is the worker protocol as a plugin subagent
(`enforcer:graph-worker`). Hand it a graph id, a node id or key, and
optionally a brief in its prompt; it claims that node with `graph_next_work`
(`node` parameter, MCP 0.9.5+), heartbeats, does the work, lands its own PR with
`bin/land-pr.sh` and reports with captured evidence. It never claims, heartbeats
or reports through `enforcer_api_write`, which bypasses every hook and asks a
human to confirm each call. On a server without the `node` parameter it falls
back to a plain `graph_next_work` and works whatever node it gets.

Frontmatter: `model: sonnet` (a coordinator overrides it per node tier through
the Agent tool's `model`), a `tools` allowlist naming the graph tools under all
three server prefixes, and `maxTurns: 150`. Claude Code supports `maxTurns` for
plugin agents (the output is marked partial when the cap is hit). Plugin agents
ignore `hooks`, `mcpServers` and `permissionMode`, so none are set: the hooks
come from the plugin's `hooks/hooks.json`.

## Dispatch a plan

Dispatching hands a finished plan to background workers: each ready node gets its own git worktree and a headless Claude worker that does the node, opens the pull request and lands it, while you do something else. Nothing here asks you to know a cache path or a flag.

The one command is `/enforcer:dispatch <graph-id>` (or `enforcer dispatch <graph-id>` in a shell). It first checks sign-in, `gh`, the repo checkouts, that the installed governor allows a headless land, and that a node is claimable, and refuses to start if any check fails. Then it starts the dispatcher in the background with 3 workers, a sonnet cap, salvage and triage on and warm workers off. `enforcer dispatch status [<graph-id>]` says what is running and what needs you; `enforcer dispatch stop <graph-id>` lets running workers finish and exits. The full flag reference is in [DISPATCHER.md](DISPATCHER.md).

It will ask three things of you: resolve the gates (smoke tests and releases are never dispatched), look at the review items where a verdict needs a person, and unblock a node marked "landing blocked" (a conflict or CI outage the dispatcher could not clear) or "needs you". Merged work is reported as done, never as failed.


## The plugin must be ENABLED, and the allowlist must name the tools as they load

- A disabled `enforcer` plugin contributes no hooks: no lease keepalive, no
  evidence capture, no usage stamp, no Stop guard. Check with
  `claude plugin list`; fix with `claude plugin enable enforcer@instruxi`.
- The tools load as `mcp__plugin_enforcer_enforcer__graph_*` (the server is
  declared by the `enforcer` plugin). An allowlist that names
  `mcp__enforcer-graph__graph_*` does not match, every call prompts the human,
  and workers route around the prompts through `enforcer_api_write`.

`settings.example.json` lists all three forms: `mcp__plugin_enforcer_enforcer__`
(the plugin's server), `mcp__enforcer__` and `mcp__enforcer-graph__` (a
standalone server added with `claude mcp add`). Keep the one your session shows.

## Gates

A `type: gate` node is decided by a person through `graph_decide` (or the portal), never claimed with `graph_next_work`. If you find yourself holding a gate, report it `cancelled` with a note and tell the person. The report hook attaches the note `this is a gate: decide it with graph_decide, do not report it` and runs no acceptance line for a gate.

## Hooks

Every hook is the one command `node ${CLAUDE_PLUGIN_ROOT}/bin/enforcer event <name>`
(`hooks/hooks.json`); the graph handlers live in `src/graph/hooks/` and do
nothing unless a graph context is live.

| Event | Handler | What it does |
|---|---|---|
| SessionStart (startup, resume, compact, clear) | `session.mjs` (sessionStart) | Prints plan status: counts, frontier, running, failed, and whether THIS session still holds a run. Two HTTP GETs. |
| PostToolUse on `graph_next_work` / `graph_report` / `graph_heartbeat` | `track-run.mjs` | Records the run this session holds in `<state>/runs/<session_id>.json` from the tool result; clears it on report or when a heartbeat says `reclaimed` / `finished`. No HTTP. |
| PostToolUse on every tool | `capture.mjs` | While a run is held, appends what the tool actually did to `<state>/evidence/<session_id>.jsonl`: `Bash` as `{kind:"command", cmd, exit, output}` (output clipped to 4000 chars), `Edit`/`Write`/`MultiEdit` as `{kind:"file", path, excerpt}`. `Read`/`Grep`/`Glob` are not captured. No HTTP. |
| PreToolUse on `graph_report` | `attach.mjs` | Reads the capture, caps it at the 20 items the server accepts (failing commands first, then the most recent commands, then file changes) and merges it into the tool's arguments as `evidence` via `hookSpecificOutput.updatedInput`. Anything the model wrote in `evidence` is replaced. No HTTP. |
| PostToolUse on every tool | `heartbeat.mjs` | By elapsed time, not call count: when a third of the lease is spent (at least `GRAPH_HEARTBEAT_MIN_GAP`, default 20 s, since the last one), and right after a long tool call, one HTTP heartbeat. Silent on `ok`. On `cancel_requested`, `reclaimed` or `finished` it says so in one line to you and to the model, and forgets a run that is no longer ours. |
| PreCompact (manual, auto) | `session.mjs` (rememberOnCompact) | If a run is held, writes one progress observation (the last assistant message) on the node, so the state of the work survives in the graph, not only in the summary. |
| Stop | `session.mjs` (openRunGuard) | If a run is held and the final message does not say it was reported or deliberately left open, sends the session back once with the reason. `stop_hook_active` prevents a second block. |

State lives in `$ENFORCER_STATE_DIR`, else the directory the harness gives the
plugin (`${CLAUDE_PLUGIN_DATA}`), else `~/.config/enforcer/sessions/<harness>`
(`src/state.mjs` `stateBase()`).

The governor does no loop detection: repeated heartbeats, `graph_plan_status`
polls or any other identical calls are never denied for repeating. Loop
detection belongs to the `jev-hooks` plugin.

## Evidence the model did not author

Verification used to judge prose, and prose can be invented: a fabricated
report with invented file paths, line numbers and test names has scored full
marks. Evidence the model writes about itself does not fix that — a fabricator
fabricates that too. So `capture.mjs` records tool results as they come
back, and `attach.mjs` attaches them at report time. The model is not
in that path.

`updatedInput` **does** apply to MCP tool calls. The published hooks reference
says only "`updatedInput` - Modified tool input (PreToolUse only)" and never
mentions MCP either way, so this was read out of the shipped binary
(Claude Code 2.1.278): the PreToolUse result path validates the rewrite with
`n.inputSchema.safeParse(...)` and explicitly drops `unrecognized_keys` issues,
so an argument the tool's schema does not declare does not deny the call;
`if (Ee.updatedInput && Ee.permissionBehavior === undefined)` carries the
rewrite with no permission decision attached; and the enclosing telemetry is
MCP-aware (`isMcp`, `mcpServerType`, `mcpInfo`). `updatedInput` **replaces**
the argument object rather than merging into it, which is why the hook echoes
every argument back.

One surface does not apply it: a hook run through the remote/sandboxed tool
path turns a rewrite into `permissionBehavior: "ask"` rather than applying it.
Set `GRAPH_EVIDENCE_MODE=context` there and the hook hands the capture to the
model as text to pass on verbatim instead — **a weaker guarantee**, because the
model is back in the path and could edit it.

What the guarantee is and is not:

- Captured evidence always replaces whatever the model wrote in `evidence`.
- If nothing was captured — a run with no command and no edit, or a data
  directory the hook could not write — the hook stays silent and the call goes
  through untouched. It fails open, which means a session that runs no tools
  can still hand the server a self-written report; the server's answer to that
  is to score it `unsupported`.
- The capture is a local file. It is honest about a model that invents, not
  hardened against a user who edits the state directory by hand.

Every hook fails open: no config, no key, API down, or malformed input means
exit 0 and no output. The graph is a coordination service; it must never be
the reason a session stalls.

### Which acceptance lines run

A node's acceptance lines come from the graph, and graph content can be
written by other people. The report hook (`attach.mjs`), `enforcer evidence
run`, `enforcer plan check` and the dispatcher's landing completion all run
those lines, so a line runs only when it fully matches one shape in
`ACCEPTANCE_SHAPES` (`src/acceptance-allowlist.mjs`), the one list every
caller uses:

| Shape | Form |
| --- | --- |
| node --test | `node --test <path under the repo>...` |
| node script | `node <script .js/.mjs/.cjs under the repo> [plain args]` |
| npm test | `npm [--prefix <dir>] test`, `npm [--prefix <dir>] run <test, lint, format:check, typecheck>` |
| go test | `go [-C <dir>] test <./pkg/...> [-v -race -short -cover -failfast -json -count -p -run -tags -timeout]` |
| go vet | `go [-C <dir>] vet <./pkg/...>` |
| ls, cat, head, tail, wc, test | a few named flags and relative paths |
| grep | `grep [-cnilEFwvxrRhHqo] <literal> <relative path>...` |
| git grep | `git grep [-nciElwvFIhq] <literal> [--] [relative path]...` |
| git merge-base | `git merge-base --is-ancestor <sha> <ref>` |
| gh pr view | `gh pr view <n> [-R <owner/repo>] [--json <fields>]` |

Every argument is checked: no shell is used (the line is split into argv and
spawned directly), no shell metacharacter (`; | & < > $` and backtick,
parentheses, braces, newline, double quote, backslash) may appear outside a
token wholly in single quotes (a single-quoted token is a literal, such as a
grep pattern or a `-run` regex), every path must resolve inside the checkout
(symlinks followed), and `cd` is never allowed: a line names its directory
with `npm --prefix` or `go -C`. A trailing `2>&1` is dropped, since both
streams are captured anyway. An allowed line runs with a minimal environment
(PATH, locale, the Go cache locations) and a temporary HOME that is removed
afterwards, so no credential under `~/.config` is readable.

Everything else is reported as `not run: not an allowed command shape` and
the judge reads the worker's own captured output instead. The cases that must
never run, and ten real acceptance lines that must still run, are in
`test/acceptance-allowlist.test.mjs`.

`enforcer plan check <graph>` prints a `WARN` with a specific hint for every
line that will not be run and ends with `plan check: <ok> runnable, <skipped>
will not be run, <mismatch> mismatch`; `--strict` exits 1 when any line is
skipped.

### Writing lines the judge can verify

A line that is not run leaves the judge only the worker's own output, and in
live data about a third of rejected runs were later overruled by a human.

- Quote a literal line of real output (`prints \`3 passed\``), never a paraphrase such as `prints all tests passed`.
- Use only the allowed shapes in the table above.
- Put the PR line last: `gh pr view <n> -R <owner/repo> --json state,mergeCommit prints ...`.
- Keep one claim per line.

## Files

Working on this code (agents and humans): start from [WORKER_BRIEF.md](WORKER_BRIEF.md).
Paths are relative to `enforcer/` in this repo, listed once:

```
skills/graph/SKILL.md
agents/graph-worker.md
hooks/hooks.json                  # every event -> bin/enforcer event <name>
src/graph/hooks/*.mjs             # attach, capture, heartbeat, session, track-run, version-check
src/graph/*.mjs                   # run file, state, http, redact, clip, evidence
src/dispatch/*.mjs  src/dispatch-command.mjs
bin/land-pr.sh                    # land one PR (Node behind `enforcer land`)
docs/graph/settings.example.json
test/graph/*.test.mjs  test/graph/stub-graph.mjs   # every hook against a local stub of the API
test/dispatch/                    # the dispatcher against a fake API and a fake claude
test/skill.test.mjs               # structural checks on the skill and the agent
```

```bash
cd enforcer && node --test test/graph/run.test.mjs
```

A five-minute demo (two sessions, one killed, the lease reclaimed) lives with the
service, in enforcer-graph's `docs/PLUGIN_DEMO.md` (Instruxi staff).

### Harness usage limits

A worker that exits with a usage-limit message (`You've hit your weekly limit · resets Oct 7, 8pm (America/New_York)`,
rate limited, out of quota) is the HARNESS's state, not the node's. The dispatcher spends no attempt, leaves the
run to lapse rather than failing it, logs `HARNESS-LIMITED <key>: … until <reset>`, and holds every launch until
the reset named in the message (else `--limit-backoff`, default 1800 s). `--on-limit exit` makes it exit 4 instead,
for a supervisor that restarts it. Before 1.0.0-rc.2 the limit counted as two failed attempts and the dispatcher
exited with "nothing runnable" (2026-10-05).

## Windows

Windows support: MCP, files and the governor are supported. The graph hooks are supported after the Node port. The dispatcher is POSIX only (use WSL): no bash, `chmod` is a no-op so credential protection is advisory, and no process groups. `enforcer doctor` prints this on win32.

## Context pack and memory

A graph can carry one context pack: an immutable file in enforcer-files whose sha256 sits on the graph row. At SessionStart the plugin reads `GET /graphs/{id}/context`; when `pack.sha256` is set it fetches the file once per hash into the state dir (`context/<sha256>.md`, 0600, 3 s timeout) and injects one fixed line, `enforcer-graph context pack <sha256[:12]>`, followed by the file bytes unchanged, so every worker on the graph injects byte-identical text. With no pack, or on a fetch failure (one stderr notice), nothing is injected.

Before a compaction, the PreCompact hook writes the last assistant summary as a graph-scoped observation of kind `summary` with `data.node_key`, `data.run_id` and `data.files` (the files the transcript touched). A service without graph scope gets the node-scoped write instead.

`enforcer dispatch run --context on|off` (default on) sets `ENFORCER_CONTEXT_PACK=1|0` for workers; `off` suppresses the injection. `enforcer plan check` prints a WARN when the graph has no pack.
