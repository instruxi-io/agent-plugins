---
description: Show or change the governor's settings, and turn its checks on or off
argument-hint: "status | config | set <name> <value> | enable|disable <rules|budget|policy> | limit <dollars> | resume [agent] | telemetry [on|off|status]"
allowed-tools: Bash(node:*)
---
Run the governor command below and print the result verbatim. The governor reports data first; its rule, spend and policy checks are off until you enable them.
```!
node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer" governor $ARGUMENTS
```
