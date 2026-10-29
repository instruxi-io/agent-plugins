---
description: Check the receipt chain — names the first record that does not add up, and says when lines are missing from the end
allowed-tools: Bash(node:*)
---
Verify the receipt chain and show the result verbatim. It checks every line against the one before it (hash v1 and v2 alike), reports a last line with no hash as a break, and reports lines missing from the end when the file no longer holds the head state.json recorded or the newest receipt the control plane acknowledged:

!`node "${CLAUDE_PLUGIN_ROOT}/src/report.mjs" verify`
