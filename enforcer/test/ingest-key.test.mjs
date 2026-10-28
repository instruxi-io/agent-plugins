// ensureIngestKey / ingestHeaders / `enforcer ingest-key`: the telemetry-only key per machine + harness.
// A fake v3 stands in for the agents API (as a fetch stub, and as a local HTTP server for the CLI); no prod.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'ingest-key-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const k of Object.keys(process.env)) if (k.startsWith('ENFORCER_')) delete process.env[k];
// Loopback, so a stub that leaks can never reach a real server.
const BASE = 'http://127.0.0.1:9';
process.env.ENFORCER_BASE_URL = BASE;
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'enforcer');

const { ensureIngestKey, ingestHeaders, INGEST_SCOPE, OTLP_BASE, INGEST_KEYS_FILE, CHECK_EVERY_MS, MAX_LIVE_KEYS, agentSlug, main } = await import(
  '../src/ingest-key.mjs'
);

let pass = 0;
const t = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};

const USER_KEY = 'env3_' + 'u'.repeat(40);
const credFile = join(home, '.enforcer', 'credentials.json');
const signIn = (enforcer) => {
  mkdirSync(join(home, '.enforcer'), { recursive: true, mode: 0o700 });
  writeFileSync(credFile, JSON.stringify({ schema_version: 1, enforcer: { base_url: BASE, ...enforcer } }), { mode: 0o600 });
};
const signOut = () => rmSync(credFile, { force: true });
const resetCache = () => rmSync(INGEST_KEYS_FILE(), { force: true });

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-28T00:00:00Z');

/** In-memory v3: agents + credentials, enough of the agents API for the module. */
function fakeV3({ accepts = (h) => h['x-api-key'] === USER_KEY, ttlDays = 30, now = () => T0, canRevoke = true, canCreate = true, agentCap = Infinity } = {}) {
  const s = { agents: [], creds: new Map(), calls: [], n: 0, accepts };
  s.live = (agentId) => [...s.creds.values()].filter((c) => c.agent_id === agentId && !c.revoked_at && Date.parse(c.expires_at) > now());
  const json = (status, body) => ({ status, body });
  const issue = (agentId, scopes, harness, rotatedFrom = null) => {
    const id = `00000000-0000-4000-8000-${String(++s.n).padStart(12, '0')}`;
    const secret = `ag_secret_${s.n}_${'z'.repeat(20)}`;
    const c = {
      id,
      agent_id: agentId,
      scopes,
      expires_at: new Date(now() + ttlDays * DAY).toISOString(),
      created_at: new Date(now()).toISOString(),
      revoked_at: null,
      rotated_from: rotatedFrom,
      harness,
      secret,
    };
    s.creds.set(id, c);
    const { secret: _s, ...view } = c;
    return { credential: view, secret };
  };
  s.handle = (method, path, headers, body) => {
    s.calls.push(`${method} ${path.split('?')[0]}`);
    if (!path.startsWith('/api/v1/enforcer/')) return json(404, { error: 'not_found' });
    if (!s.accepts(headers)) return json(401, { error: 'unauthorized' });
    const p = path.slice('/api/v1/enforcer'.length).split('?')[0];
    let m;
    if (method === 'GET' && p === '/me/agents') return json(200, { success: true, data: { items: s.agents, total: s.agents.length } });
    if (method === 'GET' && p === '/auth/me') return json(200, { success: true, data: { account_id: 'acc-1', tenant: { id: 'ten-1' } } });
    if (method === 'GET' && p === '/tenants/ten-1/agent-policy') return json(200, { success: true, data: { allowed_role_ids: ['role-member', 'role-admin'] } });
    if (method === 'GET' && (m = p.match(/^\/roles\/(.+)$/)))
      return json(200, { success: true, data: { id: m[1], tenant_manage: m[1] === 'role-admin', tenant_read: true } });
    if (method === 'POST' && p === '/agents') {
      if (!canCreate) return json(403, { error: 'insufficient_scope' });
      if (s.agents.length >= agentCap) return json(409, { error: 'agent_limit_reached' });
      if (s.agents.some((a) => a.slug === body.slug)) return json(409, { error: 'slug_taken' });
      const a = { id: `agent-${s.agents.length + 1}`, state: 'active', ...body };
      s.agents.push(a);
      return json(201, { success: true, data: a });
    }
    if (method === 'POST' && (m = p.match(/^\/agents\/([^/]+)\/credentials$/))) {
      const a = s.agents.find((x) => x.id === m[1]);
      if (!a) return json(404, { error: 'not_found' });
      if (a.state !== 'active') return json(409, { error: 'agent_suspended' });
      // enforcer-v3 #633: governance:ingest stands alone; harness must match governance's name rule.
      if (body.scopes?.includes('governance:ingest') && body.scopes.length !== 1) return json(400, { error: 'invalid_scope' });
      if (body.harness !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.harness)) return json(400, { error: 'invalid_harness' });
      return json(201, { success: true, data: issue(a.id, body.scopes, body.harness ?? null) });
    }
    if (method === 'GET' && (m = p.match(/^\/agents\/([^/]+)\/credentials$/))) {
      if (!s.agents.some((x) => x.id === m[1])) return json(404, { error: 'not_found' });
      return json(200, { success: true, data: { items: s.live(m[1]).map(({ secret: _s, ...v }) => v) } });
    }
    if (method === 'POST' && (m = p.match(/^\/agents\/([^/]+)\/credentials\/([^/]+)\/revoke$/))) {
      if (!canRevoke) return json(403, { error: 'insufficient_scope' }); // revoke is .destructive
      const c = s.creds.get(m[2]);
      if (!c) return json(404, { error: 'not_found' });
      c.revoked_at = new Date(now()).toISOString();
      return json(200, { success: true, data: {} });
    }
    if (method === 'GET' && (m = p.match(/^\/agents\/([^/]+)\/credentials\/([^/]+)$/))) {
      const c = s.creds.get(m[2]);
      if (!c || c.agent_id !== m[1]) return json(404, { error: 'not_found' });
      const { secret: _s, ...view } = c;
      return json(200, { success: true, data: view });
    }
    // rotate is .destructive: the default sign-in may not call it, so the module never does.
    if (method === 'POST' && /\/rotate$/.test(p)) return json(403, { error: 'insufficient_scope' });
    return json(404, { error: 'no_route' });
  };
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    await new Promise((r) => setTimeout(r, 2)); // a real network yields: lets concurrent callers interleave
    const r = s.handle(init.method || 'GET', u.pathname + u.search, h, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return s;
}

