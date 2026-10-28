// Gemini CLI telemetry (src/gemini-telemetry.mjs): what enable/disable write into <gemini home>/.gemini,
// that they keep everything else, the opt-out, and the extension's hook and manifest. ingest-key.mjs
// (workstream K) is faked: these tests never mint a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, HARNESS, disable, enable, envPath, findEnvFile, onLogin, settingsPath, status } from '../src/gemini-telemetry.mjs';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const repo = join(pkg, '..');
const BASE = 'https://enforcer.example';
const ENDPOINT = `${BASE}/api/v1/governance/otlp`;

function fake(keys = ['ek_gemini_one']) {
  const calls = [];
  return {
    calls,
    ingest: {
      OTLP_BASE: (b) => `${b.replace(/\/+$/, '')}/api/v1/governance/otlp`,
      ensureIngestKey: async (a) => {
        calls.push(a);
        const key = keys[Math.min(calls.length - 1, keys.length - 1)];
        return { key, credentialId: 'cred-1', agentId: 'agent-1', expiresAt: '2027-01-01T00:00:00Z', source: calls.length === 1 ? 'minted' : 'cache' };
      },
    },
  };
}

function box() {
  const home = mkdtempSync(join(tmpdir(), 'gem-home-'));
  const shared = join(home, '.enforcer');
  const env = { HOME: home };
  return { home, shared, env, o: { env, home, shared, baseUrl: BASE } };
}

// The variables Gemini would load from a dotenv file (quotes stripped, comments skipped).
const dotenv = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, '$1')];
      }),
  );
const mode = (p) => statSync(p).mode & 0o777;
const read = (p) => readFileSync(p, 'utf8');

