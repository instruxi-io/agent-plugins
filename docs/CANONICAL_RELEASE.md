# The canonical `enforcer` release

**Status:** approved design, 2026-10-05. Executed by the enforcer-graph plan
`enforcer-canonical-release`. Every node of that plan reads this document first;
when a node and this document disagree, fix the document in the same PR.

## Decision

Instruxi ships **two** plugins:

- **`enforcer`** — the product. The Enforcer MCP server connection, sign-in and
  workspace switching, workspace files, the graph worker and its dispatcher, and
  the governor (policy gate + tamper-evident decision records). Published as one
  [Agent Plugins 1.0](https://agent-plugins.org/) package so it installs in
  Claude Code, Codex CLI and Grok Build from the same artifact. Claude Code stays
  the first-class, reference harness: its adapter ships in the package and is the
  one every other adapter is tested against.
- **`jev-hooks`** — Instruxi staff only. The nine Jev-backed *quality* hooks
  (narrow output, loop detection, pre-compact triage, stop self-check, subagent
  verify, model routing…); loop detection lives only here, the governor does
  not do it. It expects `enforcer` to be installed and contains **no
  allow/deny policy**: that is the governor's, inside `enforcer`.

`enforcer-graph`, `enforcer-files` and `enforcer-governor` stop existing as
separate installs. Their marketplace entries become deprecated aliases that point
at `enforcer` for one release, then go.

Why one package: a policy gate that can be installed-but-disabled is not a gate
(2026-10-05: the governor was disabled on the owner's machine while jev-hooks
deferred to it because its cache directory existed — no gate at all). Version skew
between four plugins cost a day on the agents-platform build. Every user of the
MCP plugin is a user of the governor; nobody installs the governor without a
workspace. A plugin boundary is not a security boundary: all hooks run in one
process with one set of permissions.

## Codex status (2026-10-27): beta

`codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi`
installs the package, and Codex discovers the nine plugin hooks from `.codex-plugin/plugin.json`
(trust is granted in Codex's `/hooks` UI). **The enforcer MCP server does not attach under Codex
yet:** `codex mcp login enforcer` completes, but Codex's `initialize` is then refused
(`auth_rejected … invalid_token`) and the session has no `enforcer_*` tools. Codex's OAuth client
also asks for every scope the server offers, since it has no `--for work` preset. Both are tracked
on the release graph as `mcp-oauth-codex` (enforcer-v3-mcp). Until it lands, Codex users get the
governor and the skills, not the graph tools.

## What is portable, what is an adapter

The industry drew the line (Agent Plugins 1.0; Codex's and Grok's plugin formats
follow it): **MCP servers and skills are portable; hooks, agents and commands are
per-harness extensions.**

| layer | portable form | harness adapters |
|---|---|---|
| MCP connection | `mcp.json`: `{"type": "streamable-http", "url": "https://api.instruxi.dev/mcp"}`. The endpoint already answers 401 with `WWW-Authenticate: Bearer resource_metadata=…/.well-known/oauth-protected-resource/mcp`; Codex and Grok complete OAuth from that. | Claude: `.mcp.json` keeps the `headersHelper` shim for API-key users until Claude's remote-MCP OAuth is verified against this server; then the shim goes. |
| Skills | `skills/<name>/SKILL.md` for enforcer (login, workspace, setup), files (find/read/share/upload/download), graph (claim/work/heartbeat/report), governor (status/config/limit/verify). Slash commands become skills; a command file stays only where Claude needs the `/enforcer:x` surface. | none |
| Policy engine | `bin/enforcer governor decide` — reads the common event JSON (`hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, `transcript_path`, `model`), returns the 2.9.0 decision record (`{"decision","code","rule","tool","summary"}`), writes the tamper-evident log. Harness-neutral; no Claude field names inside. | `hooks/claude/*.mjs`, `extensions.com.openai.hooks` (Codex), `harness/grok/hooks/enforcer.json` (Grok, shims in `hooks/grok/`): short shims that map stdin → event JSON and the record → that harness's exit code / `hookSpecificOutput`. |
| Graph worker hooks | `bin/enforcer event <event>` — evidence capture, heartbeat, open-run guard, remember-on-compact, version check — gated in `bin/enforcer` by `graphContextLive`: they do nothing unless a graph context is live (`GRAPH_ID` set or a claimed run in the session state). The governor hooks are not gated this way; they always run. | same three shims as above; one hooks file per harness. |
| Dispatcher | `enforcer dispatch --harness claude|codex|grok` (`src/dispatch/*.mjs`) — lease, salvage, triage, `data.base`, contested resources are harness-neutral already; only the launch command and the stream parser differ (`claude -p --output-format stream-json`, `codex exec --json`, `grok -p … --output-format json`). | per-harness launcher + parser modules parsers are tested on fixtures in `test/fixtures/dispatch` (Claude and Grok from real runs; the Codex parser is a stub, see CHANGELOG). |
| Graph-worker agent | Claude-only extra (`agents/graph-worker.md`); Codex skips agent handlers, Grok has `.grok/agents/` — a Grok agent file is generated from the same source. | |
| State | `~/.config/enforcer/` — governor records, session state, dispatcher state (credentials stay in `~/.enforcer/credentials.json`, shared by every plugin on the machine) — keyed by harness where it differs. No `~/.claude` path in the package outside `hooks/claude/` and the Claude plugin-cache lookup in `src/dispatch/launch.mjs`. | migration on first run moves what exists. |

## Package layout

```
enforcer/
  plugin.json              Agent Plugins 1.0 (name enforcer, version 1.3.29, $schema)
  mcp.json                 streamable-http, api.instruxi.dev/mcp
  .claude-plugin/plugin.json   Claude compatibility fallback (same version)
  .mcp.json                Claude: http + headersHelper (until OAuth verified)
  skills/{enforcer,files,graph,governor}/SKILL.md
  agents/graph-worker.md   Claude extra
  commands/*.md            Claude extra, thin: each just invokes its skill
  hooks/hooks.json         Claude adapter wiring -> bin/enforcer event
  hooks/claude/*.mjs       the shims
  .codex-plugin/plugin.json  Codex's own manifest: hooks -> hooks/codex/hooks.json, mcpServers -> mcp.json, skills (Codex ignores plugin.json's extensions.com.openai)
  harness/codex/mcp.json   Codex MCP snippet
  harness/grok/            hooks/enforcer.json template, config.toml.snippet ([mcp_servers.enforcer]), agents/, fixtures/
  hooks/grok/              Grok shims
  bin/enforcer             node CLI: login, workspace, files, headers, governor, event, dispatch, plan, harness uninstall <codex|grok> (a migration: removes the old runtime copy, its hooks/agent files, config.toml section and PATH shim by manifest, restores recorded backups, prints the native install; `install` is the same command; each harness's own plugin manager does the installing)
  bin/land-pr.sh
  lib/governor/            the decision core (moved from enforcer-governor with history)
  src/graph/               the graph worker hooks (Node)
  src/dispatch/            the dispatcher (Node)
  test/                    node tests and bash install checks; harness fixtures
docs/CANONICAL_RELEASE.md  this file
.claude-plugin/marketplace.json   enforcer 1.1.0; jev-hooks; deprecated aliases
.agents/plugins/marketplace.json  Codex marketplace, same artifact
```

## Rules every node follows

1. **No `~/.claude` in the package.** State under `~/.config/enforcer/`; credentials
   stay in `~/.enforcer/credentials.json`. Exceptions: `hooks/claude/` and the Claude
   plugin-cache lookup in `src/dispatch/launch.mjs`. Pinned by `enforcer/test/migration.test.mjs`
   and `enforcer/test/state.test.mjs` (old state moves to the new location, and
   `CLAUDE_CONFIG_DIR` is honoured for the legacy dir). Nothing greps the tree for the string.
2. **No Claude field names below the shim.** The core takes the common event JSON.
   Pinned by `enforcer/lib/governor/test/core-boundary.test.mjs` (core/ imports only core/
   and Node built-ins).
3. **Every graph worker hook is gated.** `bin/enforcer event <event>` exits with no output
   and starts no subprocess when no graph context is live, so a user who never touches a graph pays
   nothing. Pinned by `enforcer/test/hooks.test.mjs`, `enforcer/test/grok-shims.test.mjs`
   (silent without a graph context) and `enforcer/test/hooks-latency.test.mjs` (silent, and
   under the latency budget). The governor hooks always run.
4. **Fixtures are verbatim.** A parser or shim is tested against the exact JSON a real
   harness emitted (copied from a run log), never a hand-written approximation —
   the salvage parser was "fixed" twice against invented cards before a real one
   showed the slug nested under `skill`. Met for Grok (`enforcer/test/fixtures/grok`,
   copies of `enforcer/harness/grok/fixtures`, from a grok 1.0.41 run; pinned by
   `enforcer/test/grok-shim.test.mjs` and `enforcer/test/grok-shims.test.mjs`) and for the
   Claude and Grok dispatcher streams (`enforcer/test/fixtures/dispatch`). **Not met for
   Codex:** `enforcer/test/fixtures/codex` is written from Codex's documented payload
   (`enforcer/test/codex-shims.test.mjs`); replace it when a Codex run is available.
5. **One version.** `plugin.json`, `.claude-plugin/plugin.json`, `package.json`, `kit.json`
   and the marketplace entries carry the same string; the version-check hook compares one.
   Pinned by `enforcer/test/validate-plugin.test.mjs`.
6. **History moves with code.** `enforcer-governor` and `enforcer-graph` fold in by
   `git subtree add` (or filter-repo), not by copy.
7. **Claude first.** Nothing lands that makes the Claude install worse than 0.27.3 /
   2.9.0 / 0.7.0 today; Codex and Grok adapters are additive.
8. **Delivery:** branch `graph/<key>`, PR via `land-pr.sh`, verbatim gate output as
   the last evidence; one node per report.

## Plan (nodes)

| key | repo | does | depends on |
|---|---|---|---|
| `design-doc` | claude-plugins | this document | kickoff |
| `package-layout-agent-plugins` | claude-plugins | root `plugin.json`/`mcp.json`/`skills/`, commands → skills, `.claude-plugin` fallback, version 1.0.0-rc.1, schema validation test | design-doc |
| `mcp-oauth-no-shim` | claude-plugins | prove the remote MCP OAuth path from a non-Claude client; `harness/{codex,grok}` MCP snippets; smoke script | design-doc |
| `governor-core-cli` | enforcer-governor | extract `governor decide` CLI + common event JSON; hooks become shims; tests | design-doc |
| `governor-fold-in` | claude-plugins | subtree enforcer-governor into `enforcer/lib/governor` + `bin/enforcer governor`; Claude hooks wired; marketplace alias | package-layout, governor-core-cli |
| `graph-fold-in` | claude-plugins | subtree enforcer-graph into `enforcer/`; hooks self-gate; `bin/enforcer event`; agent; dispatcher; alias | package-layout |
| `files-fold-in` | claude-plugins | enforcer-files skill + bins into `enforcer`; alias | package-layout |
| `state-relocation` | claude-plugins | every `~/.claude` path → `~/.config/enforcer/…` with first-run migration | governor-fold-in, graph-fold-in |
| `hook-adapter-codex` | claude-plugins | `extensions.com.openai` overlay, hooks wiring, `.agents/plugins/marketplace.json`; shim tests on Codex stdin fixtures | governor-fold-in, graph-fold-in |
| `hook-adapter-grok` | claude-plugins | `harness/grok` hooks + config + agents; native `grok plugin install enforcer --trust`; shim tests on Grok fixtures (grok 1.0.41 is installed on the owner's machine) | governor-fold-in, graph-fold-in |
| `dispatcher-harness-switch` | claude-plugins | `--harness`; launchers + parsers + fixtures for codex/grok | graph-fold-in |
| `jev-hooks-quality-only` | jev-hooks | depend on `enforcer`; delete bash/edit allow-deny; governor detection = `ENFORCER_GOVERNOR` env only; 1.0.0 | governor-fold-in |
| `release-1.0` | claude-plugins | version 1.0.0 everywhere, CHANGELOG, deprecated aliases, tag, `claude plugin validate` | state-relocation, hook-adapter-codex, hook-adapter-grok, dispatcher-harness-switch, files-fold-in, mcp-oauth-no-shim, jev-hooks-quality-only |
| `gate-release-smoke` | — (human) | install `enforcer` 1.0.0 fresh in Claude Code and Grok Build on the owner's machine, claim + report one node through each, confirm the governor records both | release-1.0 |
| `cleanup` | ops | archive `enforcer-governor` repo, remove old plugin caches and deprecated installs, remove the dangling `enforcer-graph@enforcer-graph` settings entry, update enforcer-graph docs/WORKER_BRIEF | gate-release-smoke |

Nodes that edit `enforcer/` declare `data.resources: ["claude-plugins/enforcer"]`
so the dispatcher never runs two of them at once.

## Remote MCP OAuth from non-Claude clients

`https://api.instruxi.dev/mcp` is a remote MCP server that takes OAuth, not a shim.
`bash test/mcp-oauth-smoke.sh` proves it with no credential: `initialize` returns 401 with
`WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`,
and the protected-resource and authorization-server metadata carry `authorization_endpoint`,
`token_endpoint` and the `enforcer:*` scopes. The server advertises PKCE S256 and dynamic
client registration (`registration_endpoint`), so a client needs no pre-issued client id.

- **Codex:** `codex mcp add enforcer --url https://api.instruxi.dev/mcp` (or merge
  `enforcer/harness/codex/mcp.json`), then `codex mcp login enforcer`. Codex discovers the metadata
  above, registers itself, and opens the browser for the authorization-code + PKCE flow.
- **Grok:** `grok mcp add --transport http enforcer https://api.instruxi.dev/mcp` (or merge
  `harness/grok/config.toml.snippet`). Grok completes OAuth in the browser on first connect;
  `grok mcp doctor` diagnoses connectivity.

The Codex and Grok flows were not completed here (browser sign-in is interactive; codex is not
installed on this machine). grok 1.0.41 non-interactive listing, verbatim:

```
$ grok mcp list
No MCP servers configured. Run `grok mcp add --help` to get started.
```

## Detecting the governor from other hook packs

The governor lives inside enforcer (since 1.0.0). Its SessionStart hook (Claude, Codex and Grok
shims, and `bin/enforcer event session-start`) announces it with `ENFORCER_GOVERNOR=1`
(exported via `CLAUDE_ENV_FILE` and carried in the hook output's `env`). Other hook packs
(jev-hooks etc.) must read `ENFORCER_GOVERNOR`, never the plugin-cache directory: when the
deprecated `enforcer-governor` cache vanished, jev-hooks 0.27 saw no governor, gated work
itself and denied every headless worker.

## Install

Native commands only; no copier and no PATH shim:

- Claude: `claude plugin marketplace add instruxi-io/agent-plugins && claude plugin install enforcer@instruxi`
- Grok: `grok plugin marketplace add instruxi-io/agent-plugins && grok plugin install enforcer --trust`
- Codex: `codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi`
- CLI: `npm i -g @instruxi/enforcer`
