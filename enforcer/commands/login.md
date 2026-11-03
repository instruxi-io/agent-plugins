---
description: Sign this machine in to Enforcer, once, for the Enforcer MCP server and every Instruxi plugin
argument-hint: "[<WORKSPACE-CODE>] [--for work|plan|agents|admin] [--scope \"<scopes>\"] [--new-app] | api-key <file>|- | scopes | status | logout"
allowed-tools: Bash(node:*)
---
Invoke the `enforcer` skill's `login` procedure (skills/enforcer/login.md) with the arguments the command line below carries. `api-key` takes a file path or `-` (stdin), never the key itself: an argument lands in the transcript. `--for agents` asks for read, policy:self, `enforcer:agents.write` and `enforcer:agents-credentials.write` (not the destructive one), enough to create an agent and issue it a key, plus the plan-sharing scopes so the agent's plan can be shared with it, opened for recruiting and given skills.
```!
node "${CLAUDE_PLUGIN_ROOT}/bin/login.mjs" --args-stdin <<'ENFORCER_ARGS_EOF'
$ARGUMENTS
ENFORCER_ARGS_EOF
```
