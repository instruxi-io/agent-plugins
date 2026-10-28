# Enforcer for Hermes Agent

Sends [Hermes Agent](https://hermes-agent.nousresearch.com) telemetry to Enforcer governance, so Hermes sessions show up with their spend, tokens, tools and sub-agents next to Claude Code's.

```sh
hermes plugins install instruxi-io/agent-plugins/enforcer/harness/hermes --enable
```

Telemetry is on as soon as the plugin is enabled. It needs the `enforcer` CLI on this machine, signed in (`enforcer login`, or `/enforcer:login` in Claude Code). The plugin runs `enforcer ingest-key --harness hermes --json` once per Hermes process, and again if governance refuses the key. The CLI mints a telemetry-only key for this machine (agent `hermes@<hostname>`), rotates it, and caches it 0600 in `~/.enforcer/ingest-keys.json`. The plugin never writes the key anywhere. Revoking that agent's key in the console stops this machine's Hermes telemetry.

The plugin finds the CLI on `PATH`, then in the copy the Claude Code plugin installed. You can also set it with `ENFORCER_CLI` or `plugins.entries.enforcer.settings.enforcer_cli`. Containers and CI can pass a key directly in `ENFORCER_INGEST_KEY`.

## Status and turning it off

```sh
hermes enforcer status            # endpoint, key (id and expiry, never the secret), exported / dropped counts, last error
hermes enforcer telemetry off     # or: hermes config set plugins.entries.enforcer.settings.telemetry false
ENFORCER_TELEMETRY=0 hermes ...   # off for one shell
```

`/enforcer` inside a session prints the same status.

## What is sent

The plugin sends OTLP/HTTP protobuf (gzip) to `<origin>/api/v1/governance/otlp/v1/logs` and `.../v1/metrics` with an `X-API-Key` header. The resource is `service.name=hermes`, and every record carries `session.id`, the Hermes session id. Records are metadata only. The plugin never sends prompts, responses, tool arguments, tool output, sub-agent goals or summaries, approval commands, or provider error messages.

| Hermes hook | Log event | Metric points |
|---|---|---|
| `on_session_start` | `hermes.session.start` (model, platform) | `hermes.session.count` |
| `on_session_end` / `on_session_finalize` | `hermes.session.end` (completed, interrupted, failed, exit_reason) / `hermes.session.finalize` | (flushes the queue) |
| `on_session_reset` | `hermes.session.reset` (previous_session_id) | |
| `post_api_request` | `hermes.api_request` (model, provider, duration_ms, ttfb_ms, finish_reason, the token counts, cost_usd, cost_status) | `hermes.token.usage` by `type`, `hermes.cost.usage` (USD) |
| `post_auxiliary_call` | `hermes.auxiliary_request` (plus aux_task) | same as above, `hermes.call_kind=auxiliary` |
| `api_request_error` | `hermes.api_error` (status_code, error_type, reason, retry_count, retryable) | |
| `post_tool_call` | `hermes.tool_result` (tool_name, status, success, duration_ms, error_type, mcp_server) | `hermes.tool.count` |
| `subagent_start` / `subagent_stop` | `hermes.subagent.start` / `.stop` (parent and child session ids, role, status, duration_ms, tool_call_count) | |
| `post_approval_response` | `hermes.approval` (choice, surface, decided_by) | |

**Token types.** The `type` values are `input`, `output`, `cache_read`, `cache_creation` and `reasoning`. They come from Hermes' own normalised usage. `input` excludes cached tokens. The first four are disjoint. `reasoning` is part of `output`.

**Cost.** Cost is Hermes' own price for the call: the figure `/usage` shows, from `estimate_usage_cost`. A call Hermes cannot price (a local or custom model) sends tokens and no cost point.

Every metric is a monotonic delta sum, with one point per call.

## Delivery

Hooks only enqueue. A daemon thread exports every 5 s, when a batch of 256 is ready, or when a session ends. A final flush runs at exit and takes at most 2 s.

Nothing in the export path can fail a Hermes turn:
- **Full queue.** The queue holds 2048 records. When it is full, new records are dropped.
- **Server errors.** A 429 or 5xx is retried twice, then the batch is dropped.
- **Refused key.** A 401 or 403 makes the plugin ask the CLI for a key once.
- **No key.** If the CLI is missing or signed out, export pauses and the plugin checks again every 5 minutes.

`hermes enforcer status` counts everything that was dropped.

## The Enforcer MCP server

Hermes plugins written in Python cannot declare MCP servers. Only portable `plugin.json` packages can, and a directory is one kind or the other. Add the server yourself:

```sh
hermes mcp add enforcer --url https://api.instruxi.dev/mcp --auth oauth
```

`hermes enforcer mcp` prints this command for your origin, and `hermes enforcer status` shows whether the server is configured.

## Tests

```sh
cd enforcer/harness/hermes && python3 -I -m unittest discover -s test
```

`npm test` runs the same suite through `enforcer/test/hermes-plugin.test.mjs`.
