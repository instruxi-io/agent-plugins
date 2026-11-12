// The one Enforcer credential on this machine: ~/.enforcer/credentials.json.
//
// Kept byte-compatible with enforcer-governor's copy of this module, because
// both plugins read and write the same file: sign in with either and both are
// signed in. Change the file format in one and the other breaks.
import { readFileSync, mkdirSync, renameSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, rmdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

// Why the refresh runs in a detached process (2026-11-12, "signed out: HTTP 400 invalid_grant"
// minutes after every sign-in on a machine running several Claude Code sessions):
//
// The refresh token is single-use, and the server (enforcer-v3 loadRefresh) forgives a
// re-presented, already-rotated token exactly once and only for 30s (it mints a sibling); a
// second re-presentation is refused, and one after 30s is treated as theft and REVOKES THE
// FAMILY. So the rotated pair the server answers with is the only copy of the sign-in, and it
// exists only in the memory of the process that asked for it until saveCredentials renames it
// into place. Every caller here can die inside that window: a hook killed at its harness
// timeout or on an interrupt, a hook process that exits once its own deadline race is lost
// (bin/enforcer `event` ends with process.exit while the graph handler is still awaiting the
// token endpoint), the headers helper killed by its host, or this module's own 1.8s abort on a
// response that was already committed. The successor is then lost, the file keeps the rotated-
// out token, the next caller presents it (the 30s fork is spent the same way), and the first
// presentation after 30s revokes the family: invalid_grant until the next /enforcer:login.
// Server logs for the incident show exactly this: "sibling successor minted", then "refresh
// token reuse detected — revoking family" for the family whose token was still on disk.
//
// So the POST and the write-back run in a child that is detached from its caller (its own
// process group, not waited on by the event loop): whatever happens to the caller, the
// rotated pair reaches the file. The caller waits for the child for a bounded time and reads
// the result from the file. ENFORCER_REFRESH_INPROCESS=1 (or { detach: false }) keeps the
// refresh in the calling process, for tests that stub fetch and for the child itself.
const REFRESH_CHILD = fileURLToPath(new URL('./refresh-child.mjs', import.meta.url));
const IN_PROCESS_TIMEOUT_MS = 1800; // a hook has a few seconds in total
export const CHILD_TIMEOUT_MS = 3500; // per request; three requests stay inside LOCK_STALE_MS
export const CHILD_LOCK_WAIT_MS = 10_000;
const DETACH_WAIT_MS = 5000;
export const CHILD_SIGNED_OUT = 3; // refresh-child.mjs exit code: the server refused the refresh token
const detachDefault = () => process.env.ENFORCER_REFRESH_INPROCESS !== '1';
const fresh = (o, now, skewMs) => !!(o?.access_token && o.expires_at && Date.parse(o.expires_at) - now() > skewMs);
const bearer = (o) => ({ Authorization: `Bearer ${o.access_token}` });

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
 *
 * detach (default true unless ENFORCER_REFRESH_INPROCESS=1): run the refresh in a detached child,
 * so a caller killed mid-refresh cannot lose the rotated pair (see above). waitMs bounds how long
 * this call waits for it; the child finishes and saves regardless.
 */
export async function authHeaders({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  backoffMs = 250,
  skewMs = REFRESH_SKEW_MS,
  detach = detachDefault(),
  waitMs = DETACH_WAIT_MS,
} = {}) {
  const key = enforcerKey();
  if (key) return { 'X-API-Key': key };
  const doc = readCredentials();
  const o = doc?.enforcer?.oauth;
  if (!o?.access_token) return {};
  if (!o.expires_at || fresh(o, now, skewMs)) return bearer(o);
  if (!o.refresh_token || !o.token_endpoint || !o.client_id || typeof fetchImpl !== 'function') return {};
  if (!isAllowedUrl(o.token_endpoint)) return {};
  if (detach) {
    const r = await refreshDetached({ now, skewMs, waitMs, o });
    if (r) return r;
    // the child could not be started: refresh here, as before
  }
  return (await refreshUnderLock({ fetchImpl, now, backoffMs, skewMs, doc, o })).headers;
}

/** Start the detached refresher and wait for it (bounded). Null when it cannot be spawned. */
async function refreshDetached({ now, skewMs, waitMs, o }) {
  const usable = () => {
    const c = readCredentials()?.enforcer?.oauth || o;
    return c.access_token && c.expires_at && Date.parse(c.expires_at) > now() ? bearer(c) : {};
  };
  let child;
  try {
    // execArgv carries the caller's --import preloads (a test's fetch stub) into the child.
    child = spawn(process.execPath, [...process.execArgv, REFRESH_CHILD], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ENFORCER_REFRESH_INPROCESS: '1', ENFORCER_REFRESH_SKEW_MS: String(skewMs) },
    });
  } catch {
    return null;
  }
  const code = await new Promise((res) => {
    const t = setTimeout(() => res('waiting'), waitMs); // ref'd: keeps this process alive while it waits
    child.once('exit', (c) => {
      clearTimeout(t);
      res(c);
    });
    child.once('error', () => {
      clearTimeout(t);
      res('error');
    });
    child.unref(); // the child never holds its caller open, and outlives it
  });
  if (code === 'error') return null;
  const c = readCredentials()?.enforcer?.oauth;
  if (fresh(c, now, skewMs)) return bearer(c);
  if (code === CHILD_SIGNED_OUT) return {};
  return usable();
}

