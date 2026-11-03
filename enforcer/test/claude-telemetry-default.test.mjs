// `node --test test/claude-telemetry-default.test.mjs`: Claude Code's own OTel export is on by default, like Codex's
// and Gemini's: written at sign-in and Claude Code session start while signed in, left alone when it is already ours
// or someone else's, and kept off once turned off. Every path below is a temp dir; nothing touches the real settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DOT } from '../hooks/claude/paths.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'cc-tel-'));
const settingsPath = join(home, DOT, 'settings.json');
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  ENFORCER_HOME: join(home, '.enforcer'),
  GOVERNOR_HOME: join(home, '.g'),
  CLAUDE_SETTINGS_PATH: settingsPath,
});
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.ENFORCER_API_KEY;
mkdirSync(join(home, DOT), { recursive: true });

const tel = await import('../lib/governor/adapters/claude-code/telemetry.mjs');
const { DEFAULTS } = await import('../lib/governor/core/policy.mjs');
const { claudeCodeTelemetryAfterSignIn } = await import('../bin/login.mjs');
const { removeClaudeExport } = await import('../src/logout-telemetry.mjs');

const cfg = { ...DEFAULTS, centralUrl: 'https://api.example.test' };
const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'));
const write = (s) => writeFileSync(settingsPath, JSON.stringify(s));
const signedIn = () => true;

test('the default is on', () => {
  assert.equal(DEFAULTS.telemetryOn, true);
});

test('ensure writes the export while signed in, keeps other settings, then is a no-op', () => {
  write({ model: 'opus', env: { FOO: '1' } });
  const r = tel.ensure(cfg, { signedIn, env: {} });
  assert.equal(r.changed, true);
  const s = read();
  assert.equal(s.model, 'opus');
  assert.equal(s.env.FOO, '1');
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://api.example.test/api/v1/governance/otlp');
  assert.match(s.otelHeadersHelper, /otel-headers\.mjs/);
  assert.ok(!JSON.stringify(s).match(/X-API-Key|Bearer/), 'no credential in settings');
  assert.deepEqual(tel.ensure(cfg, { signedIn, env: {} }), { skipped: 'already on' });
});

test('ensure removes prompt-exporting keys and rewrites a stale endpoint', () => {
  const s = read();
  s.env.OTEL_LOG_USER_PROMPTS = '1';
  write(s);
  assert.equal(tel.ensure(cfg, { signedIn, env: {} }).changed, true);
  assert.equal(Object.hasOwn(read().env, 'OTEL_LOG_USER_PROMPTS'), false);
  const r = tel.ensure({ ...cfg, centralUrl: 'https://api.other.test' }, { signedIn, env: {} });
  assert.equal(r.changed, true);
  assert.equal(read().env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://api.other.test/api/v1/governance/otlp');
});

test('ensure never takes over another exporter, never writes signed out, and respects telemetryOn off', () => {
  write({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.acme.test:4318' } });
  assert.match(tel.ensure(cfg, { signedIn, env: {} }).skipped, /^another exporter/);
  write({ otelHeadersHelper: '/usr/local/bin/my-headers' });
  assert.match(tel.ensure(cfg, { signedIn, env: {} }).skipped, /^another exporter/);
  write({});
  assert.match(tel.ensure(cfg, { signedIn, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' } }).skipped, /environment/);
  assert.deepEqual(tel.ensure(cfg, { signedIn: () => false, env: {} }), { skipped: 'not signed in' });
  assert.match(tel.ensure({ ...cfg, telemetryOn: false }, { signedIn, env: {} }).skipped, /turned off/);
  assert.match(tel.ensure({ ...cfg, telemetryOn: 'off' }, { signedIn, env: {} }).skipped, /turned off/);
  assert.deepEqual(read(), {}, 'nothing was written');
  writeFileSync(settingsPath, '{not json');
  assert.ok(tel.ensure(cfg, { signedIn, env: {} }).skipped, 'a malformed file is never overwritten');
  assert.equal(readFileSync(settingsPath, 'utf8'), '{not json');
});

test('sign-in prints one line when it wrote and one when another exporter blocks it', async () => {
  const on = await claudeCodeTelemetryAfterSignIn({ ensure: () => ({ changed: true, endpoint: 'https://x/api/v1/governance/otlp' }) });
  assert.match(on[0], /^Claude Code telemetry: on, to https:\/\/x\/api\/v1\/governance\/otlp .*enforcer governor telemetry off$/);
  const other = await claudeCodeTelemetryAfterSignIn({ ensure: () => ({ skipped: `another exporter (${settingsPath})` }) });
  assert.match(other[0], /left off, another exporter is configured/);
  assert.deepEqual(await claudeCodeTelemetryAfterSignIn({ ensure: () => ({ skipped: 'turned off (telemetryOn)' }) }), []);
  assert.deepEqual(await claudeCodeTelemetryAfterSignIn({ ensure: () => ({ skipped: 'already on' }) }), []);
});

test('sign-out removes our export only, and records no opt-out', async () => {
  write({ model: 'opus' });
  tel.enable(cfg);
  assert.match(await removeClaudeExport(), /removed the telemetry export settings/);
  assert.deepEqual(read(), { model: 'opus' });
  write({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.acme.test:4318', CLAUDE_CODE_ENABLE_TELEMETRY: '1' } });
  assert.equal(await removeClaudeExport(), null, 'someone else’s exporter is left alone');
  assert.equal(existsSync(join(process.env.GOVERNOR_HOME, 'config.json')), false);
});

test('telemetry off is sticky; telemetry on clears it', () => {
  write({});
  const run = (arg) =>
    spawnSync(process.execPath, [join(ROOT, 'lib/governor/bin/telemetry.mjs'), arg], { env: { ...process.env, CLAUDECODE: '' }, encoding: 'utf8' });
  assert.match(run('off').stdout, /session starts will not add them back/);
  const conf = JSON.parse(readFileSync(join(process.env.GOVERNOR_HOME, 'config.json'), 'utf8'));
  assert.equal(conf.telemetryOn, false);
  assert.match(run('status').stdout, /Claude Code telemetry: off \(telemetryOn\)/);
  assert.match(run('on').stdout, /Telemetry on/);
  assert.equal(JSON.parse(readFileSync(join(process.env.GOVERNOR_HOME, 'config.json'), 'utf8')).telemetryOn, true);
  assert.match(run('status').stdout, /Claude Code telemetry: on, exporting to/);
});
