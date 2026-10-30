// Captured-evidence store. Port of lib.py's append/load/sweep/select/merge;
// the jsonl it writes is byte-identical to the Python store's (json.dumps
// defaults: ", " and ": " separators, ensure_ascii).
import { openSync, closeSync, writeSync, fstatSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, evidenceDir } from './state.mjs';

export const EVIDENCE_CAP = 20;
export const RAW_RUN_CAP = 50 * 1024 * 1024;
export const SESSION_MAX_AGE_S = 7 * 24 * 3600;

export const evidencePath = (sid) => join(evidenceDir(), `${sid || 'unknown'}.jsonl`);

/** json.dumps(v) as Python writes it. */
export function pyDumps(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  return (
    '{' +
    Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${pyDumps(String(k))}: ${pyDumps(x)}`)
      .join(', ') +
    '}'
  );
}

// wx-lockfile, as governor/core/store.mjs: stale only when the owner pid is dead.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
function acquire(lock, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  const token = randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid}:${token}`);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch {}
    if (Date.now() > deadline) return null;
    try {
      const [pid] = readFileSync(lock, 'utf8').trim().split(':');
      if (+pid > 0 && !alive(+pid)) {
        try {
          unlinkSync(lock);
        } catch {}
        continue;
      }
      if (!(+pid > 0) && Date.now() - statSync(lock).mtimeMs > 5000) {
        try {
          unlinkSync(lock);
        } catch {}
        continue;
      }
    } catch {}
    sleep(5);
  }
}
function release(lock, token) {
  try {
    if (readFileSync(lock, 'utf8').split(':')[1] === token) unlinkSync(lock);
  } catch {}
}

/** Never throws. One O_APPEND write per record under the lock; past `cap` the raw output is dropped, then the record. */
export function appendEvidence(sid, record, cap = RAW_RUN_CAP) {
  try {
    const path = evidencePath(sid);
    const lock = path + '.lock';
    const token = acquire(lock);
    if (!token) return false;
    try {
      const fd = openSync(path, 'a', 0o600);
      try {
        const size = fstatSync(fd).size;
        let line = pyDumps(record) + '\n';
        const isObj = record && typeof record === 'object' && !Array.isArray(record);
        if (size + Buffer.byteLength(line) > cap && isObj && 'raw' in record) {
          record = { ...record };
          delete record.raw;
          record.raw_truncated = `run raw cap of ${cap} bytes reached`;
          line = pyDumps(record) + '\n';
        }
        if (size + Buffer.byteLength(line) > cap) return false;
        writeSync(fd, Buffer.from(line));
        return true;
      } finally {
        closeSync(fd);
      }
    } finally {
      release(lock, token);
    }
  } catch {
    return false;
  }
}

export function sweepSessions(maxAgeS = SESSION_MAX_AGE_S, now = Date.now() / 1000) {
  let removed = 0;
  for (const d of [evidenceDir(), dataDir()]) {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.(jsonl|json|count)$/.test(n)) continue;
      const f = join(d, n);
      try {
        const st = statSync(f);
        if (st.isFile() && now - st.mtimeMs / 1000 > maxAgeS) {
          rmSync(f);
          removed++;
        }
      } catch {}
    }
  }
  return removed;
}

export function loadEvidence(sid, runId = null) {
  const out = [];
  let text;
  try {
    text = readFileSync(evidencePath(sid), 'utf8');
  } catch {
    return out;
  }
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec === 'object' && !Array.isArray(rec) && rec.kind) {
      if (runId && rec._run && rec._run !== runId) continue;
      out.push(rec);
    }
  }
  return out;
}

export function clearEvidence(sid) {
  try {
    rmSync(evidencePath(sid));
  } catch {}
}

