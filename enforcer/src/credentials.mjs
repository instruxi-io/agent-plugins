// The one Enforcer credential on this machine: ~/.enforcer/credentials.json.
//
// Kept byte-compatible with enforcer-governor's copy of this module, because
// both plugins read and write the same file: sign in with either and both are
// signed in. Change the file format in one and the other breaks.
import { readFileSync, mkdirSync, renameSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, rmdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertSchema, stamp } from './schema.mjs';
import { envBaseUrl, DEFAULT_BASE_URL } from './config.mjs';

// ONE sign-in for everything Enforcer on this machine.
//
// The governor and the Enforcer MCP server used to authenticate separately:
// the governor from its own file, the MCP server through whatever the client
// negotiated. Signing in to one left the other signed out, which reads to a
// person as "I logged in and it still says I'm not". So the credential lives
// in ~/.enforcer/credentials.json, a location neither tool owns, and both read
// it: the hooks directly, the MCP server through bin/enforcer-headers.mjs,
// which the plugin registers as that server's headersHelper.
//
// The governor's old location is still read, so an existing install keeps
// working without a migration step; new writes go to the shared file.
const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
export const SHARED_DIR = () => process.env.ENFORCER_HOME || join(home(), '.enforcer');
export const SHARED_FILE = () => join(SHARED_DIR(), 'credentials.json');
// Where enforcer-governor kept the credential before the shared file existed.
const LEGACY_FILE = join(process.env.GOVERNOR_HOME || join(home(), '.enforcer-governor'), 'credentials.json');
export { DEFAULT_BASE_URL };

/** The legacy credential file's path when it still holds a credential, else null. */
export const legacyCredentialFile = () => {
  const l = readJson(LEGACY_FILE)?.enforcer;
  return l && (l.api_key || l.oauth?.access_token) ? LEGACY_FILE : null;
};

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** The stored credential document, shared file first. Null when there is none. */
export function readCredentials() {
  const shared = readJson(SHARED_FILE());
  try {
    if (shared) assertSchema(shared, SHARED_FILE());
  } catch (e) {
    process.stderr.write(`enforcer: ${e.message}\n`);
    return null;
  } // refuse newer state: signed out, never misread
  if (shared?.enforcer) return shared;
  const legacy = readJson(LEGACY_FILE);
  return legacy?.enforcer ? legacy : null;
}

/**
 * Write the shared credential document. Atomic (write then rename) so a
 * concurrent reader — the MCP helper runs while hooks do — never sees half a
 * file, and 0600 in a 0700 directory because this is a bearer secret.
 */