const mode = (p) => statSync(p).mode & 0o777;
const err = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('expected a rejection');
};

await t('signed out: a clear signed_out error and no network call', async () => {
  signOut();
  const v3 = fakeV3();
  const e = await err(ensureIngestKey({ harness: 'codex', fetchImpl: v3.fetch }));
  assert.equal(e.code, 'signed_out');
  assert.match(e.message, /enforcer:login/);
  assert.equal(v3.calls.length, 0);
});

await t('unknown harness is refused before anything else', async () => {
  signIn({ api_key: USER_KEY });
  const v3 = fakeV3();
  const e = await err(ensureIngestKey({ harness: 'claude', fetchImpl: v3.fetch }));
  assert.equal(e.code, 'bad_harness');
  assert.equal(v3.calls.length, 0);
});

let clock = T0;
const shared = fakeV3({ now: () => clock });
const at = (ms) => {
  clock = ms;
  return () => clock;
};
let first;
await t('first mint: agent <harness>@<host> created with the ingest scope, credential issued with it', async () => {
  signIn({ api_key: USER_KEY });
  resetCache();
  first = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(T0), hostname: 'devbox.local' });
  assert.equal(first.source, 'minted');
  assert.match(first.key, /^ag_secret_/);
  assert.equal(shared.agents.length, 1);
  const a = shared.agents[0];
  assert.equal(a.name, 'codex@devbox.local');
  assert.equal(a.slug, 'ingest-codex-devbox-local');
  assert.deepEqual(a.scopes, [INGEST_SCOPE]);
  assert.equal(a.role_id, 'role-member', 'several allowed roles: the one with the fewest grants');
  assert.deepEqual(a.owner, { kind: 'account' });
  const c = shared.creds.get(first.credentialId);
  assert.equal(INGEST_SCOPE, 'governance:ingest');
  assert.deepEqual(c.scopes, [INGEST_SCOPE]);
  assert.equal(c.harness, 'codex', 'the harness rides on the credential (v3 reads it there, not the card)');
  assert.equal(first.agentId, a.id);
  assert.equal(first.expiresAt, c.expires_at);
});