test('enable: key, switch and content limits in .env (0600); endpoint in settings.json; everything else kept', async () => {
  const { home, o, env } = box();
  const dir = join(home, '.gemini');
  mkdirSync(dir);
  const settings = {
    ui: { theme: 'Ayu' },
    mcpServers: { enforcer: { url: 'https://api.instruxi.dev/mcp', type: 'http' } },
    telemetry: { enabled: true, outfile: '/tmp/t.log', useCollector: false },
  };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  chmodSync(join(dir, 'settings.json'), 0o664);
  writeFileSync(join(dir, '.env'), 'GEMINI_API_KEY=theirs\n# a comment\n');
  chmodSync(join(dir, '.env'), 0o644);
  const f = fake();

  const r = await enable({ ...o, ingest: f.ingest });
  assert.deepEqual(f.calls, [{ harness: 'gemini-cli' }], 'one key, for the gemini-cli harness');
  assert.equal(HARNESS, 'gemini-cli');
  assert.equal(r.endpoint, ENDPOINT);
  assert.deepEqual(r.removed.sort(), ['enabled', 'outfile', 'useCollector']);

  const s = JSON.parse(read(settingsPath(o)));
  assert.deepEqual(s.ui, settings.ui);
  assert.deepEqual(s.mcpServers, settings.mcpServers);
  assert.deepEqual(s.telemetry, { target: 'local', otlpProtocol: 'http', logPrompts: false, otlpEndpoint: ENDPOINT });
  assert.equal(Object.hasOwn(s.telemetry, 'enabled'), false, 'settings alone never switch export on');
  assert.equal(mode(settingsPath(o)), 0o664, 'settings.json keeps its mode');
  assert.equal(read(settingsPath(o) + '.enforcer-backup'), JSON.stringify(settings), 'their settings backed up');

  const text = read(envPath(o));
  if (process.platform !== 'win32') assert.equal(mode(envPath(o)), 0o600, '.env holds a secret: 0600, though it was 0644');
  assert.match(text, /^GEMINI_API_KEY=theirs\n# a comment\n/, 'their lines kept, first');
  const v = dotenv(text);
  assert.equal(v.GEMINI_API_KEY, 'theirs');
  assert.equal(v.OTEL_EXPORTER_OTLP_HEADERS, 'X-API-Key=ek_gemini_one');
  assert.equal(v.GEMINI_TELEMETRY_ENABLED, 'true');
  assert.equal(v.GEMINI_TELEMETRY_OTLP_ENDPOINT, ENDPOINT);
  assert.equal(v.GEMINI_TELEMETRY_OTLP_PROTOCOL, 'http', 'Gemini defaults to grpc');
  assert.equal(v.GEMINI_TELEMETRY_LOG_PROMPTS, 'false');
  assert.equal(v.OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT, '48');
  assert.ok(!v.OTEL_NODE_RESOURCE_DETECTORS.split(',').includes('process'), 'no process detector: argv carries `gemini -p` prompts');
  assert.equal(v.OTEL_TRACES_SAMPLER, 'always_off');
  assert.equal(status({ env, home, shared: o.shared, cwd: home }).on, true);
});

test('enable is idempotent and rewrites the key in place when it rotates', async () => {
  const { o } = box();
  mkdirSync(join(o.home, '.gemini'));
  const f = fake(['ek_one', 'ek_one', 'ek_two']);
  assert.equal((await enable({ ...o, ingest: f.ingest })).changed, true);
  const first = read(envPath(o));
  assert.equal((await enable({ ...o, ingest: f.ingest })).changed, false, 'same key: nothing rewritten');
  assert.equal(read(envPath(o)), first);
  await enable({ ...o, ingest: f.ingest });
  const text = read(envPath(o));
  assert.equal(text.split(BEGIN).length, 2, 'one block');
  assert.equal(dotenv(text).OTEL_EXPORTER_OTLP_HEADERS, 'X-API-Key=ek_two');
});

test('off removes exactly what on wrote and sticks: login and the hook leave it off, `on` resumes', async () => {
  const { o, home } = box();
  const dir = join(home, '.gemini');
  mkdirSync(dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ui: { theme: 'Ayu' }, telemetry: { logPrompts: true } }));
  writeFileSync(join(dir, '.env'), 'GEMINI_API_KEY=theirs\n');
  const f = fake();
  await enable({ ...o, ingest: f.ingest });
  const r = disable(o);
  assert.equal(r.changed, true);
  assert.equal(read(envPath(o)), 'GEMINI_API_KEY=theirs\n');
  assert.deepEqual(JSON.parse(read(settingsPath(o))), { ui: { theme: 'Ayu' } }, 'their telemetry.logPrompts was replaced by ours (false), so it goes too');

  const before = read(envPath(o));
  const skipped = await enable({ ...o, ingest: f.ingest });
  assert.equal(skipped.skipped, 'off');
  assert.equal(f.calls.length, 1, 'no key asked for while off');
  assert.equal(read(envPath(o)), before);
  assert.deepEqual(await onLogin({ ...o, ingest: f.ingest }), [], 'sign-in leaves it off');
  assert.equal(status({ ...o, cwd: home }).optedOut, true);

  await enable({ ...o, ingest: f.ingest, explicit: true });
  assert.equal(dotenv(read(envPath(o))).GEMINI_TELEMETRY_ENABLED, 'true');
  assert.equal(status({ ...o, cwd: home }).optedOut, false);
});

test('an .env holding only our block is removed on off', async () => {
  const { o } = box();
  mkdirSync(join(o.home, '.gemini'));
  await enable({ ...o, ingest: fake().ingest });
  disable(o);
  assert.equal(existsSync(envPath(o)), false);
});

test('GEMINI_CLI_HOME moves the files', async () => {
  const { o } = box();
  const gh = mkdtempSync(join(tmpdir(), 'gem-cli-home-'));
  mkdirSync(join(gh, '.gemini'));
  const env = { ...o.env, GEMINI_CLI_HOME: gh };
  await enable({ ...o, env, ingest: fake().ingest });
  assert.ok(existsSync(join(gh, '.gemini', '.env')));
  assert.equal(existsSync(join(o.home, '.gemini')), false);
});

