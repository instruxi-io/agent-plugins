// Telemetry-only keys for harnesses that cannot run a headers helper.
//
// Claude Code asks for fresh OTel headers on every export (otelHeadersHelper), so it sends the
// person's own short-lived token. Codex, Gemini CLI, Hermes and OpenClaw take a fixed header from a
// config file or the environment. Writing the person's own credential there would put an
// unrestricted, long-lived secret in a harness config, so each machine + harness gets its own v3
// agent (`<harness>@<hostname>`) holding a credential with INGEST_SCOPE (and the harness stamped on
// the credential), which can only write telemetry to governance. It is cached in
// ~/.enforcer/ingest-keys.json (0600), replaced by a freshly issued one when it has under 7 days left
// (the old one is left to expire: rotate/revoke need the .destructive scope, issuing does not), and
// minted again when it was revoked, as long as this machine is signed in. At most two live keys per
// harness: the current one and the one it replaced, still expiring.
//
// Disabling the AGENT in the console is the durable off switch: a disabled agent is reported, never
// replaced. Revoking only the credential gets a fresh one on the next call while signed in.
//
// Nothing here logs. The secret leaves this module only as a return value (and through the CLI's
// stdout, which is the point of the CLI).
import { readFileSync, readdirSync, mkdirSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SHARED_DIR, acquireRefreshLock, authHeaders, credentialId, isFederated, enforcerKey, readCredentials } from './credentials.mjs';
import { resolveConfig } from './config.mjs';
import { assertSchema, stamp } from './schema.mjs';
import { apiFetch } from '../lib/api/client.mjs';

// The v3 scope the ingest credential carries (authz.ScopeGovernanceIngest, enforcer-v3 #633). Accepted
// only on agents and agent credentials, and it must stand alone: mixed with any other scope v3 answers
// 400 invalid_scope. Not an `enforcer:governance-*` fine scope on purpose: leaves match fine scopes by
// service prefix, so that would grant every governance write.
export const INGEST_SCOPE = 'governance:ingest';

/** Harnesses that get an ingest key. Claude Code is absent on purpose: it uses otelHeadersHelper. */
export const INGEST_HARNESSES = Object.freeze(['codex', 'gemini-cli', 'hermes', 'openclaw']);

const DAY = 86_400_000;
/** Replace a credential with less than this left. */
export const ROTATE_WITHIN_MS = 7 * DAY;
/** How often a cached key is checked against v3 (revoked? expired?) before it is handed out again. */
export const CHECK_EVERY_MS = 60 * 60_000;
/** Live keys per harness after a mint: the current one, and the one it replaced while that expires. */
export const MAX_LIVE_KEYS = 2;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const V3 = '/api/v1/enforcer';

export const INGEST_KEYS_FILE = () => join(SHARED_DIR(), 'ingest-keys.json');
const lockPath = () => join(SHARED_DIR(), '.ingest-key.lock');
const trim = (s) => String(s).replace(/\/+$/, '');

/** The governance OTLP base for an Enforcer base URL: append /v1/logs or /v1/metrics. */
export const OTLP_BASE = (baseUrl = currentBase()) => `${trim(baseUrl)}/api/v1/governance/otlp`;

/**
 * Why a key could not be had. `code`:
 *   bad_harness   - not one of INGEST_HARNESSES
 *   signed_out    - no Enforcer sign-in on this machine, or v3 refused it (401)
 *   agent_disabled - the harness's agent is disabled or suspended in the console (the off switch)
 *   insufficient_scope - the sign-in may not create agents / issue agent credentials (log in again)
 *   too_many_keys - MAX_LIVE_KEYS live keys already exist for the harness and this sign-in cannot revoke one
 *   busy          - another process held the mint lock for LOCK_WAIT_MS and left no key
 *   api           - v3 refused or failed; `status` and `apiCode` say how (the agent cap is api/agent_limit_reached)
 */
export class IngestKeyError extends Error {
  constructor(code, message, { status = 0, apiCode = null } = {}) {
    super(message);
    this.name = 'IngestKeyError';
    this.code = code;
    this.status = status;
    this.apiCode = apiCode;
  }
}

function currentBase() {
  try {
    return resolveConfig().baseUrl;
  } catch (e) {
    throw new IngestKeyError('api', `enforcer: ${e.message}`);
  }
}

