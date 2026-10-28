// The OpenClaw entry and src/openclaw.mjs: keep diagnostics-otel pointed at Enforcer governance with the ingest key.
// OpenClaw itself is faked (its config file as an object, mutateConfigFile as a draft-and-commit); the key comes from
// a stub in place of ensureIngestKey (workstream K's module), so nothing here signs in or reaches v3.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'openclaw-'));
const { sync, desiredOtel, owner, disable, settings, statusText, readStatus, EXPORTER_PLUGIN } = await import('../src/openclaw.mjs');
const { createEntry } = await import('../harness/openclaw/index.mjs');

let pass = 0;
const t = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};

const OTLP = 'https://api.example.test/api/v1/governance/otlp';
const KEY1 = 'ag_ingest_one';
const KEY2 = 'ag_ingest_two';
const quiet = { info() {}, warn() {} };

/** OpenClaw's config file, and the runtime snapshot it serves (header values redacted, as the real one does). */
function fakeOpenClaw(initial = {}, { path = null } = {}) {
  const s = { file: structuredClone(initial), writes: 0 };
  const redact = (c) => {
    const r = structuredClone(c);
    const h = r?.diagnostics?.otel?.headers;
    if (h) for (const k of Object.keys(h)) h[k] = '***';
    return r;
  };
  s.current = () => redact(s.file);
  s.mutate = async (fn) => {
    const draft = structuredClone(s.file);
    await fn(draft); // a throw leaves the file as it was
    s.file = draft;
    s.writes++;
    if (path) writeFileSync(path, JSON.stringify(draft));
    return { path };
  };
  return s;
}

const keyStub = (key = KEY1, source = 'cache') => {
  const st = { calls: 0, key, source };
  st.fn = async () => {
    st.calls++;
    return { key: st.key, credentialId: 'cred-1', agentId: 'agent-1', expiresAt: '2026-12-01T00:00:00Z', source: st.source };
  };
  return st;
};
const failingKey =
  (code, message = code) =>
  async () => {
    const e = new Error(message);
    /** @type {any} */ (e).code = code;
    throw e;
  };

let n = 0;
const run = (oc, { pluginConfig = {}, ensureKey = keyStub().fn, statusFile = join(dir, `status-${++n}.json`) } = {}) =>
  sync({ pluginConfig, current: oc.current, mutate: oc.mutate, ensureKey, otlpBase: () => OTLP, log: quiet, statusFile });

await t('the block it writes: metrics only, exact governance URLs, the key header, no traces, no content', async () => {
  const d = desiredOtel({ otlpBase: `${OTLP}/`, key: KEY1 });
  assert.deepEqual(d, {
    enabled: true,
    protocol: 'http/protobuf',
    metricsEndpoint: `${OTLP}/v1/metrics`,
    headers: { 'X-API-Key': KEY1 },
    serviceName: 'openclaw',
    traces: false,
    metrics: true,
    logs: false,
    captureContent: false,
  });
  const withLogs = desiredOtel({ otlpBase: OTLP, key: KEY1, logs: true });
  assert.equal(withLogs.logsEndpoint, `${OTLP}/v1/logs`);
  assert.equal(withLogs.logs, true);
  assert.equal(withLogs.captureContent, false);
  assert.deepEqual(settings(undefined), { telemetry: true, logs: false }, 'on by default, logs off by default');
  assert.deepEqual(settings({ telemetry: false, telemetryLogs: true }), { telemetry: false, logs: true });
});

