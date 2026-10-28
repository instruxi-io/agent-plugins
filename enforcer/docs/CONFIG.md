# Configuration

One resolver, `src/config.mjs`, decides which server every component talks to. The graph hooks and the dispatcher read it through the same resolver. `login`, `doctor`, the hooks, `dispatch` and `plan check` agree.

## Base URL precedence

1. an explicit flag (`--base-url`, accepted by `login`)
2. `ENFORCER_BASE_URL`
3. `base_url` saved in `~/.enforcer/credentials.json` by the last sign-in
4. `https://api.instruxi.dev`

From one base the resolver derives: MCP `<base>/mcp`, graph `<base>/api/v1/graph` (or `GRAPH_BASE_URL`), files `<base>/api/v1/files`, governance `<base>/api/v1/governance`. The state dir is `ENFORCER_STATE_DIR`, else `CLAUDE_PLUGIN_DATA`, else `<config home>/sessions/<harness>`.

Every variable below is checked. A malformed value is a named error (`GRAPH_HOOK_TIMEOUT: must be a number ...`), shown by `enforcer doctor`, never a silent fallback.

## Environment variables (22)

| Variable | Default | Meaning |
|---|---|---|
| `ENFORCER_BASE_URL` | `https://api.instruxi.dev` | Server origin. Beats the saved sign-in; set it for a self-hosted server. |
| `ENFORCER_API_KEY` | none | API key used as the credential; beats a browser sign-in. |
| `ENFORCER_HOME` | `~/.enforcer` | Directory holding the shared `credentials.json`. |
| `ENFORCER_CONFIG_HOME` | `~/.config/enforcer` | Root of per-user plugin state. |
| `ENFORCER_STATE_DIR` | `<config home>/sessions/<harness>` | Session state (graph runs, captured evidence). |
| `ENFORCER_HARNESS` | `claude` | `claude`, `codex`, `grok` or `cursor`. |
| `ENFORCER_ROUTES` | unset | Path to a dispatcher route table, as `--routes` (docs/graph/ROUTES.md); beaten by `--routes`, beats the graph's `node_defaults.routes` and `<config home>/dispatch/routes.json`. |
| `ENFORCER_HEADLESS` | unset | Marks a headless worker (0/1/true/false/yes/no). |
| `ENFORCER_GOVERNOR` | unset | Governor selector read by the governor hooks. |
| `ENFORCER_SCOPE` | unset | Scope requested by `login`. |
| `ENFORCER_TENANT_CODE` | unset | Workspace code `login` signs in to. |
| `ENFORCER_RESOURCES` | unset | Resources requested by `login`. |
| `ENFORCER_GRAPH_RUN_ID` | set by the dispatcher | Run id handed to a worker. |
| `GRAPH_BASE_URL` | `<base>/api/v1/graph` | Graph API URL only; overrides the derived one. |
| `GRAPH_ID` | from `.enforcer/graph.json` | Graph id for the hooks. |
| `GRAPH_API_KEY` | none | Graph API key (legacy; prefer sign-in). |
| `GRAPH_AUTH_HELPER` | the signed-in credential | Command printing auth headers for the dispatcher. |
| `GRAPH_HOOK_TIMEOUT` | `1.5` | Seconds a hook waits for the server, 0.05 to 600. Malformed: named error on stderr, default kept. |
| `GRAPH_EVIDENCE_MODE` | unset | How the hooks capture evidence. |
| `GRAPH_INVITE_URL_BASE` | unset | Base URL for invite links. |
| `GRAPH_JEV_PRICE_PER_MTOK_USD` | unset | Price per million tokens used to cost judge calls (number >= 0). |
| `GOVERNOR_HOME` | `~/.enforcer-governor` | Legacy governor credential directory, still read. |
| `CLAUDE_PLUGIN_DATA` | set by Claude Code | Plugin data directory, used as the state dir. |

Set by the harness, not configuration: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CONFIG_DIR`, `CLAUDE_ENV_FILE`.

## MCP server

`.mcp.json` registers production's `/mcp`, because a static file cannot read the resolver. For another server follow `docs/SELF_HOSTED.md`.
