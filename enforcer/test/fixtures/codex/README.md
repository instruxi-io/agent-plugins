Codex-shaped hook stdin: the Claude field names plus `turn_id`, `model`, `permission_mode`.

Recorded verbatim from codex-cli 0.164.0 (`codex exec` against a local stub model, a probe hook
echoing its stdin; home and project paths replaced with `/home/dev/...`): `session-start.json`,
`user-prompt-submit.json`, `post-tool-use.json`, `stop.json`, `session-end.json`. Codex names its
shell tool `Bash` with `tool_input.command` a string, and sends `tool_response` as a string.

Written by hand from Codex's documented hook payload, not recorded: `pre-tool-use-allow.json`,
`pre-tool-use-deny.json`, `permission-request.json`, `post-compact.json`, `interrupt.json`.
`scripts/codex-hooks-e2e.sh` reproduces the recordings against a real Codex.
