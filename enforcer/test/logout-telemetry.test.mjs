// `enforcer logout` and the harness telemetry keys: the ingest-key cache is deleted, each cached key is revoked
// with v3 where the sign-in may (403 without enforcer:agents-credentials.destructive: reported, fails open), the
// key is taken out of the Codex, Gemini CLI and OpenClaw configs, no opt-out is recorded, and afterwards no file
// under the home holds a key. End to end: real keys minted by `enforcer ingest-key` against a local fake v3,
// real harness configs written by each module's own enable, then the real `login.mjs logout` subprocess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const LOGIN = join(PKG, 'bin', 'login.mjs');
const ENFORCER = join(PKG, 'bin', 'enforcer');
const USER_KEY = 'env3_' + 'u'.repeat(40);
const HARNESSES = ['codex', 'gemini-cli', 'openclaw', 'hermes'];

/** Enough of the v3 agents API for ingest-key, plus a switch for whether revoke is allowed (it is .destructive). */
async function fakeV3({ canRevoke = true } = {}) {
  const s = { agents: [], creds: new Map(), calls: [], n: 0, canRevoke };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const p = req.url.split('?')[0].replace(/^\/api\/v1\/enforcer/, '');
      s.calls.push(`${req.method} ${p}`);
      const send = (status, j) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      if (req.headers['x-api-key'] !== USER_KEY) return send(401, { error: 'unauthorized' });
      let m;
      if (req.method === 'GET' && p === '/me/agents') return send(200, { success: true, data: { items: s.agents } });
      if (req.method === 'GET' && p === '/auth/me') return send(200, { success: true, data: { account_id: 'acc-1', tenant: { id: 'ten-1' } } });
      if (req.method === 'GET' && p === '/tenants/ten-1/agent-policy') return send(200, { success: true, data: { allowed_role_ids: ['role-member'] } });
      if (req.method === 'POST' && p === '/agents') {
        const a = { id: `agent-${s.agents.length + 1}`, state: 'active', ...body };
        s.agents.push(a);
        return send(201, { success: true, data: a });
      }
      if (req.method === 'GET' && (m = p.match(/^\/agents\/([^/]+)\/credentials$/)))
        return send(200, { success: true, data: { items: [...s.creds.values()].filter((c) => c.agent_id === m[1] && !c.revoked_at) } });
      if (req.method === 'POST' && (m = p.match(/^\/agents\/([^/]+)\/credentials$/))) {
        const id = `00000000-0000-4000-8000-${String(++s.n).padStart(12, '0')}`;
        const c = {
          id,
          agent_id: m[1],
          scopes: body.scopes,
          harness: body.harness,
          expires_at: '2026-12-01T00:00:00Z',
          created_at: new Date().toISOString(),
          revoked_at: null,
        };
        s.creds.set(id, c);
        return send(201, { success: true, data: { credential: c, secret: `ag_ingest_${s.n}_${'k'.repeat(24)}` } });
      }
      if (req.method === 'POST' && (m = p.match(/^\/agents\/([^/]+)\/credentials\/([^/]+)\/revoke$/))) {
        if (!s.canRevoke) return send(403, { error: { code: 'insufficient_scope', message: 'needs enforcer:agents-credentials.destructive' } });
        const c = s.creds.get(m[2]);
        if (!c) return send(404, { error: 'not_found' });
        c.revoked_at = new Date().toISOString();
        return send(200, { success: true, data: c });
      }
      return send(404, { error: 'no_route' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  s.close = () => new Promise((r) => server.close(r));
  s.live = () => [...s.creds.values()].filter((c) => !c.revoked_at).map((c) => c.id);
  return s;
}

const run = (file, args, env) =>
  new Promise((res) =>
    execFile(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 60_000 }, (e, stdout, stderr) =>
      res({ code: e ? (e.code ?? 1) : 0, stdout, stderr }),
    ),
  );

/** A fresh signed-in home whose env the subprocesses and the in-process modules share. */
function makeHome(base) {
  const home = mkdtempSync(join(tmpdir(), 'logout-tel-'));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ENFORCER_BASE_URL: base,
    ENFORCER_HOME: join(home, '.enforcer'),
    GOVERNOR_HOME: join(home, '.g'),
  };
  mkdirSync(env.ENFORCER_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(join(env.ENFORCER_HOME, 'credentials.json'), JSON.stringify({ schema_version: 1, enforcer: { base_url: base, api_key: USER_KEY } }), {
    mode: 0o600,
  });
  return { home, env };
}

/** Every file under dir (recursively) whose bytes contain one of the keys. */
function filesWithKeys(dir, keys) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && keys.some((k) => readFileSync(f, 'utf8').includes(k))) hits.push(f);
    }
  };
  walk(dir);
  return hits;
}