/**
 * The refresh itself, under the shared lock, in this process. Returns { headers, outcome } with
 * outcome one of fresh | refreshed | transient | signed_out | busy | invalid.
 */
export async function refreshUnderLock({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  backoffMs = 250,
  skewMs = REFRESH_SKEW_MS,
  timeoutMs = IN_PROCESS_TIMEOUT_MS,
  lockWaitMs = LOCK_TIMEOUT_MS,
  doc = readCredentials(),
  o = doc?.enforcer?.oauth,
} = {}) {
  if (!o?.access_token) return { headers: {}, outcome: 'invalid' };
  const stale = bearer(o);
  const release = await acquireRefreshLock(lockWaitMs);
  // A hook has a few seconds in total; if another process holds the lock
  // that long, use the token we have rather than block or lose it.
  if (!release) return { headers: stale, outcome: 'busy' };
  try {
    // Re-read under the lock: whoever held it before us may have rotated the pair.
    const cur = readCredentials();
    const c = cur?.enforcer?.oauth;
    if (fresh(c, now, skewMs)) return { headers: bearer(c), outcome: 'fresh' };
    let o2 = c || o;
    if (!o2.refresh_token || !isAllowedUrl(o2.token_endpoint)) return { headers: {}, outcome: 'invalid' };
    const clientId = o2.client_id || o.client_id;
    const post = (rt) =>
      fetchImpl(o2.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    // A token the server has not yet expired is still good: reuse it on a transient failure.
    const usable = o2.access_token && o2.expires_at && Date.parse(o2.expires_at) > now() ? bearer(o2) : {};
    // Stamp the failure on the pair we tried, and only while that pair is still the one on disk:
    // a sign-in or switch saved meanwhile must never be overwritten with the pair it replaced.
    const record = (reason) => {
      try {
        const disk = readCredentials();
        const d = disk?.enforcer?.oauth;
        if (!d || d.refresh_token !== o2.refresh_token) return; // signed out or replaced meanwhile
        const base = disk || cur || doc;
        saveCredentials({
          ...base,
          enforcer: { ...base.enforcer, oauth: { ...(d || o2), last_refresh_error: { at: new Date(now()).toISOString(), reason } } },
        });
      } catch {
        /* best effort */
      }
    };
    // Transient (timeout, network, 5xx): retry once after a short backoff, then keep the old pair.
    // After a lost response the token may already be rotated server-side; the server forgives ONE
    // re-presentation within its 30s grace (it mints a sibling), which is what this retry spends.
    let res = null;
    let reason = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(backoffMs);
      try {
        res = await post(o2.refresh_token);
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
      return { headers: usable, outcome: 'transient' };
    }
    if (!res.ok && res.status >= 400 && res.status < 500) {
      // Refused. Retry only when the file now holds a DIFFERENT refresh token (a writer outside this
      // lock saved one): replaying the refused token itself can only be refused again, and once the
      // server's grace has passed every replay is read as theft.
      await sleep(backoffMs);
      const again = readCredentials()?.enforcer?.oauth;
      if (fresh(again, now, skewMs)) return { headers: bearer(again), outcome: 'fresh' };
      if (again?.refresh_token && again.refresh_token !== o2.refresh_token && isAllowedUrl(again.token_endpoint)) {
        o2 = again; // from here on this is the pair being refreshed (and the one record() stamps)
        let r2 = null;
        try {
          r2 = await post(o2.refresh_token);
        } catch {
          r2 = null;
        }
        if (!r2 || r2.status >= 500) {
          record('transient: retry failed');
          return { headers: usable, outcome: 'transient' };
        }
        res = r2;
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
      return { headers: {}, outcome: 'signed_out' };
    }
    let t;
    try {
      t = await res.json();
    } catch {
      record('transient: unreadable response');
      return { headers: usable, outcome: 'transient' };
    }
    if (!t?.access_token) {
      record('transient: no access_token in response');
      return { headers: usable, outcome: 'transient' };
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
    const base = cur || doc;
    saveCredentials({ ...base, enforcer: { ...base.enforcer, oauth: next } });
    return { headers: bearer(next), outcome: 'refreshed' };
  } catch {
    return { headers: stale, outcome: 'transient' };
  } finally {
    release();
  }
}

/**
 * Run fn (which saves a new sign-in: login, workspace switch) under the refresh lock, so a
 * refresh in flight cannot write the pair fn replaced back over it. Waits past LOCK_STALE_MS,
 * so a dead holder's lock is broken; if the lock still cannot be had, fn runs anyway.
 */
export async function withCredentialLock(fn, timeoutMs = LOCK_STALE_MS + 1000) {
  const release = await acquireRefreshLock(timeoutMs);
  try {
    return await fn();
  } finally {
    release?.();
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
