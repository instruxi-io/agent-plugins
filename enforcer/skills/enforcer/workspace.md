# workspace

List the Enforcer workspaces you belong to, switch between them, or show the current one.

Arguments: `list | switch <name|code|tenant_id> | current`

Tools used: Bash(node:*), mcp__plugin_enforcer_enforcer__enforcer_whoami
Run the command and print the result verbatim. After a `switch`, also call `enforcer_whoami` and show the workspace it reports, so the person sees the MCP server now acts there.

`switch` only moves between workspaces you already belong to. If it says you are not a member, use `/enforcer:login <WORKSPACE-CODE>` or accept an invite instead.

If it says the app has not been authorized for that workspace (`consent_required`), the person has not signed in to that workspace with this machine's registered app yet: run `/enforcer:login` once and pick that workspace in the browser (a code works too, when the workspace has one). After that, `switch` reaches it from every other workspace, and back, with the scopes that workspace was signed in to with.

Run `enforcer workspace <arguments>`; if `enforcer` is not on PATH (Claude Code), run `node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer" workspace <arguments>`.