await t('cache file is 0600 in a 0700 dir and holds the entry per harness', async () => {
  if (process.platform !== 'win32') assert.equal(mode(INGEST_KEYS_FILE()), 0o600);
  if (process.platform !== 'win32') assert.equal(mode(join(home, '.enforcer')), 0o700);
  const doc = JSON.parse(readFileSync(INGEST_KEYS_FILE(), 'utf8'));
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.keys.codex.key, first.key);
  assert.equal(doc.keys.codex.credentialId, first.credentialId);
});

await t('cache hit: no network at all', async () => {
  const before = shared.calls.length;
  const r = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(T0 + 60_000), hostname: 'devbox.local' });
  assert.equal(r.source, 'cache');
  assert.equal(r.key, first.key);
  assert.equal(shared.calls.length, before);
});

await t('ingestHeaders: the cached key as X-API-Key, {} for a harness with none', () => {
  assert.deepEqual(ingestHeaders('codex'), { 'X-API-Key': first.key });
  assert.deepEqual(ingestHeaders('hermes'), {});
});

await t('after CHECK_EVERY_MS the cached key is checked with v3, not re-minted', async () => {
  const before = shared.calls.length;
  const r = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(T0 + CHECK_EVERY_MS + 1), hostname: 'devbox.local' });
  assert.equal(r.source, 'cache');
  assert.equal(r.key, first.key);
  assert.deepEqual(shared.calls.slice(before), [`GET /api/v1/enforcer/agents/${first.agentId}/credentials/${first.credentialId}`]);
});

let rotated;
await t('under 7 days left: a fresh key is issued (no rotate/revoke), the old one left to expire; file stays 0600', async () => {
  rotated = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(Date.parse(first.expiresAt) - 6 * DAY), hostname: 'devbox.local' });
  assert.equal(rotated.source, 'rotated');
  assert.notEqual(rotated.key, first.key);
  assert.equal(shared.creds.get(rotated.credentialId).harness, 'codex');
  assert.equal(shared.creds.get(first.credentialId).revoked_at, null, 'the replaced key keeps working until it expires');
  assert.equal(shared.calls.filter((c) => /\/(rotate|revoke)$/.test(c)).length, 0, 'no .destructive call');
  assert.equal(shared.live(first.agentId).length, 2);
  assert.equal(shared.agents.length, 1);
  if (process.platform !== 'win32') assert.equal(mode(INGEST_KEYS_FILE()), 0o600);
  const e = JSON.parse(readFileSync(INGEST_KEYS_FILE(), 'utf8')).keys.codex;
  assert.equal(e.key, rotated.key);
  assert.equal(e.previousCredentialId, first.credentialId);
});

await t('more than 7 days left: not replaced', async () => {
  const r = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(clock + 2 * CHECK_EVERY_MS), hostname: 'devbox.local' });
  assert.equal(r.source, 'cache');
  assert.equal(r.key, rotated.key);
});

await t('the next replacement comes after the previous key expired: never more than MAX_LIVE_KEYS live', async () => {
  const r = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(Date.parse(rotated.expiresAt) - 6 * DAY), hostname: 'devbox.local' });
  assert.equal(r.source, 'rotated');
  assert.equal(MAX_LIVE_KEYS, 2);
  assert.equal(shared.live(first.agentId).length, 2);
  rotated = r;
});

await t('revoked in the console: the next check mints a new credential on the same agent', async () => {
  shared.creds.get(rotated.credentialId).revoked_at = new Date(clock).toISOString();
  const r = await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(clock + 3 * CHECK_EVERY_MS), hostname: 'devbox.local', force: true });
  assert.equal(r.source, 'minted');
  assert.notEqual(r.key, rotated.key);
  assert.equal(r.agentId, rotated.agentId);
  assert.equal(shared.agents.length, 1, 'no second agent');
});