/** `<harness>@<hostname>`, the v3 agent name for this machine + harness. */
export const agentName = (harness, host = osHostname()) => `${harness}@${host}`;

/** A v3 slug (lower-case letters, digits, hyphens; 1-63) for the agent. */
export function agentSlug(harness, host = osHostname(), suffix = '') {
  const clean = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const tail = suffix ? `-${suffix}` : '';
  const base = clean(`ingest-${harness}-${host}`)
    .slice(0, 63 - tail.length)
    .replace(/-+$/, '');
  return `${base}${tail}`;
}

// ---- cache file -------------------------------------------------------------------------------

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** The cache document ({schema_version, keys: {<harness>: entry}}), or an empty one. Throws SchemaError on a newer file. */
export function readIngestKeys() {
  const doc = readJson(INGEST_KEYS_FILE());
  if (!doc || typeof doc !== 'object') return { keys: {} };
  assertSchema(doc, INGEST_KEYS_FILE());
  return { ...doc, keys: doc.keys && typeof doc.keys === 'object' ? doc.keys : {} };
}

/** Atomic write (temp file created 0600, fsync, rename) into the 0700 shared dir, as saveCredentials does. */
function writeIngestKeys(doc) {
  const dir = SHARED_DIR();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to chmod */
  }
  const tmp = join(dir, `.ingest-keys.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(stamp(doc), null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, INGEST_KEYS_FILE());
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function saveEntry(harness, entry) {
  const doc = readIngestKeys();
  writeIngestKeys({ ...doc, keys: { ...doc.keys, [harness]: entry } });
}

/** The cached entry for `harness` when it belongs to this base URL and this sign-in, else null. */
function cachedEntry(harness, base, owner) {
  let e;
  try {
    e = readIngestKeys().keys[harness];
  } catch {
    return null; // a newer file: treat as no cache, and never overwrite it (writes re-check the schema)
  }
  if (!e || typeof e.key !== 'string' || !e.key) return null;
  if (e.baseUrl !== base || e.owner !== owner) return null;
  return e;
}

const publicView = (e, source) => ({ key: e.key, credentialId: e.credentialId, agentId: e.agentId, expiresAt: e.expiresAt, source });
const msLeft = (e, now) => Date.parse(e?.expiresAt || '') - now;
// Replace inside the last 7 days, or the last third of the lifetime for a tenant whose TTL is shorter than 21 days,
// so a short default TTL does not replace on every call, and the replaced key has expired before the next
// replacement (which keeps it to MAX_LIVE_KEYS).
const rotateWindow = (e) => {
  const life = Date.parse(e?.expiresAt || '') - Date.parse(e?.issuedAt || '');
  return Number.isFinite(life) && life > 0 ? Math.min(ROTATE_WITHIN_MS, life / 3) : ROTATE_WITHIN_MS;
};
const fresh = (e, now) => !!e && msLeft(e, now) > rotateWindow(e) && now - Date.parse(e.checkedAt || '') < CHECK_EVERY_MS;

// ---- v3 calls ----------------------------------------------------------------------------------

async function v3(ctx, method, path, body) {
  let res;
  try {
    res = await apiFetch(
      `${ctx.base}${V3}${path}`,
      { method, headers: { ...ctx.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) },
      {
        fetchImpl: ctx.fetchImpl,
        timeoutMs: ctx.timeoutMs ?? HTTP_TIMEOUT_MS,
        retries: ctx.retries ?? 1,
        baseDelayMs: 100,
        maxDelayMs: 500,
        sleep: ctx.sleep,
      },
    );
  } catch (e) {
    return { status: 0, ok: false, data: null, apiCode: null, message: e?.name || 'network error' };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  const err = json?.error;
  return {
    status: res.status,
    ok: res.ok,
    data: json && 'data' in json ? json.data : json,
    apiCode: (typeof err === 'object' ? err?.code : err) ?? null,
    // Only an error body's message is kept: a success body may carry the secret.
    message: res.ok ? '' : String((typeof err === 'object' ? err?.message : json?.message) || ''),
  };
}

const LOGIN_AGAIN =
  'Run /enforcer:login (or `enforcer login`) again: the default sign-in asks for enforcer:agents.write and enforcer:agents-credentials.write.';

function fail(what, r) {
  if (r.status === 403 && r.apiCode === 'insufficient_scope') {
    return new IngestKeyError('insufficient_scope', `${what}: this sign-in may not create telemetry keys (HTTP 403 insufficient_scope). ${LOGIN_AGAIN}`, {
      status: 403,
      apiCode: r.apiCode,
    });
  }
  if (r.status === 403 && r.apiCode === 'agent_cannot_mint') {
    return new IngestKeyError(
      'api',
      `${what}: this machine is signed in with an agent key, which cannot create agents or keys. Sign in as a person (/enforcer:login).`,
      {
        status: 403,
        apiCode: r.apiCode,
      },
    );
  }
  if (r.status === 409 && r.apiCode === 'agent_limit_reached') {
    return new IngestKeyError(
      'api',
      `${what}: you already hold as many agents as this workspace allows per person (max_agents_per_steward). Telemetry keys need one agent per harness per machine; delete an unused agent in the Enforcer console or ask a workspace admin to raise the cap.`,
      { status: 409, apiCode: r.apiCode },
    );
  }
  if (r.status === 401)
    return new IngestKeyError('signed_out', `${what}: Enforcer refused this machine's sign-in (HTTP 401). Run /enforcer:login.`, { status: 401 });
  const detail = r.status ? `HTTP ${r.status}${r.apiCode ? ` ${r.apiCode}` : ''}${r.message ? `: ${r.message}` : ''}` : r.message;
  return new IngestKeyError('api', `${what} failed (${detail})`, { status: r.status, apiCode: r.apiCode });
}

