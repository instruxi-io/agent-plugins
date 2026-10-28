#!/usr/bin/env node
// headersHelper for the Enforcer MCP server, and (through ~/.enforcer/otel-headers.mjs)
// Claude Code's otelHeadersHelper.
//
// Claude Code runs this before connecting to the server the plugin registers
// (.mcp.json), and again after a 401. It prints the headers that authenticate
// the request, read from ~/.enforcer/credentials.json, the file /enforcer:login writes and
// enforcer-governor's hooks read too: sign in once and the MCP server and
// the governor are both signed in.
//
// As the OTel helper, its headers are cached for CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS
// and an OTLP export that gets a 401 is dropped, not retried. So on that path a token that
// would expire before the next call is refreshed now (TELEMETRY_REFRESH_SKEW_MS), not
// within 60s of expiry. The path is recognised by the entry script: the shim telemetry.mjs
// writes is named otel-headers.mjs, in every version that has written one.
//
// Signed out, it prints {} and exits 0. The server then answers 401 with its
// OAuth discovery challenge, so a client that can sign in on its own still
// can; nothing here makes that path worse.
import { basename } from 'node:path';
import { authHeaders } from '../src/credentials.mjs';
import { TELEMETRY_REFRESH_SKEW_MS } from '../lib/governor/adapters/claude-code/telemetry.mjs';

const forTelemetry = basename(process.argv[1] || '') === 'otel-headers.mjs';

let headers = {};
try {
  headers = await authHeaders(forTelemetry ? { skewMs: TELEMETRY_REFRESH_SKEW_MS } : {});
} catch {
  headers = {};
}
process.stdout.write(JSON.stringify(headers));