test('refuses, writing nothing: a key an OTLP header cannot carry, and unreadable settings.json', async () => {
  const { o, home } = box();
  const dir = join(home, '.gemini');
  mkdirSync(dir);
  await assert.rejects(enable({ ...o, ingest: fake(['ek,"x\nEVIL=1']).ingest }), /header cannot carry/);
  assert.equal(existsSync(envPath(o)), false);
  assert.equal(existsSync(settingsPath(o)), false);
  writeFileSync(join(dir, 'settings.json'), '{ not json');
  await assert.rejects(enable({ ...o, ingest: fake().ingest }));
  assert.equal(read(join(dir, 'settings.json')), '{ not json');
  assert.equal(existsSync(envPath(o)), false);
});

test("status: Gemini's .env lookup, and the directories where a project .env shadows ours", async () => {
  const { o, home } = box();
  mkdirSync(join(home, '.gemini'));
  await enable({ ...o, ingest: fake().ingest });
  const plain = join(home, 'work', 'a');
  mkdirSync(plain, { recursive: true });
  assert.equal(findEnvFile(plain, o), envPath(o), 'walks up to ~/.gemini/.env');
  assert.equal(status({ ...o, cwd: plain }).shadowedBy, null);
  const proj = join(home, 'proj', 'sub');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, 'proj', '.env'), 'X=1\n');
  assert.equal(status({ ...o, cwd: proj }).shadowedBy, join(home, 'proj', '.env'));
  mkdirSync(join(home, 'proj', 'sub', '.gemini'));
  writeFileSync(join(home, 'proj', 'sub', '.gemini', '.env'), 'Y=1\n');
  assert.equal(findEnvFile(proj, o), join(proj, '.gemini', '.env'), '.gemini/.env before .env, nearest first');
  assert.deepEqual(status({ ...o, env: { ...o.env, OTEL_EXPORTER_OTLP_HEADERS: 'x=y' }, cwd: plain }).overridden, ['OTEL_EXPORTER_OTLP_HEADERS']);
});

test('sign-in does nothing where Gemini CLI has never run', async () => {
  const { o, home } = box();
  const f = fake();
  assert.deepEqual(await onLogin({ ...o, ingest: f.ingest }), []);
  assert.equal(existsSync(join(home, '.gemini')), false);
  assert.equal(f.calls.length, 0);
  const lines = await onLogin({
    ...o,
    ingest: { ...f.ingest, ensureIngestKey: async () => Promise.reject(new Error('not signed in')) },
    home: (mkdirSync(join(home, '.gemini')), home),
  });
  assert.deepEqual(lines, ['Gemini CLI telemetry not set up: not signed in']);
});

test('the SessionStart hook answers `{}` and exits 0 even when it cannot set anything up', () => {
  const home = mkdtempSync(join(tmpdir(), 'gem-hook-'));
  mkdirSync(join(home, '.gemini'));
  const { GEMINI_CLI_HOME: _g, ENFORCER_HOME: _e, ENFORCER_API_KEY: _k, ...env } = process.env;
  const r = spawnSync(process.execPath, [join(pkg, 'bin', 'enforcer'), 'gemini', 'session-start'], {
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: home }),
    env: { ...env, HOME: home, ENFORCER_BASE_URL: 'http://127.0.0.1:9' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '{}\n', 'Gemini parses stdout as JSON: nothing else on it');
});

test('the Gemini extension: manifest at the repo root, its hook runs this package, its MCP server is ours', () => {
  const ext = JSON.parse(read(join(repo, 'gemini-extension.json')));
  const plugin = JSON.parse(read(join(pkg, 'plugin.json')));
  assert.equal(ext.name, 'enforcer');
  assert.equal(ext.version, plugin.version);
  assert.equal(ext.mcpServers.enforcer.httpUrl, JSON.parse(read(join(pkg, 'mcp.json'))).mcpServers.enforcer.url);
  const hooks = JSON.parse(read(join(repo, 'hooks', 'hooks.json'))).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart']);
  const cmd = hooks.SessionStart[0].hooks[0].command;
  assert.equal(cmd, 'node "${extensionPath}${/}enforcer${/}bin${/}enforcer" gemini session-start');
  assert.ok(existsSync(join(repo, cmd.match(/\$\{extensionPath\}(.*?)"/)[1].replaceAll('${/}', '/'))));
  assert.ok(END.startsWith('# '), 'the block markers are dotenv comments');
});