async function pickRole(ctx) {
  const me = await v3(ctx, 'GET', '/auth/me');
  if (!me.ok) throw fail('Reading your identity', me);
  const tenantId = me.data?.tenant?.id || me.data?.tenant_id;
  if (!tenantId) throw new IngestKeyError('api', 'Could not tell your workspace from /auth/me, so the roles agents may hold are unknown.');
  const pol = await v3(ctx, 'GET', `/tenants/${encodeURIComponent(tenantId)}/agent-policy`);
  if (!pol.ok) throw fail('Reading the workspace agent policy', pol);
  const allowed = Array.isArray(pol.data?.allowed_role_ids) ? pol.data.allowed_role_ids.filter((x) => typeof x === 'string' && x) : [];
  if (!allowed.length)
    throw new IngestKeyError('api', 'The workspace agent policy allows no roles for agents, so no ingest agent can be created. Ask a workspace admin.');
  if (allowed.length === 1) return allowed[0];
  // Several allowed: the one with the fewest grants. The credential is narrowed to INGEST_SCOPE anyway.
  const grants = await Promise.all(
    allowed.map(async (id) => {
      const r = await v3(ctx, 'GET', `/roles/${encodeURIComponent(id)}`);
      const d = r.ok ? r.data || {} : null;
      return { id, n: d ? ['cross_tenant', 'tenant_manage', 'tenant_write', 'tenant_read'].filter((k) => d[k]).length : 99 };
    }),
  );
  return grants.reduce((a, b) => (b.n < a.n ? b : a)).id;
}

/** The agent named `<harness>@<host>` that the caller owns or stewards, created when there is none. */
async function findOrCreateAgent(ctx) {
  const name = agentName(ctx.harness, ctx.host);
  const limit = 100;
  for (let offset = 0, page = 0; page < 20; page++, offset += limit) {
    const r = await v3(ctx, 'GET', `/me/agents?limit=${limit}&offset=${offset}`);
    if (!r.ok) throw fail('Listing your agents', r);
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    const mine = items.filter((a) => a?.name === name);
    const live = mine.find((a) => a.state === 'active');
    if (live) return live.id;
    if (mine.length) {
      throw new IngestKeyError(
        'agent_disabled',
        `The agent ${name} is ${mine[0].state || 'not active'} in the Enforcer console, so this machine sends no ${ctx.harness} telemetry. Enable it there to turn telemetry back on.`,
      );
    }
    if (items.length < limit) break;
  }
  const role_id = await pickRole(ctx);
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = agentSlug(ctx.harness, ctx.host, attempt ? randomBytes(3).toString('hex') : '');
    const r = await v3(ctx, 'POST', '/agents', {
      name,
      slug,
      description: `Sends ${ctx.harness} telemetry from ${ctx.host} to Enforcer governance. Created by the enforcer plugin; disable it to stop that telemetry.`,
      owner: { kind: 'account' },
      role_id,
      scopes: [INGEST_SCOPE],
      card: { purpose: 'telemetry-ingest', harness: ctx.harness, host: ctx.host },
    });
    if (r.ok && r.data?.id) return r.data.id;
    if (r.status === 409 && r.apiCode === 'slug_taken') continue;
    throw fail(`Creating the agent ${name}`, r);
  }
  throw new IngestKeyError('api', `Creating the agent ${name} failed: every slug tried was taken`);
}

