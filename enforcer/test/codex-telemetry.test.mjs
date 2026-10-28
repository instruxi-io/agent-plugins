// Codex's OTel export to governance (lib/governor/adapters/codex/telemetry.mjs): the [otel] keys it writes,
// that it leaves the rest of config.toml alone, the key's file mode, on-by-default at session start and the
// way to turn it off. ensureIngestKey (src/ingest-key.mjs, workstream K) is always mocked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyOtel,
  removeOtel,
  readOtel,
  enable,
  disable,
  status,
  ensure,
  pluginInstalled,
  statements,
  LOGS_PATH,
  METRICS_PATH,
} from '../lib/governor/adapters/codex/telemetry.mjs';

const ORIGIN = 'https://api.example.test';
const bin = fileURLToPath(new URL('../bin/enforcer', import.meta.url));

// A config.toml shaped like a real one (Codex 0.164 writes these tables), plus the awkward parts:
// a multi-line string and a nested array holding lines that start with `[`.
const USER = `# my codex config
model = "gpt-5-codex" # inline comment

notes = """
[not.a.table]
still the string
"""
matrix = [
  ["a", "b"],
  ["c"]
]

[marketplaces.instruxi]
source_type = "git"
source = "https://github.com/instruxi-io/agent-plugins.git"

[plugins."enforcer@instruxi"]
enabled = true

[hooks.state."enforcer@instruxi:hooks/codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:abc/sha256:def"

[projects."/tmp/cx"]
trust_level = "trusted"
`;

const ownedValues = (text) => {
  const r = readOtel(text);
  return { logs: r.logs, metrics: r.metrics, metricsKind: r.metricsKind, key: r.key };
};

test('applyOtel appends an [otel] table with full signal paths, otlp metrics, traces off and no prompt export', () => {
  const out = applyOtel(USER, { origin: ORIGIN, key: 'ik_one' });
  assert.ok(out.startsWith(USER.trimEnd()), 'the user config is kept byte for byte, ours comes after it');
  assert.deepEqual(ownedValues(out), { logs: ORIGIN + LOGS_PATH, metrics: ORIGIN + METRICS_PATH, metricsKind: 'otlp-http', key: true });
  assert.equal(LOGS_PATH, '/api/v1/governance/otlp/v1/logs');
  assert.equal(METRICS_PATH, '/api/v1/governance/otlp/v1/metrics');
  assert.match(out, /^trace_exporter = "none"$/m);
  assert.match(out, /^log_user_prompt = false$/m);
  assert.match(out, /^log_agent_responses = false$/m);
  assert.match(out, /^tool_result = \{ max_bytes = 0 \}$/m);
  assert.match(out, /protocol = "binary", headers = \{ "X-API-Key" = "ik_one" \}/);
  assert.equal((out.match(/^\[otel\]$/gm) || []).length, 1);
});

test('the multi-line string and the nested array are not read as tables', () => {
  const heads = statements(USER)
    .filter((s) => s.kind === 'header')
    .map((s) => s.path.join('.'));
  assert.deepEqual(heads, [
    'marketplaces.instruxi',
    'plugins.enforcer@instruxi',
    'hooks.state.enforcer@instruxi:hooks/codex/hooks.json:pre_tool_use:0:0',
    'projects./tmp/cx',
  ]);
});

test('applyOtel is idempotent, a rotated key replaces the old one, and removeOtel restores the original', () => {
  const once = applyOtel(USER, { origin: ORIGIN, key: 'ik_one' });
  assert.equal(applyOtel(once, { origin: ORIGIN, key: 'ik_one' }), once);
  const rotated = applyOtel(once, { origin: ORIGIN, key: 'ik_two' });
  assert.doesNotMatch(rotated, /ik_one/);
  assert.match(rotated, /ik_two/);
  assert.equal(removeOtel(rotated), USER);
});

