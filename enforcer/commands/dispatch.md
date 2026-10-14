---
description: Dispatch a plan - start, check on, or stop the background workers for an Enforcer graph
argument-hint: "<graph-id> | status [<graph-id>] | stop <graph-id>"
allowed-tools: Bash(node:*)
---
Run the command and print its output verbatim. `<graph-id>` starts the dispatcher in the background with defaults (3 workers, sonnet, salvage and triage on); `status` says what is running and what needs you; `stop` drains and exits.

Then, if the output shows `needs you:` above 0 (a ready gate, an open review item, a node failed on a human decision), do not stop at the printout: ask the person about each item now, with `AskUserQuestion` (load it with ToolSearch `select:AskUserQuestion` if it is deferred), and record each answer. If no question tool is available, give them the exact `! graphwatch decide ...` / `! graphwatch resolve ...` command for each item, filled in, as the `enforcer:graph` skill's "When a person must answer" section says.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer" dispatch $ARGUMENTS`
