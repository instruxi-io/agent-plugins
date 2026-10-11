// Managed settings: the tenant's floor, under this machine's own config.
//
// config.json is a per-machine opinion. An organisation could publish a POLICY
// for actions a local rule matched, but not "spend is capped at $150 and the
// capability rules stay on" — and turning rulesOn off locally also stops the
// tenant's policy being consulted, because it is only asked about a matched
// rule. So the tenant's half now lives in enforcer-governance
// (GET /api/v1/governance/settings) and this file merges the two.
//
// STRICTER WINS, PER SETTING. Not "managed overrides": an operator who wants a
// tighter limit than their organisation's should keep it. Which direction is
// stricter is a property of the setting, so it is spelled out per key below
// rather than inferred.
//
// NOTHING HERE BLOCKS A TOOL CALL. The fetch happens on SessionStart and writes
// a cache file; every hook reads the cache and never the network. A machine
// that has never reached the control plane, or is signed out, simply has no
// managed floor — the same failure-open direction as every other check here,
// and the only honest one: a governor that refused to decide because a settings
// endpoint was slow would stop work over its own configuration.
// Lazy: only a refresh fetches, and a hook deciding a tool call never refreshes.
const hookFetch = async (...a) => (await import('./http.mjs')).hookFetch(...a);
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXED_DIR, privateDir, FILE_MODE } from './store.mjs';
import { normalizeBooleans, isOn, isOff } from './bool.mjs';
import { baseUrl, authHeaders, credentialId } from './credentials.mjs';

// FIXED_DIR, not DIR: GOVERNOR_HOME and ENFORCER_CONFIG_HOME redirect the
// governor's own records, never the organisation floor (store.mjs).
const CACHE = join(FIXED_DIR, 'managed-settings.json');
const PATH = '/api/v1/governance/settings';

// A day. The cache is refreshed on every SessionStart, so this is the ceiling
// on how long a machine that keeps starting sessions can run on a stale floor,
// not the expected age. Nothing expires it to "unmanaged": a tenant that has
// published a floor should not lose it because the network is down.
const TTL_MS = 24 * 60 * 60 * 1000;

// ── the merge ───────────────────────────────────────────────────────────────
// Every manageable setting, and what stricter MEANS for it. A setting absent
// from this table is not merged even if the API sends it: an unknown key has no
// stricter direction, and guessing one is how a managed value ends up loosening
// a machine's own configuration.

/** A cap where a smaller number is tighter, and 0 means "no cap". */
const cap = (managed, local) => {
  const m = Number(managed),
    l = Number(local);
  if (!Number.isFinite(m) || m <= 0) return local; // managed says "no cap"
  if (!Number.isFinite(l) || l <= 0) return m; // local says "no cap"
  return Math.min(m, l);
};
/** A plain number where smaller is tighter (0 is a real value, not "off"). */
const lower = (managed, local) => {
  const m = managed == null ? NaN : Number(managed),
    l = local == null ? NaN : Number(local);
  if (!Number.isFinite(m)) return local;
  if (!Number.isFinite(l)) return m;
  return Math.min(m, l);
};
/** A check: on is stricter, so a managed `true` cannot be turned off locally. */
const onWins = (managed, local) => (isOn(managed) ? true : local);
/** A check whose managed value stands as written (neither direction is safety). */
const managedWins = (managed, local) => (managed === undefined ? local : managed);

const MERGE = {
  dollars: cap,
  soft: lower, // the soft mark is a fraction: earlier is stricter
  softAction: (m, l) => (m === 'deny' || l === 'deny' ? 'deny' : l),
  dailyLimit: cap,
  weeklyLimit: cap,
  monthlyLimit: cap,
  burnLimit: cap,
  fleetBurnLimit: cap,
  fanoutLimit: cap,
  retryLimit: cap,
  budgetOn: onWins,
  rulesOn: onWins,
  policyOn: onWins,
  shipOn: onWins,
  adviseModel: onWins,
  policyTimeoutMs: managedWins,
  policyTtlSec: managedWins,
};

