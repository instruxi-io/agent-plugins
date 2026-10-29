// Local state for the governor. No daemon, no socket, no port.
//
// v1 ran an HTTP daemon on :4000 so hooks could share state. That bought one
// thing (state in memory) and cost several: a process to manage, a port to
// collide, "is it running?" as a user-facing question, and an unauthenticated
// local API that any web page could reach. v2 keeps state in files instead.
// Nothing listens, so none of that exists.
//
// The price is a lock. Hooks are separate processes and Claude Code runs tool
// calls in parallel, so the receipt chain has the same ordering problem the
// daemon solved with a promise queue: hashes are computed in decision order,
// so the lines have to LAND in decision order. Here that is an exclusive
// lockfile held across read-decide-append.
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeState, DEFAULTS, dropRecent } from './policy.mjs';
import { normalizeBooleans, isOn } from './bool.mjs';
import { migrateDir } from './migrate.mjs';
import { receiptHash, GENESIS } from './chain.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
// Governor records live under ~/.config/enforcer/governor. Before 2.10 they were
// in ~/.enforcer-governor; the first run moves them (receipt chain intact) and
// leaves MOVED_TO behind. GOVERNOR_HOME, when set, is used as given.
export const CONFIG_HOME = process.env.ENFORCER_CONFIG_HOME || join(HOME, '.config', 'enforcer');
export const LEGACY_DIR = join(HOME, '.enforcer-governor');
export const DIR = process.env.GOVERNOR_HOME || join(CONFIG_HOME, 'governor');
// The organisation floor's cache (managed.mjs) lives at a FIXED per-user path,
// derived from the home directory only: GOVERNOR_HOME and ENFORCER_CONFIG_HOME
// are ignored for it, so a process cannot drop the floor by pointing them at an
// empty directory.
export const FIXED_DIR = join(HOME, '.config', 'enforcer', 'governor');
if (!process.env.GOVERNOR_HOME) migrateDir(LEGACY_DIR, DIR);
export const RECEIPTS = join(DIR, 'receipts.jsonl');
const STATE = join(DIR, 'state.json');
const CONFIG = join(DIR, 'config.json');
const LOCK = join(DIR, '.lock');

// ── Private by default ──────────────────────────────────────────────────────
// Receipts, config, the identity cache (email and account id), the outbox
// watermark and the per-session scratch files are this user's alone. Under a
// common umask of 022 a plain mkdir/write leaves them world-readable, so every
// directory here is created 0700 and every file 0600, and a process tightens
// what an older version left behind once, on start. chmod is best-effort: on
// Windows it changes nothing and that is fine.
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
/** mkdir -p with mode 0700, then chmod: the umask narrows the create mode, and an existing dir keeps its old one. */
export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {}
}
const tighten = (p) => {
  const m = statSync(p).mode & 0o777;
  if (m & 0o077) chmodSync(p, m & 0o700);
};
const inside = (child, parent) => {
  const r = relative(parent, child);
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
};
/**
 * Take group and other bits off the governor's directories and the files
 * directly in them (0755 becomes 0700, 0644 becomes 0600). Owner bits are left
 * as they are: a directory its owner made 000 stays 000. Never throws.
 */
export function hardenPermissions(dirs = [DIR, FIXED_DIR]) {
  if (process.platform === 'win32') return;
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    try {
      if (!existsSync(d)) continue;
      // The enforcer config home above the governor dir holds sessions and
      // credentials too: it is private as well.
      if (inside(d, CONFIG_HOME) && existsSync(CONFIG_HOME)) tighten(CONFIG_HOME);
      tighten(d);
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        try {
          tighten(join(d, ent.name));
        } catch {}
      }
    } catch {}
  }
}
hardenPermissions();

const readJSON = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};

// ── The lock ────────────────────────────────────────────────────────────────
// `wx` fails if the file exists, and that failure is atomic on every platform
// we care about -- which is the whole mechanism. The lock file carries its
// owner's pid and a token. A lock is stale only when that pid is dead (a live
// holder is waited on, never broken by age), and release() removes the file
// only when the token is still ours, so a late release can never delete the
// lock a later process now holds.
const WAIT_MS = 2000;
const UNREADABLE_MS = 5000; // a lock with no readable owner: its writer died between open and write
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let myToken = null;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const lockOwner = () => {
  try {
    const [pid, token] = readFileSync(LOCK, 'utf8').trim().split(':');
    return Number.isInteger(+pid) && +pid > 0 && token ? { pid: +pid, token } : null;
  } catch {
    return undefined;
  } // vanished
};
// Remove the lock only if it is still the one we judged stale.
const breakStale = (seen) => {
  const now = lockOwner();
  if (now === undefined) return;
  if ((seen && now && now.token === seen.token) || (!seen && !now)) {
    try {
      unlinkSync(LOCK);
    } catch {}
  }
};