function entryFrom(ctx, agentId, data) {
  const c = data?.credential || {};
  if (typeof data?.secret !== 'string' || !data.secret || !c.id) throw new IngestKeyError('api', 'v3 answered the credential call without a secret or an id');
  const t = new Date(ctx.now()).toISOString();
  return {
    key: data.secret,
    credentialId: c.id,
    agentId: c.agent_id || agentId,
    expiresAt: c.expires_at || null,
    issuedAt: c.created_at || t,
    checkedAt: t,
    baseUrl: ctx.base,
    owner: ctx.owner,
    agentName: agentName(ctx.harness, ctx.host),
  };
}

// Scopes that let a browser sign-in create the agent and issue its credential (enforcer-v3 #633).
const MINT_SCOPES = [
  'enforcer:write',
  'enforcer:admin',
  'enforcer:agents.write',
  'enforcer:agents.destructive',
  'enforcer:agents-credentials.write',
  'enforcer:agents-credentials.destructive',
];

/** False only for a browser sign-in whose recorded scopes cannot mint; an API key, or no record, is left to v3. */
export function signInCanMint(doc = readCredentials()) {
  if (enforcerKey()) return true;
  const scope = doc?.enforcer?.oauth?.scope;
  if (typeof scope !== 'string' || !scope.trim()) return true;
  const granted = scope.split(/\s+/);
  return MINT_SCOPES.some((s) => granted.includes(s));
}

const isLive = (c, now) => !!c && !c.revoked_at && Date.parse(c.expires_at || '') > now;

/**
 * Keep the agent's live keys for this harness under MAX_LIVE_KEYS before a new one is issued: keep `keepId`
 * (the key being replaced) or else the one expiring last, and revoke the others (keys this machine lost track
 * of, e.g. a deleted cache or another sign-in on the same account). Revoking needs the .destructive scope; a
 * sign-in without it gets too_many_keys rather than a growing pile.
 */
async function boundLiveKeys(ctx, agentId, keepId) {
  const r = await v3(ctx, 'GET', `/agents/${encodeURIComponent(agentId)}/credentials`);
  if (!r.ok) {
    if (r.status === 404) return;
    throw fail("Listing the agent's keys", r);
  }
  const live = (Array.isArray(r.data?.items) ? r.data.items : [])
    .filter((c) => isLive(c, ctx.now()) && (!c.harness || c.harness === ctx.harness))
    .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at));
  if (live.length < MAX_LIVE_KEYS) return;
  const keep = live.find((c) => c.id === keepId) || live[0];
  const extra = live.filter((c) => c.id !== keep.id);
  for (const c of extra) {
    const v = await v3(ctx, 'POST', `/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(c.id)}/revoke`, {
      reason: 'superseded: enforcer ingest-key keeps one live key per harness plus the one being replaced',
    });
    if (v.ok || v.status === 404) continue;
    if (v.status === 401) throw fail('Revoking a superseded key', v);
    throw new IngestKeyError(
      'too_many_keys',
      `${live.length} live ${ctx.harness} telemetry keys already exist on the agent ${agentName(ctx.harness, ctx.host)} and this sign-in cannot revoke the extra ones (HTTP ${v.status}${v.apiCode ? ` ${v.apiCode}` : ''}). Revoke the unused ones in the Enforcer console, or wait until one expires (${extra[extra.length - 1].expires_at}).`,
      { status: v.status, apiCode: v.apiCode },
    );
  }
}