export function saveCredentials(doc) {
  const onDisk = readJson(SHARED_FILE());
  if (onDisk) assertSchema(onDisk, SHARED_FILE()); // never overwrite a newer file with an older shape
  doc = stamp(doc);
  const dir = SHARED_DIR();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to chmod */
  }
  const tmp = join(dir, `.credentials.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(doc, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, SHARED_FILE());
}

/**
 * Origins a token_endpoint or saved base_url may point at. Both come from
 * files an agent can write, so without this a planted file would have the
 * refresh token POSTed to an attacker. https only, and only the production
 * origin or the one the operator set in the environment (see config.mjs).
 */
export function allowedOrigins() {
  const out = new Set([new URL(DEFAULT_BASE_URL).origin]);
  try {
    if (envBaseUrl()) out.add(new URL(envBaseUrl()).origin);
  } catch {
    /* ignore */
  }
  return out;
}
export function isAllowedUrl(u) {
  try {
    const url = new URL(String(u));
    if (!allowedOrigins().has(url.origin)) return false;
    // https required, except for an origin the operator named in the environment.
    return url.protocol === 'https:' || (!!envBaseUrl() && url.origin === new URL(envBaseUrl()).origin);
  } catch {
    return false;
  }
}

/**
 * A saved base_url may be any https origin (self-hosted and staging installs
 * sign in to their own), or plain http to the loopback for local development.
 * Anything else is ignored. token_endpoint is stricter: isAllowedUrl.
 */
export function isSafeBase(u) {
  if (isAllowedUrl(u)) return true;
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.host.replace(/:\d+$/, '')));
  } catch {
    return false;
  }
}

// One refresh lock for Node and Python: a directory, because mkdir is atomic
// everywhere and both languages can use it (flock is not visible across them).
// A holder that died leaves a directory behind; past STALE_MS it is broken.
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const refreshLockPath = () => join(SHARED_DIR(), '.refresh.lock');

/** True when the lock records a pid on this machine that no longer exists. */
function lockHolderDead(lock) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

/**
 * Acquire the shared refresh lock; returns a release function, or null on timeout.
 * `path` and `staleMs` let another short critical section (the ingest-key mint, src/ingest-key.mjs)
 * use the same mkdir-lock pattern under its own directory, so the two never wait on each other.
 */
export async function acquireRefreshLock(timeoutMs = LOCK_TIMEOUT_MS, { path = refreshLockPath(), staleMs = LOCK_STALE_MS } = {}) {
  const dir = SHARED_DIR();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours */
  }
  const lock = path;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(join(lock, 'pid'), String(process.pid));
      } catch {
        /* the mtime rule still applies */
      }
      return () => {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          /* gone */
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        // A holder that died (pid gone) or sat past STALE_MS never releases: break its lock.
        if (lockHolderDead(lock) || Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* raced */
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(25);
  }
}

/** Enforcer's public origin for this credential. */
export function baseUrl(cfg = {}) {
  const saved = readCredentials()?.enforcer?.base_url;
  const b = (saved && isSafeBase(saved) ? saved : null) || cfg.centralUrl || DEFAULT_BASE_URL;
  return String(b).replace(/\/+$/, '');
}

/**
 * The Enforcer API key, or null when the edge is unauthenticated — which is a
 * normal state, not an error: the governor enforces locally with no account at
 * all, and a credential only buys federation.
 *
 * The environment wins over the file so CI and containers can inject one
 * without writing to a home directory that may not persist.
 */
export function enforcerKey() {
  const env = process.env.ENFORCER_API_KEY;
  if (env && env.trim()) return env.trim();
  const k = readCredentials()?.enforcer?.api_key;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

// Refresh this long before expiry, so a token is never presented with seconds
// left and rejected mid-flight. A caller whose headers outlive the call (Claude
// Code caches the OTel helper's for its debounce window) passes a larger skewMs.
export const REFRESH_SKEW_MS = 60_000;

/**
 * Headers that authenticate a request to Enforcer, or {} when signed out.
 *
 * An API key wins over an OAuth token when both are present: it is the
 * credential an operator deliberately placed, and it does not expire.
 * An OAuth access token close to expiry is refreshed first (the refresh_token
 * grant, #361) and the rotated pair written back, because the refresh token
 * is single-use: dropping the successor would sign the machine out.
 *
 * Never throws. A transient refresh failure (timeout, network, 5xx) retries once and keeps the
 * current pair, returning the access token while it is still unexpired; only a 4xx rejection
 * (invalid_grant, 400, 401) returns {} — signed out. The reason is written to oauth.last_refresh_error.
 *
 * skewMs: refresh when the token expires within this long. 60s suits a header used at once; a
 * header that is cached must still be valid when the cache is last used (see bin/enforcer-headers.mjs).
 */
export async function authHeaders({ fetchImpl = globalThis.fetch, now = Date.now, backoffMs = 250, skewMs = REFRESH_SKEW_MS } = {}) {
  const key = enforcerKey();
  if (key) return { 'X-API-Key': key };
  const doc = readCredentials();
  const o = doc?.enforcer?.oauth;
  if (!o?.access_token) return {};
  if (!o.expires_at || Date.parse(o.expires_at) - now() > skewMs) {
    return { Authorization: `Bearer ${o.access_token}` };
  }
  const stale = { Authorization: `Bearer ${o.access_token}` };
  if (!o.refresh_token || !o.token_endpoint || !o.client_id || typeof fetchImpl !== 'function') return {};
  if (!isAllowedUrl(o.token_endpoint)) return {};
  const release = await acquireRefreshLock();
  // A hook has a few seconds in total; if another process holds the lock
  // that long, use the token we have rather than block or lose it.
  if (!release) return stale;
  try {
    // Re-read under the lock: whoever held it before us may have rotated the pair.
    const cur = readCredentials();
    const c = cur?.enforcer?.oauth;
    if (c?.access_token && c.expires_at && Date.parse(c.expires_at) - now() > skewMs) {
      return { Authorization: `Bearer ${c.access_token}` };
    }
    const doc2 = cur || doc;
    const o2 = c || o;
    if (!o2.refresh_token || !isAllowedUrl(o2.token_endpoint)) return {};
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: o2.refresh_token, client_id: o2.client_id || o.client_id });
    // A token the server has not yet expired is still good: reuse it on a transient failure.
    const usable = o2.access_token && o2.expires_at && Date.parse(o2.expires_at) > now() ? { Authorization: `Bearer ${o2.access_token}` } : {};
    const record = (reason) => {
      try {
        saveCredentials({ ...doc2, enforcer: { ...doc2.enforcer, oauth: { ...o2, last_refresh_error: { at: new Date(now()).toISOString(), reason } } } });
      } catch {
        /* best effort */
      }
    };
    // Transient (timeout, network, 5xx): retry once after a short backoff, then keep the old pair untouched.
    // The refresh token is single-use, so after a lost response it may already be rotated server-side;
    // keeping it unchanged lets the next call replay it (the server answers a replay of the last-used token).
    let res = null;
    let reason = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(backoffMs);
      try {
        res = await fetchImpl(o2.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(1800),
        });
      } catch (e) {
        res = null;
        reason = `transient: ${e?.name || 'error'}`;
        continue;
      }
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        reason = `transient: HTTP ${res.status}`;
        res = null;
        continue;
      }
      break;
    }
    if (!res) {
      record(reason);
      return usable;
    }
    if (!res.ok && res.status >= 400 && res.status < 500) {
      // A refused refresh is retried once: another process may have rotated the pair, or the
      // refusal may be momentary. Re-read the file, and replay with whatever pair is current.
      await sleep(backoffMs);
      const again = readCredentials()?.enforcer?.oauth;
      if (again?.access_token && again.expires_at && Date.parse(again.expires_at) - now() > skewMs) {
        return { Authorization: `Bearer ${again.access_token}` };
      }
      const rt = again?.refresh_token || o2.refresh_token;
      try {
        const r2 = await fetchImpl(o2.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: o2.client_id || o.client_id }),
          signal: AbortSignal.timeout(1800),
        });
        if (r2.ok || r2.status >= 500) res = r2.status >= 500 ? null : r2;
        else res = r2;
      } catch {
        res = null;
        reason = 'transient: retry failed';
      }
      if (!res) {
        record(reason || 'transient: retry HTTP 5xx');
        return usable;
      }
    }
    if (!res.ok) {
      // Only a definite rejection (invalid_grant / 400 / 401 / other 4xx) signs the machine out.
      let code = '';
      try {
        code = (await res.json())?.error || '';
      } catch {
        /* no body */
      }
      record(`signed out: HTTP ${res.status}${code ? ` ${code}` : ''}`);
      return {};
    }
    let t;
    try {
      t = await res.json();
    } catch {
      record('transient: unreadable response');
      return usable;
    }
    if (!t?.access_token) {
      record('transient: no access_token in response');
      return usable;
    }
    const { last_refresh_error: _drop, ...clean } = o2;
    const next = {
      ...clean,
      access_token: t.access_token,
      refresh_token: t.refresh_token || o2.refresh_token,
      expires_at: new Date(now() + (Number(t.expires_in) || 900) * 1000).toISOString(),
      scope: t.scope || o2.scope,
      ...(Number(t.refresh_token_expires_in || t.refresh_expires_in) > 0
        ? { refresh_expires_at: new Date(now() + Number(t.refresh_token_expires_in || t.refresh_expires_in) * 1000).toISOString() }
        : {}),
    };
    saveCredentials({ ...doc2, enforcer: { ...doc2.enforcer, oauth: next } });
    return { Authorization: `Bearer ${next.access_token}` };
  } catch {
    return stale;
  } finally {
    release();
  }
}

/** A plain 'sign in again' sentence when the browser sign-in can no longer refresh, else null. */
export function signInProblem(doc = readCredentials(), nowMs = Date.now()) {
  const o = doc?.enforcer?.oauth;
  if (!o?.access_token || doc.enforcer.api_key) return null;
  const end = Date.parse(o.refresh_expires_at || '');
  if (Number.isFinite(end) && end <= nowMs) return `Enforcer sign-in expired at ${o.refresh_expires_at} and can no longer refresh: run /enforcer:login.`;
  const r = o.last_refresh_error;
  if (r?.reason?.startsWith('signed out')) return `Enforcer refused to refresh your sign-in at ${r.at} (${r.reason}): run /enforcer:login.`;
  return null;
}

/**
 * A stable, non-secret identifier for the key that authenticated a segment.
 *
 * Derived by hashing, not by truncating. The obvious implementation takes the
 * readable prefix plus the first few characters of the secret — which is how
 * most consoles display a key, and it is fine on a screen the owner is already
 * looking at. It is NOT fine here: this value goes into every receipt and every
 * log line, where it outlives the key and travels further than it does. A hash
 * identifies the key just as stably while carrying none of it.
 */
export function keyId(key = enforcerKey()) {
  if (!key) return null;
  const [prefix] = key.split('_', 1);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 10);
  return prefix && prefix !== key ? `${prefix}_${digest}` : digest;
}

/** Whether this install can talk to a control plane at all. */
export const isFederated = () => enforcerKey() !== null || !!readCredentials()?.enforcer?.oauth?.access_token;

/**
 * A stable, non-secret id for whatever credential is in use: the API key's
 * hash, or for an OAuth sign-in the client and account it belongs to (the
 * access token itself rotates every refresh, so it cannot name anything).
 */
export function credentialId() {
  const key = enforcerKey();
  if (key) return keyId(key);
  const o = readCredentials()?.enforcer?.oauth;
  if (!o?.client_id) return null;
  return (
    'oauth_' +
    createHash('sha256')
      .update(`${o.client_id}:${o.account_id || ''}`)
      .digest('hex')
      .slice(0, 10)
  );
}