function acquire() {
  const deadline = Date.now() + WAIT_MS;
  const token = randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx', FILE_MODE);
      try {
        writeSync(fd, `${process.pid}:${token}`);
      } finally {
        closeSync(fd);
      }
      myToken = token;
      return true;
    } catch {}
    // The deadline is checked before anything below can `continue` past it, so
    // an unreachable directory fails open instead of spinning forever.
    if (Date.now() > deadline) return false;
    try {
      const owner = lockOwner();
      if (owner && !alive(owner.pid)) {
        breakStale(owner);
        continue;
      }
      if (owner === null && Date.now() - statSync(LOCK).mtimeMs > UNREADABLE_MS) {
        breakStale(null);
        continue;
      }
    } catch {} // vanished between the calls: retry after a beat
    sleep(15);
  }
}
const release = () => {
  const owner = lockOwner();
  if (owner && owner.token === myToken) {
    try {
      unlinkSync(LOCK);
    } catch {}
  }
  myToken = null;
};

// Run fn holding the lock. Returns { ok, value }. Never throws: a governor that
// crashes the hook is worse than one that fails to record.
export function withLock(fn) {
  try {
    privateDir(DIR);
  } catch {}
  if (!acquire()) return { ok: false, value: undefined };
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false, value: undefined };
  } finally {
    release();
  }
}

// policy.mjs owns the chain (record() hashes against state.prevHash), so this
// only has to carry that state across processes. `chain` is the in-memory tail
// and is deliberately not persisted: the FILE is the record, and verify()
// walks it. chainStart is set to the recovered head so an in-memory check
// starts from the oldest link this process actually knows about.
// The head of the receipt file: the hash of its last hashed line, read from the
// tail so a long record costs one small read. null when there is none.
export function receiptHead(file = RECEIPTS) {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 1 << 16);
    const fd = openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lines = text.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (typeof e.hash === 'string') return e.hash;
      } catch {}
    }
  } catch {}
  return null;
}

export const UNMAPPED_CAP = 100;
const DAY_MS = 86400000;
// Keep the state file small however many sessions have run: drop each agent's `recent`, drop agents idle
// longer than sweepDays (0 keeps forever; an escalated agent or one with a pendingAsk is never dropped;
// one with no lastSeen, from an older file, is stamped now rather than dropped) and keep the newest
// UNMAPPED_CAP unmapped folders (object order is insertion order, so the tail is the newest).
// Only a plain idle `active` agent is evictable: any other status or any human-set field is a latch.
const evictable = (a) =>
  (a.status === undefined || a.status === 'active') && !a.groundedBy && !a.budgetRaised && !a.burnFlagged && !a.pendingAsk && !a.escalated;
function bound(s, now = Date.now()) {
  const days = Number(loadConfig().sweepDays ?? DEFAULTS.sweepDays);
  const cutoff = Number.isFinite(days) && days > 0 ? now - days * DAY_MS : null;
  for (const [id, a] of Object.entries(s.agents || {})) {
    if (!a || typeof a !== 'object') continue;
    dropRecent(a);
    if (typeof a.lastSeen !== 'number') a.lastSeen = now;
    else if (cutoff !== null && a.lastSeen < cutoff && evictable(a)) delete s.agents[id];
  }
  const keys = Object.keys(s.unmapped || {});
  if (keys.length > UNMAPPED_CAP) {
    const keep = {};
    for (const k of keys.slice(-UNMAPPED_CAP)) keep[k] = s.unmapped[k];
    s.unmapped = keep;
  }
}

export function loadState() {
  const s = makeState();
  const saved = readJSON(STATE, null);
  if (saved) {
    for (const k of ['agents', 'periods', 'burn', 'spawns', 'clients', 'unmapped', 'prevHash', 'sweptAt']) {
      if (saved[k] !== undefined) s[k] = saved[k];
    }
  }
  // The file is the record. A crash between the receipt and the state write, or
  // a state file that is gone or half-written, leaves state behind the chain:
  // continue from the chain's own head so the next receipt extends it.
  const head = receiptHead();
  if (head && head !== s.prevHash) s.prevHash = head;
  if (saved) bound(s);
  s.chainStart = s.prevHash;
  return s;
}