/**
 * Merge a tenant's managed settings into a local config.
 * Pure: the caller supplies both sides, so the rules are testable with no
 * network and no files.
 */
export function merge(local = {}, managed = {}) {
  const out = { ...local };
  for (const [key, value] of Object.entries(managed || {})) {
    const rule = MERGE[key];
    if (!rule) continue;
    const merged = rule(value, local[key]);
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

/** Which settings this machine is not free to loosen, for /config and /status. */
export function managedKeys(managed = {}) {
  return Object.keys(managed || {})
    .filter((k) => MERGE[k])
    .sort();
}

// ── the cache ───────────────────────────────────────────────────────────────

// ── per-process overrides ───────────────────────────────────────────────────
// config.json is machine-wide, so turning a check off for one harness turned it
// off for every harness and every dispatched worker. These variables scope a
// check to one process tree: a dispatcher sets ENFORCER_GOVERNOR_RULES=on for
// its workers, another launch leaves it unset.
//
// ONLY `on` IS TRUSTED. A project's own harness settings file can set
// environment variables for every session opened in it, so a repository could
// switch a user's rules off just by being opened. `on` is honored always (it
// only tightens); `off` is honored only when this machine's own config.json
// sets allowEnvOff: true (store.mjs reads that from the fixed per-user path,
// never from the environment). An ignored `off`, and any value that is neither
// word, is said once per process on stderr and shown by status and config. The
// managed merge runs after all of this, so an organisation `on` still wins.
export const ENV_OVERRIDES = Object.freeze({
  rulesOn: 'ENFORCER_GOVERNOR_RULES',
  budgetOn: 'ENFORCER_GOVERNOR_BUDGET',
  policyOn: 'ENFORCER_GOVERNOR_POLICY',
});

/**
 * What this process's environment says, split by what is done with it.
 * `applied` is { key: boolean } (the overrides that take effect), `ignoredOff`
 * lists keys whose `off` was refused for want of allowEnvOff, `unrecognised`
 * is { key: raw } for a set variable that is neither `on` nor `off`.
 */
export function envReading(env = process.env, cfg = {}) {
  const applied = {};
  const ignoredOff = [];
  const unrecognised = {};
  const allowOff = isOn(cfg?.allowEnvOff);
  for (const [key, name] of Object.entries(ENV_OVERRIDES)) {
    if (env?.[name] === undefined) continue;
    const raw = String(env[name]);
    const v = raw.trim().toLowerCase();
    if (v === 'on') applied[key] = true;
    else if (v === 'off') {
      if (allowOff) applied[key] = false;
      else ignoredOff.push(key);
    } else unrecognised[key] = raw;
  }
  return { applied, ignoredOff, unrecognised };
}

/** The settings this process's environment sets, as { key: boolean }. */
export const envOverrides = (env = process.env, cfg = {}) => envReading(env, cfg).applied;

/** One line per variable this environment sets that is NOT applied, for status and config. */
export function envIgnoredLines(env = process.env, cfg = {}) {
  const { ignoredOff, unrecognised } = envReading(env, cfg);
  return [
    ...ignoredOff.map((k) => `${ENV_OVERRIDES[k]}=off is ignored: config.json does not set allowEnvOff (enforcer governor set allowEnvOff true)`),
    ...Object.entries(unrecognised).map(([k, raw]) => `${ENV_OVERRIDES[k]}=${JSON.stringify(raw)} is ignored: expected on or off`),
  ];
}

// Once per process per variable: a hook process decides once, and status or
// config call withEnv more than once.
const noticed = new Set();
function notice(env, cfg) {
  for (const line of envIgnoredLines(env, cfg)) {
    if (noticed.has(line)) continue;
    noticed.add(line);
    try {
      process.stderr.write(`enforcer-governor: ${line}\n`);
    } catch {}
  }
}

/** Local config with this process's environment overrides applied. */
export const withEnv = (cfg = {}, env = process.env) => {
  notice(env, cfg);
  return { ...cfg, ...envOverrides(env, cfg) };
};

/** The config a decision actually uses: local, then the environment, floored by the tenant's. */
export const effective = (cfg = {}) => merge(withEnv(cfg), readManaged());

// How often SessionStart goes to the network. A session start is a foreground
// moment -- someone is waiting -- so most of them read the cache and return.
const REFRESH_MS = 60 * 60 * 1000;

export function stale({ now = Date.now } = {}) {
  try {
    const d = JSON.parse(readFileSync(CACHE, 'utf8'));
    return d.cred !== credentialId() || now() - (d.at || 0) > REFRESH_MS;
  } catch {
    return true;
  }
}

let staleNoted = false;
function noteStale() {
  if (staleNoted) return;
  staleNoted = true;
  try {
    process.stderr.write('enforcer-governor: organisation settings are over a day old (offline?); the last floor still applies\n');
  } catch {}
}

export function readManaged({ now = Date.now } = {}) {
  try {
    const d = JSON.parse(readFileSync(CACHE, 'utf8'));
    if (!d || typeof d.settings !== 'object' || d.settings === null) return {};
    const settings = normalizeBooleans(d.settings, 'organisation settings');
    // Fetched with a different credential: stale() sends SessionStart back to
    // the network, and refresh() replaces this floor once it succeeds with the
    // new credential. Until then the LAST floor stands; dropping it on a
    // mismatch let any process unset the floor by setting ENFORCER_API_KEY.
    // Nothing expires the floor: an old cache is still served, marked stale, with one notice.
    if (now() - (d.at || 0) > TTL_MS) {
      noteStale();
      return Object.defineProperty({ ...settings }, 'stale', { value: true, enumerable: false });
    }
    return settings;
  } catch {
    return {};
  }
}

function writeManaged(settings, at) {
  try {
    privateDir(FIXED_DIR);
    writeFileSync(CACHE, JSON.stringify({ at, cred: credentialId(), settings }), { mode: FILE_MODE });
  } catch {
    /* a cache we cannot write is a floor we do not apply */
  }
}

/**
 * Fetch the tenant's managed settings and cache them. Called on SessionStart,
 * never from a decision path. Never throws.
 *
 * @returns {Promise<{ok: boolean, settings?: object, detail?: string}>}
 */
export async function refresh(cfg = {}, { fetchImpl = hookFetch, now = Date.now, timeoutMs = 3000 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, detail: 'no fetch in this runtime' };
  if (!credentialId()) return { ok: false, detail: 'not signed in to Enforcer' };
  try {
    const headers = await authHeaders({ fetchImpl, now });
    if (!headers['X-API-Key'] && !headers.Authorization) return { ok: false, detail: 'not signed in to Enforcer' };
    const base = (cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}${PATH}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    const settings = body?.data?.settings;
    if (!settings || typeof settings !== 'object') return { ok: false, detail: 'no settings in the response' };
    writeManaged(settings, now());
    return { ok: true, settings };
  } catch (e) {
    const detail = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `no answer within ${timeoutMs}ms` : 'Enforcer could not be reached';
    return { ok: false, detail };
  }
}

// ── decisioning mode ────────────────────────────────────────────────────────
const CHECK_NAMES = Object.freeze({ rulesOn: 'rules', budgetOn: 'budget', policyOn: 'policy' });

/**
 * The one line that says whether the governor is deciding anything. Checks
 * that are on are named; one forced on by an organisation floor is marked
 * "(organisation)", one set by this process's environment "(environment)".
 * The organisation wins when both apply, since it is the floor.
 */
export function decisioningLine(cfg = {}, { managed = readManaged(), env = process.env } = {}) {
  const fromEnv = envOverrides(env, cfg);
  const applied = merge(withEnv(cfg, env), managed);
  const on = Object.keys(CHECK_NAMES)
    .filter((k) => isOn(applied[k]))
    .map((k) => {
      const mark = isOn(managed[k]) ? ' (organisation)' : k in fromEnv ? ' (environment)' : '';
      return CHECK_NAMES[k] + mark;
    });
  return on.length ? `Decisioning: ON (${on.join(', ')})` : 'Decisioning: OFF (report only). Turn on: enforcer governor enable rules';
}
