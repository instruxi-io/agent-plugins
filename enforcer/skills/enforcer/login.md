# login

Sign this machine in to Enforcer, once, for the Enforcer MCP server and every Instruxi plugin.

Arguments: `[<WORKSPACE-CODE>] [--for work|plan|agents|admin] [--scope "<scopes>"] [--new-app] | api-key <file>|- | scopes | status | logout`

Tools used: Bash(node:*), Bash(enforcer:*)
Sign in to Enforcer and print the result verbatim. With no argument this opens a browser sign-in and waits for it to finish. With a workspace code (e.g. `ACME-1234-ABCD`, or `ENFORCER_TENANT_CODE` in settings) the sign-in page skips asking for it. `--for work` (default; the work loop's scopes plus `enforcer:workspace.write`, which `/enforcer:workspace switch` needs, and the plan-sharing scopes `enforcer:graph-sharing.write`, `enforcer:graph-work.write` (recruiting) and `enforcer:graph-skills.write`, each requested only when the server offers it), `--for plan` (work plus graph/template/epoch writes) or `--for admin` (every scope offered) pick a preset; the default is the last preset used.  `--scope "enforcer:read policy:self"` asks for only those (each must be offered, or it refuses before opening the browser), and `scopes` lists what is offered. `--new-app` registers a fresh OAuth app for this machine instead of reusing the saved one: a registered app keeps the permissions the server offered when it registered, so when a sign-in prints `Not granted:` for scopes the server now offers, sign in again with `--new-app` (each other workspace then needs one sign-in before `/enforcer:workspace switch` reaches it). A saved app whose recorded permissions lack a requested scope is replaced automatically. A sign-in whose new token Enforcer refuses outright (HTTP 431, the token too large for its request headers) fails and saves nothing, so a working sign-in is never replaced by a broken one.

Run `enforcer login <arguments>` and print the output verbatim. If `enforcer` is not on PATH (Claude Code), run `node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer" login <arguments>`; under Codex or Grok install the CLI once with `npm i -g @instruxi/enforcer`.

When a sign-in replaces an existing one, the tool server keeps its session until it reconnects (run `/mcp`, pick enforcer, reconnect); the output says so.