// tmp + fsync + rename: a reader sees the old state or the new one, never half.
export function saveState(s) {
  const { chain, ...rest } = s; // never persist the tail
  const tmp = STATE + '.' + process.pid + '.tmp';
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(rest));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, STATE);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
// A MISSING config.json is a fresh install: the defaults apply and decisioning
// is off. One that EXISTS but cannot be read or parsed is not a fresh install:
// with decisioning off by default, falling back to `{}` there would let one
// chmod (or a garbage write) switch the capability rules off. So that case
// keeps the rules ON (they fail closed, README) and says so once per process;
// spend checks keep failing open, so budgetOn is left to the defaults.
let unreadableNoticed = false;
// allowEnvOff lets an environment `off` turn a check off (managed.mjs). It is
// read from the config.json at the FIXED per-user path only: a process that
// points GOVERNOR_HOME or ENFORCER_CONFIG_HOME at a directory of its own must
// not be able to opt itself in.
const FIXED_CONFIG = join(FIXED_DIR, 'config.json');
export function loadConfig() {
  const c = normalizeBooleans(readConfig(CONFIG), 'config.json');
  if (resolve(CONFIG) === resolve(FIXED_CONFIG)) return c;
  const out = { ...c };
  delete out.allowEnvOff;
  try {
    const fixed = JSON.parse(readFileSync(FIXED_CONFIG, 'utf8'));
    if (isOn(normalizeBooleans(fixed, 'config.json')?.allowEnvOff)) out.allowEnvOff = true;
  } catch {}
  return out;
}
function readConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    return unreadableConfig(e?.code || 'unreadable');
  }
  try {
    const c = JSON.parse(text);
    if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  } catch {}
  return unreadableConfig('not a JSON object');
}
function unreadableConfig(why) {
  if (!unreadableNoticed) {
    unreadableNoticed = true;
    try {
      process.stderr.write(`enforcer-governor: ${CONFIG} cannot be read (${why}); the capability rules stay on until it can\n`);
    } catch {}
  }
  return { rulesOn: true };
}
export const saveConfig = (c) => {
  try {
    privateDir(DIR);
    writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: FILE_MODE });
  } catch {}
};