await t('lost cache, repeatedly: extra live keys are revoked so at most MAX_LIVE_KEYS stay live', async () => {
  for (let i = 0; i < 4; i++) {
    resetCache();
    await ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: at(clock + 1), hostname: 'devbox.local' });
    assert.ok(shared.live(first.agentId).length <= MAX_LIVE_KEYS, `round ${i}: ${shared.live(first.agentId).length} live`);
  }
});

await t('lost cache and a sign-in that cannot revoke: too_many_keys, not a growing pile', async () => {
  const v3 = fakeV3({ canRevoke: false });
  resetCache();
  await ensureIngestKey({ harness: 'openclaw', fetchImpl: v3.fetch, now: () => T0, hostname: 'p' });
  resetCache();
  await ensureIngestKey({ harness: 'openclaw', fetchImpl: v3.fetch, now: () => T0, hostname: 'p' });
  resetCache();
  const e = await err(ensureIngestKey({ harness: 'openclaw', fetchImpl: v3.fetch, now: () => T0, hostname: 'p' }));
  assert.equal(e.code, 'too_many_keys');
  assert.equal(v3.live(v3.agents[0].id).length, 2);
});

await t('replacing with a stray live key around: the key being replaced is kept, the stray one revoked', async () => {
  let c = T0;
  const v3 = fakeV3({ now: () => c });
  resetCache();
  const k1 = await ensureIngestKey({ harness: 'hermes', fetchImpl: v3.fetch, now: () => c, hostname: 's' });
  // A stray key on the same agent that expires later than k1 (e.g. minted by a lost cache).
  c = T0 + DAY;
  v3.handle('POST', `/api/v1/enforcer/agents/${k1.agentId}/credentials`, { 'x-api-key': USER_KEY }, { scopes: [INGEST_SCOPE], harness: 'hermes' });
  c = Date.parse(k1.expiresAt) - 6 * DAY;
  const k2 = await ensureIngestKey({ harness: 'hermes', fetchImpl: v3.fetch, now: () => c, hostname: 's' });
  assert.equal(k2.source, 'rotated');
  const live = v3.live(k1.agentId).map((x) => x.id);
  assert.deepEqual(live.sort(), [k1.credentialId, k2.credentialId].sort(), 'k1 (still in harness configs) survives');
});

await t('short tenant TTL with the v3 clock 5 minutes behind: replacements never need a revoke', async () => {
  let c = T0;
  const v3 = fakeV3({ now: () => c - 300_000, ttlDays: 10, canRevoke: false });
  resetCache();
  const sources = [];
  for (let m = 0; m < 25 * 1440; m += 1) {
    c = T0 + m * 60_000; // every minute: a replacement happens at the first call inside the window
    sources.push((await ensureIngestKey({ harness: 'gemini-cli', fetchImpl: v3.fetch, now: () => c, hostname: 'q' })).source);
    assert.ok(v3.live(v3.agents[0].id).length <= MAX_LIVE_KEYS);
  }
  assert.ok(sources.filter((x) => x === 'rotated').length >= 3, 'it does replace keys');
  assert.equal(v3.calls.filter((x) => /\/revoke$/.test(x)).length, 0, 'a replacement never meets two live keys');
});

