// The OTel headers helper must hand Claude Code a token that outlives Claude Code's cache of it.
//
// Claude Code re-runs otelHeadersHelper only every CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS (10 min)
// and an OTLP export answered 401 is dropped, not retried. A helper that only refreshed within 60s of
// expiry served a token with 6 minutes left, and the last 4 minutes of every such window were lost
// (instruxi ingress, 2026-10-28: recurring 401 bursts on /otlp/v1/logs|metrics). These run the real
// shim enable() writes, as Claude Code does, in a child process whose fetch is stubbed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOT } from '../hooks/claude/paths.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = mkdtempSync(join(tmpdir(), 'otel-skew-'));
const home = join(base, 'home');
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ENFORCER_HOME = join(home, '.enforcer');
process.env.CLAUDE_SETTINGS_PATH = join(home, DOT, 'settings.json');
delete process.env.ENFORCER_API_KEY;

// The stub lives outside the HOME the helper reads: fetch answers a rotated pair and counts its calls.
const stubDir = join(base, 'stub');
mkdirSync(stubDir);
const CALLS = join(stubDir, 'calls');
const STUB = join(stubDir, 'fetch-stub.mjs');
writeFileSync(
  STUB,
  [
    "import { appendFileSync } from 'node:fs';",
    'globalThis.fetch = async (url) => {',
    `  appendFileSync(${JSON.stringify(CALLS)}, String(url) + '\\n');`,
    "  return { ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 900 }) };",
    '};',
    '',
  ].join('\n'),
);

const { saveCredentials, readCredentials, REFRESH_SKEW_MS } = await import('../src/credentials.mjs');
const telemetry = await import('../lib/governor/adapters/claude-code/telemetry.mjs');
telemetry.enable({ centralUrl: 'https://api.instruxi.dev' });
const SHIM = join(process.env.ENFORCER_HOME, 'otel-headers.mjs');
assert.ok(existsSync(SHIM), 'enable() writes the shim');

const MIN = 60_000;
const seed = (msLeft) => {
  saveCredentials({
    enforcer: {
      oauth: {
        access_token: 'old',
        refresh_token: 'r1',
        client_id: 'c',
        token_endpoint: 'https://api.instruxi.dev/api/v1/enforcer/oauth/token',
        expires_at: new Date(Date.now() + msLeft).toISOString(),
      },
    },
  });
  writeFileSync(CALLS, '');
};
const calls = () => readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).length;
const run = (script) => JSON.parse(execFileSync(process.execPath, ['--import', pathToFileURL(STUB).href, script], { env: process.env, encoding: 'utf8' }));

let pass = 0;
const ok = (label, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + label);
};

ok('the telemetry skew covers the debounce Claude Code caches the headers for', () => {
  const debounce = Number(telemetry.HEADERS_REFRESH_MS);
  assert.ok(telemetry.TELEMETRY_REFRESH_SKEW_MS > debounce, `${telemetry.TELEMETRY_REFRESH_SKEW_MS} must exceed the ${debounce}ms debounce`);
  const written = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8')).env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS;
  assert.equal(Number(written), debounce, 'the skew is derived from the debounce enable() writes');
});

ok('otel shim: a token with 6 minutes left is refreshed before Claude Code caches it for 10', () => {
  seed(6 * MIN);
  const h = run(SHIM);
  assert.equal(calls(), 1, 'exactly one refresh call');
  assert.equal(h.Authorization, 'Bearer new');
  const o = readCredentials().enforcer.oauth;
  assert.equal(o.refresh_token, 'r2', 'the rotated refresh token is written back');
  assert.ok(Date.parse(o.expires_at) - Date.now() > Number(telemetry.HEADERS_REFRESH_MS), 'the served token outlives the cache');
});

ok('otel shim: a token that outlives the cache is served as is, no refresh call', () => {
  seed(14 * MIN);
  const h = run(SHIM);
  assert.equal(calls(), 0);
  assert.equal(h.Authorization, 'Bearer old');
});

ok('MCP headersHelper keeps the 60s skew: the same 6-minute token is not refreshed', () => {
  assert.equal(REFRESH_SKEW_MS, 60_000);
  seed(6 * MIN);
  const h = run(join(root, 'bin', 'enforcer-headers.mjs'));
  assert.equal(calls(), 0, 'no extra refresh on the MCP path');
  assert.equal(h.Authorization, 'Bearer old');
  assert.equal(readCredentials().enforcer.oauth.refresh_token, 'r1');
});

console.log(`\n  ${pass} passed, 0 failed\n  fail 0`);