export const GATE_RE = /verify\.sh|go test|npm (run )?(check|test)|land-pr|pytest|test\/run\.sh|cargo test|make (test|verify)/;
export const PR_RE = /https?:\/\/github\.com\/[^/\s"')]+\/[^/\s"')]+\/pull\/\d+/;

export const isGate = (r) => r.kind === 'command' && GATE_RE.test(r.cmd || '');
/** The internal run marker leaves as `run_id`, so every evidence item names the run it was captured under. */
/** Only the runner (src/repo-checks.mjs, run by the report hook) writes `source: 'runner'`. A record from anywhere else
 *  that claims it is a forgery: a `check` record is dropped (null), any other loses its `source`. */
export function stripRunner(rec) {
  if (!rec || typeof rec !== 'object' || rec.source !== 'runner') return rec;
  if (rec.kind === 'check') return null;
  const { source, ...rest } = rec;
  return rest;
}

export function stripInternal(rec) {
  const { _run, ...rest } = rec;
  return _run ? { ...rest, run_id: _run } : rest;
}

/** The PR-body footer line that joins a pull request to its run. */
export const prFooter = (runId) => `Enforcer-Run: ${runId}`;

const failedCmd = (r) => r.kind === 'command' && r.exit !== 0 && r.exit !== null && r.exit !== undefined;

/** A final record: the run of acceptance line `line` (1-based) made for the report, by `enforcer evidence run` or the
 *  report hook. The judge reads these as the result; everything captured before them is how the work got there. */
export const isFinal = (r) => !!r && (r.kind === 'command' || (r.kind === 'check' && r.source === 'runner')) && Number.isInteger(r.line) && r.line > 0;

function ekey(r) {
  if (r.kind === 'command') return JSON.stringify(['command', r.cmd ?? null, r.exit ?? null]);
  if (r.kind === 'artifact') return JSON.stringify(['artifact', r.url ?? null]);
  if (r.kind === 'file') return JSON.stringify(['file', r.path ?? null, r.excerpt ?? null]);
  return null;
}

export function selectEvidence(records, cap = EVIDENCE_CAP) {
  if (!(cap > 0)) return [];
  // Final records come last, newest per line, and are never dropped for the cap: a worker that ran its acceptance
  // lines twice (a fix in between) shows the judge the second run, after the captured history, not an older one
  // buried in it. Before this (1.3.12) a hook-run acceptance record was the oldest item and the first the cap cut.
  const byLine = new Map();
  records.forEach((r, i) => {
    if (isFinal(r)) byLine.set(r.line, i);
  });
  if (byLine.size) {
    const finals = [...byLine.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, i]) => records[i])
      .slice(-cap);
    return [
      ...selectEvidence(
        records.filter((r) => !isFinal(r)),
        cap - finals.length,
      ),
      ...finals,
    ];
  }
  if (records.length <= cap) {
    const failed = records.filter(failedCmd);
    return failed.length ? [...failed, ...records.filter((r) => !failedCmd(r))] : [...records];
  }
  const idx = records.map((r, i) => [i, r]);
  const failed = idx.filter(([, r]) => failedCmd(r));
  const otherCmd = idx.filter(([, r]) => r.kind === 'command' && !failedCmd(r));
  const files = idx.filter(([, r]) => r.kind !== 'command');
  // a.slice(-0) is the whole list, exactly as Python's a[-0:]
  const last = (a, n) => a.slice(-n);
  const lastIf = (a, n) => (n > 0 ? a.slice(-n) : []);
  const keep = last(failed, cap);
  const room = cap - keep.length;
  const gates = last(
    otherCmd.filter(([, r]) => isGate(r)),
    Math.max(room, 0),
  );
  const gset = new Set(gates.map(([i]) => i));
  const rest = otherCmd.filter(([i]) => !gset.has(i));
  let tail = [...gates];
  tail = tail.concat(lastIf(rest, cap - keep.length - tail.length));
  tail = tail.concat(lastIf(files, cap - keep.length - tail.length));
  tail.sort((a, b) => a[0] - b[0]);
  return [...keep.map(([, r]) => r), ...tail.map(([, r]) => r)];
}

export function mergeEvidence(captured, passed, cap = EVIDENCE_CAP) {
  const seen = new Set(captured.map(ekey).filter(Boolean));
  let extra = [];
  for (const r0 of Array.isArray(passed) ? passed : []) {
    const r = stripRunner(r0);
    if (!r || typeof r !== 'object' || !['command', 'file', 'artifact'].includes(r.kind)) continue;
    if (!(r.cmd || r.path || r.url)) continue;
    const k = ekey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    extra.push(r);
  }
  if (extra.length > cap) {
    const withOut = extra.filter((r) => r.output);
    extra = (withOut.length ? withOut : extra).slice(-cap);
  }
  return [...selectEvidence(captured, Math.max(cap - extra.length, 0)), ...extra];
}