// Write the line record() already hashed. Caller holds the lock, so lines land
// in decision order -- twelve agents deciding at once was enough to interleave
// concurrent appends and break a chain that was perfectly correct in memory.
export function writeReceipt(entry, hash) {
  // A line with no hash must say so (`chained: false`, the blind path): verify()
  // accepts those as recorded-but-unchained and rejects any other hashless line.
  try {
    appendFileSync(RECEIPTS, JSON.stringify(hash ? { ...entry, hash } : entry) + '\n', { mode: FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

// Append the receipt, then (only if the append landed) advance the chain head
// and persist the state. A failed append -- disk full -- leaves the head where
// it was, so the next receipt extends the last line that really exists.
export function commit(state, entry, hash, before = state.prevHash) {
  if (!writeReceipt(entry, hash)) {
    state.prevHash = before;
    return false;
  }
  state.prevHash = hash;
  saveState(state);
  return true;
}

/**
 * The receipt hash version to write: 2 once the control plane has said it
 * verifies v2 (outbox.json `hashVersions`, written by the shipper from the
 * Enforcer-Receipt-Hash-Versions header of its last 200), else 1. Until then a
 * v2 receipt would be refused as altered by a server that only knows v1. Here,
 * not in outbox.mjs, because the decision path reads it and outbox.mjs is
 * loaded lazily, off that path.
 */
export function hashVersion() {
  const m = readJSON(join(DIR, 'outbox.json'), null);
  return m && Array.isArray(m.hashVersions) && m.hashVersions.includes(2) ? 2 : 1;
}

// Walk the file, not memory: the file is the record. Names the first line
// that does not add up, so an edit or a deletion anywhere is named -- and
// still counts every line, so "line 3 of N" says how much of the record
// sits after the break.
//
// Each line is checked under the hash version it names (chain.mjs): v1 lines,
// then v2 ones chained onto them, verify as one chain.
//
// A LAST line with no hash is a break (unhashedTail), even one that says
// `chained: false`. Mid-file, a stripped hash shows: the next line no longer
// follows. At the end there is no next line, and a stripped hash plus an added
// `chained: false` looks exactly like the blind path's own refusal, so until a
// chained decision is recorded after it the two cannot be told apart.
//
// `acked` is the newest hash the control plane acknowledged (outbox.mjs
// ackedHash()). A file that no longer holds it ends before what the server
// has: `truncated`. Unlike state.json's head, which loadState() re-derives
// from the file's tail on the next decision, nothing on the decision path
// rewrites it, so a cut-off end stays visible after the governor carries on.
//
// What this cannot see: a file truncated AND its state.json and outbox.json
// deleted (or all rewritten together) chains cleanly from genesis, because
// everything it is checked against lives on this machine. The receipts shipped
// to the server are the only copy outside it, and so the only external anchor;
// receipts not yet shipped were never acknowledged.
export function verify(file = RECEIPTS, { state, acked } = /** @type {any} */ ({})) {
  const ackedHead = typeof acked === 'string' && acked && acked !== GENESIS ? acked : null;
  if (!existsSync(file)) {
    // No file is a fresh install only when state never recorded a head.
    const st = state ?? (file === RECEIPTS ? readJSON(STATE, null) : null);
    if (st && typeof st.prevHash === 'string' && st.prevHash && st.prevHash !== 'genesis') {
      return { ok: false, receipts: 0, brokeAt: 0, missing: true, head: st.prevHash };
    }
    if (ackedHead) return { ok: false, receipts: 0, brokeAt: 0, missing: true, truncated: true, head: ackedHead };
    return { ok: true, receipts: 0, brokeAt: 0 };
  }
  let prev = 'genesis',
    n = 0,
    legacy = 0,
    brokeAt = 0,
    breakCount = 0,
    linked = 0,
    hashed = false;
  const breaks = [];
  const seen = new Set();
  // The last line, when it was counted unverifiable rather than checked.
  let tail = null;
  const broke = () => {
    if (!brokeAt) brokeAt = n;
    breakCount++;
    if (breaks.length < 50) breaks.push(n);
  };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    n++;
    tail = null;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      broke();
      continue;
    }
    const { hash, ...body } = e;
    if (!hash && (hashed || e.chained === false)) tail = { blind: e.chained === false };
    // Lines from before the chain existed may open the file; once a hashed line
    // has been seen, a line without one is a stripped hash, not history.
    if (!hash) {
      if (e.chained === false) {
        legacy++;
        continue;
      } // the blind path's own, declared as such: unverifiable, not tampering
      if (hashed) {
        broke();
        continue;
      }
      legacy++;
      continue;
    }
    hashed = true;
    seen.add(hash);
    let expect = null;
    try {
      expect = receiptHash(prev, body);
    } catch {
      /* a version this cannot check is a break */
    }
    if (expect !== hash) broke();
    else linked++;
    // Re-anchor on the stored hash, so the walk goes on past a break and counts
    // what still chains. This only adds information: a break stays a failure.
    prev = hash;
  }
  // An unhashed last line: counted unverifiable above (or already a break, for
  // one that does not say `chained: false`); at the end it is a break.
  const unhashedTail = !!tail;
  if (tail && tail.blind) {
    legacy--;
    broke();
  }
  const st0 = state ?? (file === RECEIPTS ? readJSON(STATE, null) : null);
  const headMatches = !!(st0 && typeof st0.prevHash === 'string' && hashed && st0.prevHash === prev);
  if (brokeAt)
    return { ok: false, receipts: n, brokeAt, breaks, breakCount, linked, headMatches, ...(unhashedTail ? { unhashedTail, blind: !!tail.blind } : {}) };
  // The head must be the one state last recorded: a truncated tail still chains
  // line by line, and only the head shows that lines are missing.
  const st = state ?? (file === RECEIPTS ? readJSON(STATE, null) : null);
  if (st && typeof st.prevHash === 'string' && hashed && st.prevHash !== prev) {
    return { ok: false, receipts: n, brokeAt: n, headMismatch: true, head: prev, breaks, breakCount, linked, headMatches: false };
  }
  if (ackedHead && !seen.has(ackedHead)) {
    return { ok: false, receipts: n, brokeAt: 0, truncated: true, head: prev, breaks, breakCount, linked, headMatches: true };
  }
  return { ok: true, receipts: n, brokeAt: 0, unverifiable: legacy || undefined, head: prev, breaks, breakCount, linked, headMatches: true };
}