/** Mint a real key per harness through the CLI, and write each harness config with its module's own enable. */
async function provision({ home, env }, { codex = true, gemini = true, openclaw = true } = {}) {
  const keys = {};
  for (const h of HARNESSES) {
    const r = await run(ENFORCER, ['ingest-key', '--harness', h, '--json'], env);
    assert.equal(r.code, 0, `ingest-key ${h}: ${r.stderr}`);
    keys[h] = JSON.parse(r.stdout).key;
  }
  const otlpBase = `${env.ENFORCER_BASE_URL}/api/v1/governance/otlp`;
  // codex telemetry resolves ~ from process.env (its env argument only carries CODEX_HOME), as the subprocess will
  process.env.HOME = home;
  if (codex) {
    const c = await import('../lib/governor/adapters/codex/telemetry.mjs');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[plugins."enforcer@instruxi"]\nenabled = true\n');
    await c.enable({ ingestUrl: env.ENFORCER_BASE_URL }, { env, ensureIngestKey: async () => ({ key: keys.codex }) });
  }
  if (gemini) {
    const g = await import('../src/gemini-telemetry.mjs');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(join(home, '.gemini', '.env'), 'GEMINI_API_KEY=theirs\n');
    await g.enable({
      env,
      home,
      shared: env.ENFORCER_HOME,
      baseUrl: env.ENFORCER_BASE_URL,
      ingest: { ensureIngestKey: async () => ({ key: keys['gemini-cli'] }) },
    });
  }
  if (openclaw) {
    const o = await import('../src/openclaw.mjs');
    mkdirSync(join(home, '.openclaw'), { recursive: true });
    const cfg = { gateway: { port: 18789 }, plugins: { entries: { enforcer: { enabled: true, config: { telemetry: true } } } } };
    o.enable(cfg, o.desiredOtel({ otlpBase, key: keys.openclaw }));
    writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  return keys;
}

const logout = ({ env }) => run(LOGIN, ['logout'], env);

test('logout with every harness config present and revoke allowed: revoked, removed everywhere, nothing holds a key', async () => {
  const v3 = await fakeV3({ canRevoke: true });
  try {
    const h = makeHome(v3.base);
    const keys = await provision(h);
    const all = Object.values(keys);
    assert.ok(filesWithKeys(h.home, all).length >= 4, 'control: the cache and three configs hold keys before logout');
    assert.equal(v3.live().length, 4);

    const r = await logout(h);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(v3.live(), [], 'every cached key revoked on the server');
    assert.match(r.stdout, /Telemetry keys revoked on the server: .*codex.*gemini-cli.*openclaw.*hermes/);
    assert.doesNotMatch(r.stdout, /NOT revoked/);
    assert.match(r.stdout, /Codex: removed the telemetry key/);
    assert.match(r.stdout, /Gemini CLI: removed the telemetry key/);
    assert.match(r.stdout, /OpenClaw: removed the telemetry key/);
    assert.match(r.stdout, /Signed out/);
    for (const k of all) assert.ok(!r.stdout.includes(k), 'output never prints a key');

    assert.equal(existsSync(join(h.env.ENFORCER_HOME, 'ingest-keys.json')), false, 'cache deleted');
    assert.deepEqual(filesWithKeys(h.home, all), [], 'no file under the home holds a key');
    // the rest of each config is the user's and stays
    assert.match(readFileSync(join(h.home, '.codex', 'config.toml'), 'utf8'), /model = "gpt-5"[\s\S]*enforcer@instruxi/);
    assert.doesNotMatch(readFileSync(join(h.home, '.codex', 'config.toml'), 'utf8'), /\[otel\]/);
    assert.equal(readFileSync(join(h.home, '.gemini', '.env'), 'utf8'), 'GEMINI_API_KEY=theirs\n');
    const oc = JSON.parse(readFileSync(join(h.home, '.openclaw', 'openclaw.json'), 'utf8'));
    assert.equal(oc.diagnostics.otel, undefined);
    assert.equal(oc.gateway.port, 18789);
    if (process.platform !== 'win32') assert.equal(statSync(join(h.home, '.openclaw', 'openclaw.json')).mode & 0o777, 0o600);

    // no opt-out recorded: the next sign-in turns telemetry back on
    assert.equal(oc.plugins.entries.enforcer.config.telemetry, true, 'OpenClaw telemetry switch untouched');
    assert.equal(existsSync(join(h.env.ENFORCER_HOME, 'gemini-telemetry.json')), false, 'no Gemini opt-out file');
    const g = await import('../src/gemini-telemetry.mjs');
    assert.equal(g.optedOut(h.env.ENFORCER_HOME), false);
    const gov = join(h.env.GOVERNOR_HOME, 'config.json');
    assert.ok(!existsSync(gov) || !/codexTelemetry/.test(readFileSync(gov, 'utf8')), 'no codexTelemetry=false in the governor config');
  } finally {
    await v3.close();
  }
});

test('revoke refused (403, the default sign-in): logout still succeeds, names the keys left to expire, nothing on disk', async () => {
  const v3 = await fakeV3({ canRevoke: false });
  try {
    const h = makeHome(v3.base);
    const keys = await provision(h);
    const ids = v3.live();
    const r = await logout(h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Telemetry keys NOT revoked on the server \(this sign-in lacks enforcer:agents-credentials\.destructive\)/);
    for (const id of ids) assert.ok(r.stdout.includes(id), `names ${id}`);
    assert.match(r.stdout, /expires 2026-12-01T00:00:00Z/);
    assert.match(r.stdout, /stop working when they expire/);
    assert.doesNotMatch(r.stdout, /revoked on the server: /);
    assert.equal(v3.live().length, 4, 'still live server-side, as reported');
    assert.deepEqual(filesWithKeys(h.home, Object.values(keys)), [], 'but nothing on this machine holds one');
    assert.match(r.stdout, /Signed out/);
    assert.ok(
      !existsSync(join(h.env.ENFORCER_HOME, 'credentials.json')) || !readFileSync(join(h.env.ENFORCER_HOME, 'credentials.json'), 'utf8').includes(USER_KEY),
    );
  } finally {
    await v3.close();
  }
});

test('harness configs absent: only the cache is cleared; no harness lines', async () => {
  const v3 = await fakeV3();
  try {
    const h = makeHome(v3.base);
    const keys = await provision(h, { codex: false, gemini: false, openclaw: false });
    const r = await logout(h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Deleted the telemetry key cache/);
    assert.doesNotMatch(r.stdout, /Codex:|Gemini CLI:|OpenClaw:/);
    assert.deepEqual(filesWithKeys(h.home, Object.values(keys)), []);
    assert.deepEqual(v3.live(), []);
  } finally {
    await v3.close();
  }
});

test('each harness config alone is cleaned, and the others are not created', async () => {
  for (const only of ['codex', 'gemini', 'openclaw']) {
    const v3 = await fakeV3();
    try {
      const h = makeHome(v3.base);
      const keys = await provision(h, { codex: only === 'codex', gemini: only === 'gemini', openclaw: only === 'openclaw' });
      const r = await logout(h);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(/Codex: removed/.test(r.stdout), only === 'codex', only);
      assert.equal(/Gemini CLI: removed/.test(r.stdout), only === 'gemini', only);
      assert.equal(/OpenClaw: removed/.test(r.stdout), only === 'openclaw', only);
      for (const [dir, who] of [
        ['.codex', 'codex'],
        ['.gemini', 'gemini'],
        ['.openclaw', 'openclaw'],
      ])
        if (who !== only) assert.equal(existsSync(join(h.home, dir)), false, `${dir} not created when ${only} alone`);
      assert.deepEqual(filesWithKeys(h.home, Object.values(keys)), [], only);
    } finally {
      await v3.close();
    }
  }
});

test('nothing cached, nothing configured: logout prints what it did before, and no telemetry lines', async () => {
  const v3 = await fakeV3();
  try {
    const h = makeHome(v3.base);
    const r = await logout(h);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Telemetry|Codex|Gemini|OpenClaw/);
    assert.match(r.stdout, /Signed out/);
    assert.deepEqual(v3.calls, [], 'no v3 call when there is nothing to revoke');
  } finally {
    await v3.close();
  }
});

