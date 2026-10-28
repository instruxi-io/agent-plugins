# Harness session-log fixtures

Synthetic logs for `test/harness-usage.test.mjs`. The ids, prompts and paths are invented.

- `grok-updates.jsonl`: shaped like a grok 1.0.46 `updates.jsonl`, with the line envelope, `user_message_chunk`, `hook_execution` and `turn_completed` copied from a real session's structure. The two `costUsdTicks` values and their token counts are real turns' figures. The fourth and fifth lines repeat one `eventId` on purpose, as a replayed line.
- `codex-rollout.jsonl`: built from the serialization in openai/codex at commit ce0323f2 (`codex-rs/history/src/lib.rs` `RolloutLine`, `protocol/src/protocol.rs` `TokenCountEvent`, `TokenUsage`, `TurnContextItem` and `UserMessageEvent`). It was not recorded from a live Codex run. It has a `token_count` with `info: null`, and its model changes from `gpt-5-codex` to `gpt-5.5` part-way through.
- `cursor-transcript.jsonl`: invented. Cursor documents `transcript_path` only as the conversation's JSONL and publishes no token-usage schema for it or for hook payloads, so this exercises the tolerant reader (`adapters/cursor/usage.mjs`): an Anthropic-style `message.usage`, a camelCase `tokenUsage`, a replayed generation id, a tool line and a corrupt line. Replace it with a recorded transcript once one is captured.