await t('browser sign-in without the agent scopes: insufficient_scope naming the fix, before any mint call', async () => {
  signIn({
    oauth: {
      access_token: 'oat_ro',
      expires_at: new Date(Date.now() + DAY).toISOString(),
      client_id: 'cli',
      scope: 'enforcer:read policy:self enforcer:graph-runs.write',
    },
  });
  const v3 = fakeV3({ accepts: () => true });
  resetCache();
  const e = await err(ensureIngestKey({ harness: 'codex', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' }));
  assert.equal(e.code, 'insufficient_scope');
  assert.match(e.message, /enforcer:login/);
  assert.equal(v3.calls.filter((c) => c.startsWith('POST')).length, 0);
  signIn({ api_key: USER_KEY });
});

await t('v3 refuses agent creation for scope (403 insufficient_scope): insufficient_scope', async () => {
  const v3 = fakeV3({ canCreate: false });
  resetCache();
  const e = await err(ensureIngestKey({ harness: 'codex', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' }));
  assert.equal(e.code, 'insufficient_scope');
});

await t('agent cap reached: the api error names max_agents_per_steward', async () => {
  const v3 = fakeV3({ agentCap: 0 });
  resetCache();
  const e = await err(ensureIngestKey({ harness: 'codex', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' }));
  assert.equal(e.code, 'api');
  assert.equal(e.apiCode, 'agent_limit_reached');
  assert.match(e.message, /max_agents_per_steward/);
});

await t('agent disabled in the console: agent_disabled, never a replacement agent', async () => {
  shared.agents[0].state = 'disabled';
  resetCache();
  const e = await err(ensureIngestKey({ harness: 'codex', fetchImpl: shared.fetch, now: () => T0, hostname: 'devbox.local' }));
  assert.equal(e.code, 'agent_disabled');
  assert.equal(shared.agents.length, 1);
  shared.agents[0].state = 'active';
});

await t('v3 refuses the sign-in (401): signed_out', async () => {
  const v3 = fakeV3({ accepts: () => false });
  resetCache();
  const e = await err(ensureIngestKey({ harness: 'codex', fetchImpl: v3.fetch, now: () => T0, hostname: 'devbox.local' }));
  assert.equal(e.code, 'signed_out');
});

await t('v3 unreachable on a check: the unexpired cached key keeps working', async () => {
  const v3 = fakeV3();
  resetCache();
  const k = await ensureIngestKey({ harness: 'openclaw', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' });
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  const r = await ensureIngestKey({ harness: 'openclaw', fetchImpl: down, now: () => T0 + 2 * CHECK_EVERY_MS, hostname: 'h', sleep: async () => {} });
  assert.equal(r.key, k.key);
  assert.equal(r.source, 'cache');
});

await t('errors never carry the secret', async () => {
  const v3 = fakeV3();
  resetCache();
  const k = await ensureIngestKey({ harness: 'openclaw', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' });
  // Expired and v3 failing: an error, which must not quote the cached key.
  const bad = async () => new Response(JSON.stringify({ error: 'boom', message: 'internal' }), { status: 500 });
  const e = await err(ensureIngestKey({ harness: 'openclaw', fetchImpl: bad, now: () => Date.parse(k.expiresAt) + 1, hostname: 'h', sleep: async () => {} }));
  assert.equal(e.code, 'api');
  assert.ok(!e.message.includes(k.key));
  assert.ok(!e.message.includes('ag_secret'));
});

await t('another sign-in (workspace switch): the old cache entry is not used', async () => {
  const v3 = fakeV3({ accepts: (h) => h['x-api-key'] === 'env3_other' || h['x-api-key'] === USER_KEY });
  resetCache();
  const a = await ensureIngestKey({ harness: 'gemini-cli', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' });
  signIn({ api_key: 'env3_other' });
  const b = await ensureIngestKey({ harness: 'gemini-cli', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' });
  assert.equal(b.source, 'minted');
  assert.notEqual(a.key, b.key);
  signIn({ api_key: USER_KEY });
});

await t('browser (OAuth) sign-in works the same way, with a Bearer token', async () => {
  signIn({
    oauth: {
      access_token: 'oat_abc',
      expires_at: new Date(Date.now() + DAY).toISOString(),
      client_id: 'cli',
      scope: 'enforcer:read policy:self enforcer:agents.write enforcer:agents-credentials.write',
    },
  });
  const v3 = fakeV3({ accepts: (h) => h.authorization === 'Bearer oat_abc' });
  resetCache();
  const r = await ensureIngestKey({ harness: 'hermes', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' });
  assert.equal(r.source, 'minted');
  signIn({ api_key: USER_KEY });
});

await t('concurrent calls in one process: exactly one mint', async () => {
  const v3 = fakeV3();
  resetCache();
  const rs = await Promise.all(Array.from({ length: 6 }, () => ensureIngestKey({ harness: 'hermes', fetchImpl: v3.fetch, now: () => T0, hostname: 'h' })));
  assert.equal(v3.calls.filter((c) => /^POST .*\/credentials$/.test(c)).length, 1);
  assert.equal(v3.calls.filter((c) => c === 'POST /api/v1/enforcer/agents').length, 1);
  assert.equal(new Set(rs.map((r) => r.key)).size, 1);
});

await t('slug taken by someone else: retried with a suffix', async () => {
  const v3 = fakeV3();
  v3.agents.push({ id: 'agent-x', name: 'not mine', slug: agentSlug('codex', 'dup'), state: 'active' });
  resetCache();
  const r = await ensureIngestKey({ harness: 'codex', fetchImpl: v3.fetch, now: () => T0, hostname: 'dup' });
  assert.equal(r.source, 'minted');
  assert.match(v3.agents[1].slug, /^ingest-codex-dup-[0-9a-f]{6}$/);
});

await t('OTLP_BASE', () => {
  assert.equal(OTLP_BASE('https://api.instruxi.dev/'), 'https://api.instruxi.dev/api/v1/governance/otlp');
  assert.equal(OTLP_BASE(), `${BASE}/api/v1/governance/otlp`);
});

await t('CLI main: the key alone on stdout, JSON with --json, documented exit codes', async () => {
  const run = async (argv, ensure) => {
    let out = '';
    let e = '';
    const code = await main(argv, { out: (s) => (out += s), err: (s) => (e += s), ensure });
    return { code, out, err: e };
  };
  const ok = async () => ({ key: 'ag_k', credentialId: 'c', agentId: 'a', expiresAt: 'x', source: 'cache' });
  assert.deepEqual(await run(['--harness', 'codex'], ok), { code: 0, out: 'ag_k\n', err: '' });
  const j = await run(['--harness=hermes', '--json'], ok);
  assert.equal(j.code, 0);
  assert.deepEqual(JSON.parse(j.out), {
    key: 'ag_k',
    credentialId: 'c',
    agentId: 'a',
    expiresAt: 'x',
    source: 'cache',
    harness: 'hermes',
    otlpBase: `${BASE}/api/v1/governance/otlp`,
  });
  const usage = await run([], ok);
  assert.equal(usage.code, 2);
  assert.equal(usage.out, '');
  assert.equal((await run(['--harness', 'nope'], ok)).code, 2);
  const so = await run(['--harness', 'codex'], async () => {
    throw Object.assign(new Error('not signed in'), { code: 'signed_out' });
  });
  assert.deepEqual([so.code, so.out], [3, '']);
  const dis = await run(['--harness', 'codex'], async () => {
    throw Object.assign(new Error('disabled'), { code: 'agent_disabled' });
  });
  assert.equal(dis.code, 4);
  const scope = await run(['--harness', 'codex'], async () => {
    throw Object.assign(new Error('log in again'), { code: 'insufficient_scope' });
  });
  assert.deepEqual([scope.code, scope.out], [5, '']);
  const failed = await run(['--harness', 'codex'], async () => {
    throw Object.assign(new Error('HTTP 500'), { code: 'api' });
  });
  assert.equal(failed.code, 1);
});

// The real CLI, two processes at once, against a fake v3 over HTTP: one mint, the key alone on stdout.
await t('enforcer ingest-key: two processes at once mint one key; stdout is only the key', async () => {
  resetCache();
  const v3 = fakeV3({ now: Date.now });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      setTimeout(() => {
        const r = v3.handle(req.method, req.url, req.headers, body ? JSON.parse(body) : undefined);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      }, 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  signIn({ api_key: USER_KEY });
  const env = { ...process.env, ENFORCER_BASE_URL: base };
  const runCli = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [BIN, 'ingest-key', ...args], { env });
      let out = '';
      let e = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (e += d));
      p.on('close', (code) => resolve({ code, out, err: e }));
    });
  try {
    const [a, b] = await Promise.all([runCli(['--harness', 'codex']), runCli(['--harness', 'codex'])]);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    assert.match(a.out, /^ag_secret_\d+_z+\n$/);
    assert.equal(a.out, b.out);
    assert.equal(v3.calls.filter((c) => /^POST .*\/credentials$/.test(c)).length, 1);
    const j = await runCli(['--harness', 'codex', '--json']);
    assert.equal(j.code, 0, j.err);
    assert.equal(JSON.parse(j.out).key, a.out.trim());
    signOut();
    const so = await runCli(['--harness', 'codex']);
    assert.equal(so.code, 3);
    assert.equal(so.out, '');
    assert.match(so.err, /not signed in/);
  } finally {
    server.close();
  }
});

console.log(`${pass} passed`);