await t('a fresh config: writes the block, enables diagnostics-otel, and records a status with no key in it', async () => {
  const oc = fakeOpenClaw({ plugins: { entries: { other: { enabled: true } } } });
  const statusFile = join(dir, 'fresh-status.json');
  const st = await run(oc, { statusFile });
  assert.equal(st.state, 'on');
  assert.equal(st.wrote, true);
  assert.equal(oc.file.diagnostics.enabled, true);
  assert.equal(oc.file.diagnostics.otel.headers['X-API-Key'], KEY1);
  assert.equal(oc.file.plugins.entries[EXPORTER_PLUGIN].enabled, true);
  assert.equal(oc.file.plugins.entries.other.enabled, true, 'other plugin entries are kept');
  const raw = readFileSync(statusFile, 'utf8');
  assert.ok(!raw.includes(KEY1), 'the status file never holds the key');
  if (process.platform !== 'win32') assert.equal(statSync(statusFile).mode & 0o777, 0o600);
  assert.equal(readStatus(statusFile).credentialId, 'cred-1');
  assert.match(statusText(readStatus(statusFile)), /on: metrics go to Enforcer governance/);
});

await t('already applied: no write, even though the runtime snapshot redacts the header (no reload loop)', async () => {
  const oc = fakeOpenClaw();
  await run(oc);
  assert.equal(oc.writes, 1);
  assert.equal(oc.current().diagnostics.otel.headers['X-API-Key'], '***');
  // OpenClaw's writer reorders keys when it round-trips the block
  const o = oc.file.diagnostics.otel;
  oc.file.diagnostics.otel = Object.fromEntries(Object.entries(o).reverse());
  const st = await run(oc);
  assert.equal(st.wrote, false);
  assert.equal(oc.writes, 1, 'an unchanged block is not rewritten');
});

await t('a rotated key is written back', async () => {
  const oc = fakeOpenClaw();
  const k = keyStub(KEY1);
  await run(oc, { ensureKey: k.fn });
  k.key = KEY2;
  k.source = 'rotated';
  const st = await run(oc, { ensureKey: k.fn });
  assert.equal(st.wrote, true);
  assert.equal(oc.file.diagnostics.otel.headers['X-API-Key'], KEY2);
});

await t("someone else's collector is left alone and never handed a key", async () => {
  const theirs = { diagnostics: { enabled: true, otel: { enabled: true, endpoint: 'http://collector:4318', headers: { 'x-token': 'theirs' } } } };
  const oc = fakeOpenClaw(theirs);
  const k = keyStub();
  const st = await run(oc, { ensureKey: k.fn });
  assert.equal(st.state, 'foreign');
  assert.equal(k.calls, 0, 'no key minted for a block we will not write');
  assert.deepEqual(oc.file, theirs);
  assert.equal(oc.writes, 0);
  // and our own block on another origin is still ours (a base-URL change rewrites it)
  assert.equal(owner({ diagnostics: { otel: { metricsEndpoint: 'https://old.example/api/v1/governance/otlp/v1/metrics' } } }), 'ours');
  assert.equal(owner({ diagnostics: { otel: { metricsEndpoint: `${OTLP}/v1/metrics`, tracesEndpoint: 'http://jaeger:4318/v1/traces' } } }), 'foreign');
  assert.equal(owner({ diagnostics: { otel: { enabled: false } } }), 'absent');
});

await t('plugins.allow, when the person keeps one, gains diagnostics-otel', async () => {
  const oc = fakeOpenClaw({ plugins: { allow: ['enforcer'] } });
  await run(oc);
  assert.deepEqual(oc.file.plugins.allow, ['enforcer', EXPORTER_PLUGIN]);
});

await t('telemetry=false removes our block, and only ours', async () => {
  const oc = fakeOpenClaw();
  await run(oc);
  const st = await run(oc, { pluginConfig: { telemetry: false } });
  assert.equal(st.state, 'off');
  assert.equal(oc.file.diagnostics.otel, undefined);
  const theirs = fakeOpenClaw({ diagnostics: { otel: { endpoint: 'http://collector:4318' } } });
  await run(theirs, { pluginConfig: { telemetry: false } });
  assert.equal(theirs.file.diagnostics.otel.endpoint, 'http://collector:4318');
  assert.equal(theirs.writes, 0);
  // disable() on its own refuses a foreign block too
  const foreignCfg = { diagnostics: { otel: { endpoint: 'http://collector:4318' } } };
  assert.deepEqual(disable(structuredClone(foreignCfg)), foreignCfg);
});

