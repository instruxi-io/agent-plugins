#!/usr/bin/env node
// The OTel headers helper's entry point: ~/.enforcer/otel-headers.mjs imports
// <plugin-root>/bin/enforcer-headers.mjs, and plugin-root names lib/governor (see
// recordPluginRoot in adapters/claude-code/telemetry.mjs), so this is the file Claude Code's
// otelHeadersHelper runs. It is the package's one headers helper, not a second copy: that
// one refreshes a token that would expire inside Claude Code's header cache (the entry
// script is still the shim, which is how it knows it serves telemetry).
import '../../../bin/enforcer-headers.mjs';