async function mint(ctx, knownAgentId, keepId = null) {
  if (!signInCanMint()) {
    throw new IngestKeyError('insufficient_scope', `This sign-in may not create telemetry keys (it holds none of ${MINT_SCOPES.join(', ')}). ${LOGIN_AGAIN}`);
  }
  let agentId = knownAgentId;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!agentId) agentId = await findOrCreateAgent(ctx);
    await boundLiveKeys(ctx, agentId, keepId);
    const r = await v3(ctx, 'POST', `/agents/${encodeURIComponent(agentId)}/credentials`, {
      name: `ingest ${agentName(ctx.harness, ctx.host)}`,
      scopes: [INGEST_SCOPE],
      harness: ctx.harness,
    });
    if (r.ok) return entryFrom(ctx, agentId, r.data);
    // The cached agent was deleted (404) or transferred away: look it up again by name, once.
    if (r.status === 404 && attempt === 0 && knownAgentId) {
      agentId = null;
      continue;
    }
    if (r.status === 409 && r.apiCode === 'agent_suspended') {
      throw new IngestKeyError(
        'agent_disabled',
        `The agent ${agentName(ctx.harness, ctx.host)} is not active in the Enforcer console. Enable it there to turn telemetry back on.`,
        {
          status: 409,
          apiCode: r.apiCode,
        },
      );
    }
    throw fail('Issuing the ingest credential', r);
  }
  throw new IngestKeyError('api', 'Issuing the ingest credential failed');
}

/** The slow path, under the lock: check the cached credential with v3, rotate it or mint a new one. */
async function refresh(ctx, cached) {
  if (cached) {
    const g = await v3(ctx, 'GET', `/agents/${encodeURIComponent(cached.agentId)}/credentials/${encodeURIComponent(cached.credentialId)}`);
    if (g.status === 401) throw fail('Checking the ingest credential', g);
    if (!g.ok && g.status !== 404) {
      // v3 unreachable or failing: a key that has not expired keeps working; check again next time.
      if (msLeft(cached, ctx.now()) > 0) return publicView(cached, 'cache');
      throw fail('Checking the ingest credential', g);
    }
    const c = g.ok ? g.data || {} : null;
    const live = c && !c.revoked_at && Date.parse(c.expires_at || cached.expiresAt || '') > ctx.now();
    if (live) {
      const cur = { ...cached, expiresAt: c.expires_at || cached.expiresAt };
      if (msLeft(cur, ctx.now()) > rotateWindow(cur)) {
        const next = { ...cur, checkedAt: new Date(ctx.now()).toISOString() };
        saveEntry(ctx.harness, next);
        return publicView(next, 'cache');
      }
      // Under the window: issue a fresh key on the same agent and let this one expire on its own. Rotate
      // and revoke are .destructive in agents-credentials; issuing is .write, which the default sign-in holds.
      let next;
      try {
        next = { ...(await mint(ctx, cached.agentId, cached.credentialId)), previousCredentialId: cached.credentialId };
      } catch (e) {
        // Could not replace it yet (v3 down, a scope, a cap): the current key still works until it expires.
        if (e?.code !== 'signed_out' && msLeft(cur, ctx.now()) > 0) return publicView(cur, 'cache');
        throw e;
      }
      saveEntry(ctx.harness, next);
      return publicView(next, 'rotated');
    }
  }
  const next = await mint(ctx, cached?.agentId || null);
  saveEntry(ctx.harness, next);
  return publicView(next, 'minted');
}

/**
 * A telemetry-only key for this machine + harness, minting, rotating or re-minting it as needed.
 *
 * Returns { key, credentialId, agentId, expiresAt, source } where source is 'cache', 'minted' or
 * 'rotated'. A caller that wrote the key into a harness config rewrites it whenever source is not
 * 'cache' (after a rotation the old key keeps working until its own expiry).
 *
 * Throws IngestKeyError (see its codes). Signed out: throws before any network call.
 * force: check the cached key with v3 now instead of trusting a check made within CHECK_EVERY_MS.
 * The other options are test seams.
 */