await t('a disabled agent in the console turns it off; signed out or v3 down leaves OpenClaw untouched and never throws', async () => {
  const oc = fakeOpenClaw();
  await run(oc);
  const off = await run(oc, { ensureKey: failingKey('agent_disabled', 'disabled in the console') });
  assert.equal(off.state, 'agent_disabled');
  assert.equal(oc.file.diagnostics.otel, undefined);

  const oc2 = fakeOpenClaw();
  await run(oc2);
  const before = structuredClone(oc2.file);
  const out = await run(oc2, { ensureKey: failingKey('signed_out') });
  assert.equal(out.state, 'signed_out');
  assert.deepEqual(oc2.file, before, 'a key still in the file keeps working until it expires');
  const down = await run(oc2, { ensureKey: failingKey('api', 'v3 503') });
  assert.equal(down.state, 'error');
  const bare = await run(fakeOpenClaw(), { ensureKey: async () => Promise.reject(new TypeError('fetch failed')) });
  assert.equal(bare.state, 'error');
});

await t('the config file that holds the key is made 0600 if it was not', async () => {
  const path = join(dir, 'openclaw.json');
  writeFileSync(path, '{}');
  chmodSync(path, 0o644);
  const oc = fakeOpenClaw({}, { path });
  await run(oc);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

await t('the entry: a full load registers one scheduled service; discovery loads start nothing', async () => {
  const k = keyStub();
  const entry = createEntry({ ensureKey: k.fn, otlpBase: () => OTLP, recheckMs: 1234 });
  assert.equal(entry.id, 'enforcer');
  const oc = fakeOpenClaw();
  const services = [];
  const api = (mode) => ({
    registrationMode: mode,
    pluginConfig: {},
    logger: quiet,
    runtime: {
      config: { current: oc.current, mutateConfigFile: ({ mutate, afterWrite }) => (assert.deepEqual(afterWrite, { mode: 'auto' }), oc.mutate(mutate)) },
    },
    registerService: (s) => services.push(s),
    on() {},
  });
  entry.register(api('discovery'));
  assert.equal(services.length, 0);
  entry.register(api('full'));
  assert.equal(services.length, 1);
  assert.equal(services[0].apiVersion, 2);
  const jobs = [];
  services[0].start({ scheduler: { schedule: (j) => jobs.push(j) } });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].everyMs, 1234);
  assert.equal(jobs[0].delayMs, 0);
  await jobs[0].run();
  assert.equal(oc.file.diagnostics.otel.headers['X-API-Key'], KEY1);
  // a check that throws is logged, never rethrown into the host scheduler
  const bad = createEntry({ ensureKey: k.fn, otlpBase: () => OTLP });
  const s2 = [];
  bad.register({
    ...api('full'),
    runtime: { config: { current: () => ({}), mutateConfigFile: async () => Promise.reject(new Error('locked')) } },
    registerService: (s) => s2.push(s),
  });
  const j2 = [];
  s2[0].start({ scheduler: { schedule: (j) => j2.push(j) } });
  await j2[0].run();
});

await t('the manifests agree with each other and with the shared MCP config', async () => {
  const man = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const mcp = JSON.parse(readFileSync(join(ROOT, 'mcp.json'), 'utf8'));
  assert.equal(man.id, createEntry().id);
  for (const ext of pkg.openclaw.extensions) assert.ok(existsSync(join(ROOT, ext)), `${ext} exists`);
  assert.ok(pkg.files.includes('openclaw.plugin.json'), 'the manifest ships in the npm package');
  assert.equal(man.mcpServers.enforcer.url, mcp.mcpServers.enforcer.url);
  assert.equal(man.mcpServers.enforcer.transport, 'streamable-http');
  assert.deepEqual(Object.keys(man.configSchema.properties).sort(), ['telemetry', 'telemetryLogs']);
  assert.equal(man.configSchema.properties.telemetry.default, true);
  for (const s of man.skills) assert.ok(existsSync(join(ROOT, s)), `${s} exists`);
});

console.log(`openclaw: ${pass} passed`);