test("an existing [otel] table keeps the user's other keys and comments; clashing keys and sub-tables go", () => {
  const withOtel = `${USER}
[otel]
# keep this comment
environment = "prod"
log_user_prompt = true
metrics_exporter = "statsig"

[otel.exporter.otlp-http]
endpoint = "https://collector.example/v1/logs"
protocol = "json"

[otel.exporter.otlp-http.headers]
"x-old" = "1"

[otel.span_attributes]
"team" = "core"

[tui]
theme = "dark"
`;
  const out = applyOtel(withOtel, { origin: ORIGIN, key: 'ik_one' });
  assert.match(out, /^# keep this comment$/m);
  assert.match(out, /^environment = "prod"$/m);
  assert.match(out, /^\[otel\.span_attributes\]\n"team" = "core"$/m);
  assert.match(out, /^\[tui\]\ntheme = "dark"$/m);
  assert.doesNotMatch(out, /collector\.example|x-old|statsig|log_user_prompt = true/);
  assert.doesNotMatch(out, /^\[otel\.exporter/m);
  assert.deepEqual(ownedValues(out), { logs: ORIGIN + LOGS_PATH, metrics: ORIGIN + METRICS_PATH, metricsKind: 'otlp-http', key: true });
  // off keeps the user's [otel] table (environment, comment, span_attributes) and drops only ours
  const off = removeOtel(out);
  assert.match(off, /^\[otel\]\n# keep this comment\nenvironment = "prod"$/m);
  assert.doesNotMatch(off, /exporter|ik_one|log_user_prompt/);
});

test('a file that sets otel at the top level is refused, not rewritten', () => {
  assert.throws(() => applyOtel('otel.exporter = "none"\n', { origin: ORIGIN, key: 'k' }), /top level/);
  assert.throws(() => applyOtel('otel = { exporter = "none" }\n[tui]\n', { origin: ORIGIN, key: 'k' }), /top level/);
});

function codexHome(text, mode = 0o644) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  if (text !== undefined) {
    writeFileSync(join(dir, 'config.toml'), text);
    chmodSync(join(dir, 'config.toml'), mode);
  }
  return { dir, file: join(dir, 'config.toml'), env: { ...process.env, CODEX_HOME: dir } };
}

test('enable asks for the codex ingest key, writes it 0600 and status reports it without the key', async () => {
  const h = codexHome(USER, 0o644);
  const asked = [];
  const r = await enable({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: async (o) => (asked.push(o), { key: 'ik_secret_1', source: 'minted' }) });
  assert.deepEqual(asked, [{ harness: 'codex' }]);
  assert.equal(r.changed, true);
  assert.equal(statSync(h.file).mode & 0o777, 0o600);
  const s = status({}, { env: h.env });
  assert.equal(s.on, true);
  assert.equal(s.logs, ORIGIN + LOGS_PATH);
  assert.doesNotMatch(JSON.stringify(s), /ik_secret_1/);
  // the pre-Enforcer original is kept once, 0600
  assert.equal(readFileSync(h.file + '.enforcer-backup', 'utf8'), USER);
  assert.equal(statSync(h.file + '.enforcer-backup').mode & 0o777, 0o600);
  // a cached key changes nothing on disk
  const again = await enable({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: async () => ({ key: 'ik_secret_1', source: 'cache' }) });
  assert.equal(again.changed, false);
});

test('CODEX_HOME is respected, and a missing config.toml is created 0600', async () => {
  const h = codexHome(undefined);
  await enable({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: async () => ({ key: 'k1' }) });
  assert.equal(statSync(h.file).mode & 0o777, 0o600);
  assert.match(readFileSync(h.file, 'utf8'), /^\[otel\]\n/);
});

test('ensure fails open: off, signed out or no key leaves the file as it was', async () => {
  const h = codexHome(USER);
  const key = async () => ({ key: 'k1' });
  assert.match((await ensure({ codexTelemetry: false, centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: key })).skipped, /turned off/);
  assert.match((await ensure({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: key, signedIn: () => false })).skipped, /not signed in/);
  const failing = async () => {
    throw Object.assign(new Error('agent is disabled'), { code: 'agent_disabled' });
  };
  assert.match((await ensure({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: failing })).skipped, /agent is disabled/);
  const hanging = () => new Promise(() => {});
  assert.match((await ensure({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: hanging, timeoutMs: 50 })).skipped, /no ingest key/);
  assert.equal(readFileSync(h.file, 'utf8'), USER);
  // and once on, a later failure keeps the last key
  await ensure({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: key });
  await ensure({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: failing });
  assert.match(readFileSync(h.file, 'utf8'), /"X-API-Key" = "k1"/);
});

test('disable removes exactly what enable wrote', async () => {
  const h = codexHome(USER);
  await enable({ centralUrl: ORIGIN }, { env: h.env, ensureIngestKey: async () => ({ key: 'k1' }) });
  assert.equal(disable({ env: h.env }).changed, true);
  assert.equal(readFileSync(h.file, 'utf8'), USER);
  assert.equal(status({}, { env: h.env }).on, false);
});

test('pluginInstalled reads [plugins."enforcer@..."] enabled', () => {
  assert.equal(pluginInstalled({ env: codexHome(USER).env }), true);
  assert.equal(pluginInstalled({ env: codexHome(USER.replace('enabled = true', 'enabled = false')).env }), false);
  assert.equal(pluginInstalled({ env: codexHome(undefined).env }), false);
});

// The hook and the CLI, end to end in a subprocess. The ingest-key module is swapped for a fake by a
// resolve hook, so this never needs K's module or a network.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'codex-otel-e2e-'));
  const home = join(root, 'home');
  const codex = join(root, 'codex');
  mkdirSync(home, { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'config.toml'), USER);
  const fake = join(root, 'fake-ingest-key.mjs');
  writeFileSync(fake, "export async function ensureIngestKey({ harness }) { return { key: 'ik_fake_' + harness, source: 'minted' }; }\n");
  const hooks = join(root, 'hooks.mjs');
  writeFileSync(
    hooks,
    `export async function resolve(s, c, next) { if (s.endsWith('/src/ingest-key.mjs')) return { url: ${JSON.stringify(pathToFileURL(fake).href)}, shortCircuit: true }; return next(s, c); }\n`,
  );
  const reg = join(root, 'register.mjs');
  writeFileSync(reg, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codex,
    ENFORCER_HOME: join(home, '.enforcer'),
    ENFORCER_CONFIG_HOME: join(home, 'cfg'),
    GOVERNOR_HOME: join(home, 'gov'),
    ENFORCER_API_KEY: 'test-signed-in',
    // bin/enforcer runs the telemetry command in a child process: NODE_OPTIONS carries the fake to it
    NODE_OPTIONS: `--import=${pathToFileURL(reg).href}`,
  };
  // the governor's origin for telemetry; an unroutable one, so nothing here can reach a network
  mkdirSync(join(home, 'gov'), { recursive: true });
  writeFileSync(join(home, 'gov', 'config.json'), JSON.stringify({ ingestUrl: 'http://127.0.0.1:9' }));
  const run = (args, input = '') => spawnSync(process.execPath, [bin, ...args], { env, input, encoding: 'utf8', timeout: 30_000 });
  const sessionStart = (harness) =>
    run(
      ['event', 'session-start', ...(harness ? ['--harness', harness] : [])],
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1', cwd: root, source: 'startup' }),
    );
  return { config: join(codex, 'config.toml'), run, sessionStart };
}

test('a Codex session start turns it on by default; a Claude Code one does not touch Codex', () => {
  const s = sandbox();
  const claude = s.sessionStart(null);
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(readFileSync(s.config, 'utf8'), USER, 'control: a Claude Code session start leaves config.toml alone');
  const r = s.sessionStart('codex');
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(s.config, 'utf8');
  assert.match(text, /"X-API-Key" = "ik_fake_codex"/);
  assert.equal(statSync(s.config).mode & 0o777, 0o600);
  assert.match(
    s.run(['governor', 'telemetry', 'codex', 'status']).stdout,
    /Codex telemetry: on, exporting events to http:\/\/127\.0\.0\.1:9\/api\/v1\/governance\/otlp\/v1\/logs/,
  );
});

test('telemetry codex off removes it and keeps it off across session starts; on brings it back', () => {
  const s = sandbox();
  s.sessionStart('codex');
  const off = s.run(['governor', 'telemetry', 'codex', 'off']);
  assert.match(off.stdout, /Codex telemetry off/);
  assert.equal(readFileSync(s.config, 'utf8'), USER);
  s.sessionStart('codex');
  assert.equal(readFileSync(s.config, 'utf8'), USER, 'a session start after off does not write it back');
  assert.match(s.run(['governor', 'telemetry', 'status']).stdout, /Codex telemetry: off \(codexTelemetry\)/);
  const on = s.run(['governor', 'telemetry', 'codex', 'on']);
  assert.match(on.stdout, /Codex telemetry on/, on.stdout + on.stderr);
  assert.match(readFileSync(s.config, 'utf8'), /ik_fake_codex/);
  assert.equal(existsSync(s.config + '.enforcer-backup'), true);
});

test('sign-in turns it on only where the Enforcer plugin is installed in Codex', async () => {
  const { codexTelemetryAfterSignIn } = await import('../bin/login.mjs');
  let called = 0;
  const ok = async () => (called++, { changed: true, logs: ORIGIN + LOGS_PATH });
  assert.deepEqual(await codexTelemetryAfterSignIn({ installed: () => false, ensure: ok }), []);
  assert.equal(called, 0, 'no Codex plugin: nothing written');
  const lines = await codexTelemetryAfterSignIn({ installed: () => true, ensure: ok });
  assert.equal(called, 1);
  assert.match(lines[0], /Codex telemetry: on, to https:\/\/api\.example\.test\/api\/v1\/governance\/otlp .*telemetry codex off/);
  assert.deepEqual(await codexTelemetryAfterSignIn({ installed: () => true, ensure: async () => ({ skipped: 'turned off (codexTelemetry)' }) }), []);
  assert.match((await codexTelemetryAfterSignIn({ installed: () => true, ensure: async () => ({ skipped: 'signed_out' }) }))[0], /not set up \(signed_out\)/);
});