export async function ensureIngestKey(
  { harness, force = false, fetchImpl = globalThis.fetch, now = Date.now, hostname = osHostname(), sleep } = /** @type {any} */ ({}),
) {
  if (!INGEST_HARNESSES.includes(harness)) {
    throw new IngestKeyError('bad_harness', `unknown harness "${harness ?? ''}": expected one of ${INGEST_HARNESSES.join(', ')}`);
  }
  if (!isFederated())
    throw new IngestKeyError(
      'signed_out',
      'This machine is not signed in to Enforcer, so no telemetry key can be issued. Run /enforcer:login (or enforcer login).',
    );
  const base = trim(currentBase());
  const owner = credentialId();
  const cached = cachedEntry(harness, base, owner);
  if (!force && fresh(cached, now())) return publicView(cached, 'cache');

  const release = await acquireRefreshLock(LOCK_WAIT_MS, { path: lockPath(), staleMs: LOCK_STALE_MS });
  if (!release) {
    const e = cachedEntry(harness, base, owner);
    if (e && msLeft(e, now()) > 0) return publicView(e, 'cache');
    throw new IngestKeyError('busy', 'Another process is issuing the telemetry key and has held the lock for 30s; try again.');
  }
  try {
    // Re-read under the lock: whoever held it may have just minted or rotated this harness's key.
    const cur = cachedEntry(harness, base, owner);
    if (!force && fresh(cur, now())) return publicView(cur, 'cache');
    const headers = await authHeaders({ fetchImpl, now });
    if (!headers['X-API-Key'] && !headers.Authorization) {
      throw new IngestKeyError('signed_out', "Enforcer no longer accepts this machine's sign-in (the refresh was refused). Run /enforcer:login.");
    }
    const ctx = { harness, base, owner, host: hostname, headers, fetchImpl, now, sleep };
    return await refresh(ctx, cur);
  } finally {
    release();
  }
}

/**
 * Headers for an OTLP export with the cached key, or {} when there is none for this harness, sign-in
 * and base URL (call ensureIngestKey first). Synchronous and never touches the network, so it can
 * sit in a hot path; awaiting it is harmless.
 */
export function ingestHeaders(harness) {
  let base, owner;
  try {
    base = trim(resolveConfig().baseUrl);
    owner = credentialId();
  } catch {
    return {};
  }
  const e = cachedEntry(harness, base, owner);
  return e && msLeft(e, Date.now()) > 0 ? { 'X-API-Key': e.key } : {};
}

// ---- sign-out --------------------------------------------------------------------------------------

/** Why a cached key was not revoked server-side; `expires` is when it stops working on its own. */
const REVOKE_WHY = {
  scope: 'this sign-in lacks enforcer:agents-credentials.destructive',
  signed_out: 'Enforcer no longer accepts this sign-in',
  no_sign_in: 'no sign-in to revoke it with',
  elsewhere: 'it was issued by another Enforcer or another sign-in',
  error: 'Enforcer did not answer the revoke',
};
export { REVOKE_WHY };

/**
 * For sign-out: revoke every cached telemetry key with v3 where this sign-in may, then delete the cache
 * (and any temp file a crashed write left), so nothing in ~/.enforcer holds a key any more. Revoking needs
 * enforcer:agents-credentials.destructive, which the default sign-in does not hold, so it is best effort and
 * fails open: a key that could not be revoked is reported in `notRevoked` and expires on its own. The key
 * a rotation replaced (`previousCredentialId`) is revoked too; its secret was never cached.
 *
 * Call it BEFORE the sign-in is removed: the revoke uses it. Never throws.
 * Returns { file, deleted, keys: [secret], revoked: [{harness, credentialId}], notRevoked: [{harness, credentialId, why, expiresAt}] }.
 */