test('v3 unreachable at logout: fails open, keys still removed from disk', async () => {
  const v3 = await fakeV3();
  const h = makeHome(v3.base);
  let keys;
  try {
    keys = await provision(h);
  } finally {
    await v3.close();
  }
  const r = await logout(h);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NOT revoked on the server \(Enforcer did not answer the revoke\)/);
  assert.match(r.stdout, /Signed out/);
  assert.deepEqual(filesWithKeys(h.home, Object.values(keys)), []);
});

test('a foreign OpenClaw collector and a foreign Codex [otel] are left alone', async () => {
  const v3 = await fakeV3();
  try {
    const h = makeHome(v3.base);
    await provision(h, { codex: false, gemini: false, openclaw: false });
    mkdirSync(join(h.home, '.openclaw'));
    const foreign = {
      diagnostics: { enabled: true, otel: { enabled: true, metricsEndpoint: 'https://otel.example/v1/metrics', headers: { 'X-Their': 'theirs' } } },
    };
    writeFileSync(join(h.home, '.openclaw', 'openclaw.json'), JSON.stringify(foreign));
    mkdirSync(join(h.home, '.codex'));
    const codexText = '[otel]\nenvironment = "prod"\n';
    writeFileSync(join(h.home, '.codex', 'config.toml'), codexText);
    const r = await logout(h);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, '.openclaw', 'openclaw.json'), 'utf8')), foreign);
    assert.equal(readFileSync(join(h.home, '.codex', 'config.toml'), 'utf8'), codexText);
    assert.doesNotMatch(r.stdout, /OpenClaw:|Codex:/);
  } finally {
    await v3.close();
  }
});