export async function forgetIngestKeys(
  { fetchImpl = globalThis.fetch, now = Date.now, sleep = undefined, timeoutMs = 5_000, lockWaitMs = 5_000 } = /** @type {any} */ ({}),
) {
  const file = INGEST_KEYS_FILE();
  const result = { file, deleted: false, keys: /** @type {string[]} */ ([]), revoked: /** @type {any[]} */ ([]), notRevoked: /** @type {any[]} */ ([]) };
  // A concurrent mint must not write a fresh key after the cache is gone: hold its lock when it can be had quickly.
  let release = null;
  try {
    release = await acquireRefreshLock(lockWaitMs, { path: lockPath(), staleMs: LOCK_STALE_MS });
  } catch {
    /* proceed without it */
  }
  try {
    // Read loosely: a cache written by a newer plugin still holds keys, and sign-out still removes them.
    const doc = readJson(file);
    const entries = Object.entries(doc && typeof doc === 'object' && doc.keys && typeof doc.keys === 'object' ? doc.keys : {}).filter(
      ([, e]) => e && typeof e === 'object',
    );
    result.keys = entries.map(([, e]) => e.key).filter((k) => typeof k === 'string' && k);
    const creds = entries.flatMap(([harness, e]) =>
      [e.credentialId, e.previousCredentialId]
        .filter((id) => typeof id === 'string' && id)
        .map((credentialId) => ({
          harness,
          credentialId,
          agentId: e.agentId,
          baseUrl: e.baseUrl,
          expiresAt: credentialId === e.credentialId ? e.expiresAt || null : null,
        })),
    );
    if (creds.length) {
      let base = null;
      try {
        base = trim(resolveConfig().baseUrl);
      } catch {
        /* no base: nothing can be revoked */
      }
      let headers = {};
      try {
        headers = base ? await authHeaders({ fetchImpl, now }) : {};
      } catch {
        headers = {};
      }
      const signedIn = !!(headers['X-API-Key'] || headers.Authorization);
      const ctx = { base, headers, fetchImpl, now, sleep, timeoutMs, retries: 0 };
      for (const c of creds) {
        const miss = (why) => result.notRevoked.push({ harness: c.harness, credentialId: c.credentialId, why, expiresAt: c.expiresAt });
        // The sign-in's token goes only to the origin it was made for, never to one named in a file.
        if (!base || typeof c.baseUrl !== 'string' || trim(c.baseUrl) !== base || typeof c.agentId !== 'string' || !c.agentId) {
          miss('elsewhere');
          continue;
        }
        if (!signedIn) {
          miss('no_sign_in');
          continue;
        }
        const r = await v3(ctx, 'POST', `/agents/${encodeURIComponent(c.agentId)}/credentials/${encodeURIComponent(c.credentialId)}/revoke`, {
          reason: 'signed out: enforcer logout on this machine',
        });
        // 404: the credential or its agent is already gone, which is what was wanted.
        if (r.ok || r.status === 404) result.revoked.push({ harness: c.harness, credentialId: c.credentialId });
        else if (r.status === 403) miss('scope');
        else if (r.status === 401) miss('signed_out');
        else miss('error');
      }
    }
  } catch {
    /* fail open: the cache is still deleted below */
  }
  try {
    const dir = SHARED_DIR();
    for (const name of readdirSync(dir)) if (/^\.ingest-keys\..*\.tmp$/.test(name)) rmSync(join(dir, name), { force: true });
  } catch {
    /* no dir */
  }
  try {
    rmSync(file, { force: true });
    result.deleted = true;
  } catch {
    /* reported by the caller's leftover scan */
  }
  release?.();
  return result;
}

// ---- CLI: enforcer ingest-key --harness <h> [--json] --------------------------------------------

/** Exit codes of `enforcer ingest-key`. */
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, signedOut: 3, agentDisabled: 4, insufficientScope: 5 });

export const USAGE = `usage: enforcer ingest-key --harness <${INGEST_HARNESSES.join('|')}> [--json]
  Prints this machine's telemetry-only Enforcer key for that harness (minting or rotating it as needed).
  stdout: the key alone, or with --json {"key","credentialId","agentId","expiresAt","source","harness","otlpBase"}.
  exit: 0 ok, 1 failed (v3 error, agent cap, too many live keys, busy), 2 usage, 3 signed out,
        4 the harness's agent is disabled in the console, 5 the sign-in lacks the agent scopes (log in again).
`;

/** `enforcer ingest-key` main. Only the key (or its JSON) goes to stdout; every message goes to stderr. */
export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), ensure = ensureIngestKey } = {}) {
  let harness = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--harness') harness = argv[++i] ?? null;
    else if (a.startsWith('--harness=')) harness = a.slice('--harness='.length);
    else if (a === '-h' || a === '--help') {
      out(USAGE);
      return EXIT.ok;
    } else {
      err(`enforcer ingest-key: unexpected argument "${a}"\n${USAGE}`);
      return EXIT.usage;
    }
  }
  if (!harness || !INGEST_HARNESSES.includes(harness)) {
    err(`enforcer ingest-key: ${harness ? `unknown harness "${harness}"` : '--harness is required'}\n${USAGE}`);
    return EXIT.usage;
  }
  try {
    const r = await ensure({ harness });
    out(json ? JSON.stringify({ ...r, harness, otlpBase: OTLP_BASE() }) + '\n' : `${r.key}\n`);
    return EXIT.ok;
  } catch (e) {
    err(`enforcer ingest-key: ${e?.message || e}\n`);
    if (e?.code === 'signed_out') return EXIT.signedOut;
    if (e?.code === 'agent_disabled') return EXIT.agentDisabled;
    if (e?.code === 'insufficient_scope') return EXIT.insufficientScope;
    if (e?.code === 'bad_harness') return EXIT.usage;
    return EXIT.failed;
  }
}
