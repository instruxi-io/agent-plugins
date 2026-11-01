// The shipping queue: which receipts have reached the control plane, and which
// have not. This is what turns a file the machine happens to hold into a
// record that outlives the machine.
//
// ADR 0001 called for SQLite at the edge. That was the right call when the
// edge also held the dashboard and needed indexed reads to answer "spend by
// client this month". In v3 those queries moved to the control plane, and what
// is left for the edge is append and ship — a log with a watermark, not a
// database. So this stays dependency-free and the plugin keeps installing with
// no build step, which is a property worth more than the query planner it
// gives up. If the edge ever needs to answer questions about its own history
// again, that is the moment to revisit it, not before.
//
// Positions are BYTE OFFSETS, not line numbers. The distinction is the whole
// point: reading from an offset costs what has been added, counting lines
// costs what exists. v1 re-read a 54MB transcript on every tool call for
// exactly this reason and it is the mistake worth not repeating.
//
// Deduplication is on the receipt HASH, not a sequence number. The hash is
// already unique, already tamper-evident, and already in every line, so
// at-least-once delivery needs no new field and no schema change: the server
// keeps what it has seen and ignores a repeat. A seq would have to be added
// outside the hashed body to avoid breaking existing chains, which would make
// it the one field in the record nothing protects.

import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, RECEIPTS, FILE_MODE, SHIP_COMPAT, readShipCompat } from './store.mjs';

const MARK = join(DIR, 'outbox.json');

// prevHash is the last CHAINED hash at the watermark: what the next shipped
// record's hash was computed against. The server verifies each record against
// its prev (chain.mjs), so the shipper has to know prev for the first record of
// a batch without re-reading everything before it.
//
// ackedHash is the newest chained hash the control plane has acknowledged
// (answered 200 for). verify() reports the record truncated when the file no
// longer holds it: unlike state.json's head, which loadState() re-derives from
// the file's own tail, nothing on the decision path rewrites it, and it does
// not follow a cut-down file backwards (markShipped).
//
// hashVersions is what the control plane said it verifies, from the
// Enforcer-Receipt-Hash-Versions header of its last 200: the governor writes
// hash v2 only once it includes 2 (hashVersion()).
const readMark = () => {
  try {
    const m = JSON.parse(readFileSync(MARK, 'utf8'));
    const prevHash = m.prevHash || 'genesis';
    return {
      shippedBytes: Number(m.shippedBytes) || 0,
      shippedAt: m.shippedAt || null,
      lastError: m.lastError || null,
      prevHash,
      // A mark written before ackedHash existed: its prevHash is exactly that,
      // the head of what the server acknowledged.
      ackedHash: typeof m.ackedHash === 'string' ? m.ackedHash : prevHash !== 'genesis' ? prevHash : null,
      hashVersions: Array.isArray(m.hashVersions) ? m.hashVersions.filter(Number.isInteger) : [1],
    };
  } catch {
    return { shippedBytes: 0, shippedAt: null, lastError: null, prevHash: 'genesis', ackedHash: null, hashVersions: [1] };
  }
};

const writeMark = (m) => {
  try {
    writeFileSync(MARK, JSON.stringify(m), { mode: FILE_MODE });
  } catch {
    return false;
  }
  // Remember that a shipper which writes hashVersions has written the mark, so
  // a later mark WITHOUT them is known to be an older shipper's rewrite and not
  // a record carried over from before the upgrade (noteLegacyShipper).
  const c = readShipCompat();
  if (c.markVersion !== 2) writeCompat({ ...c, markVersion: 2 });
  return true;
};

// tmp + rename: a reader sees the old note or the new one. Losing it costs at
// most the v1 hold below, never a receipt.
const writeCompat = (c) => {
  const tmp = `${SHIP_COMPAT}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(c), { mode: FILE_MODE });
    renameSync(tmp, SHIP_COMPAT);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
};

/**
 * Notice a shipper older than hash v2 sharing this record, and hold the
 * governor on v1 (store.mjs hashVersion()) while one is about.
 *
 * Every session on a machine ships from the same receipts.jsonl under the same
 * lock, whatever plugin version it runs, and a long-lived session keeps the
 * version it started with. A pre-v2 shipper does not know `hv`: it sends a v2
 * line without its version label, the control plane checks it as v1 and
 * refuses it as altered, and the old shipper's watermark moves past it anyway.
 * The next receipt the server stores names that refused line as its prev, and
 * is recorded as a chain break. That is what made parallel sessions look like
 * tampering. Such a shipper never writes `hashVersions`, so a mark without them,
 * after this code has written one with them, is its fingerprint.
 * @returns {boolean} true when one was seen just now
 */
export function noteLegacyShipper(now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(MARK, 'utf8'));
  } catch {
    return false;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw.hashVersions)) return false;
  const c = readShipCompat();
  if (c.markVersion !== 2) return false; // never written by a v2 shipper: an upgrade, not an old shipper
  writeCompat({ ...c, legacyShipperAt: now });
  return true;
}

/** Bytes currently in the record. */
function size() {
  try {
    return statSync(RECEIPTS).size;
  } catch {
    return 0;
  }
}

/**
 * Receipts written but not yet acknowledged by the control plane.
 * @returns {{lines:object[], ends?:number[], from:number, to:number, prevHash:string}} `to` is the offset to
 *   pass back to markShipped once the server has them. Only whole lines are
 *   returned: a half-written tail is left for the next call rather than sent
 *   as a truncated receipt that would fail verification on the far side.
 */
export function pending(limit = 500) {
  const { shippedBytes, prevHash: markPrev } = readMark();
  const end = size();
  // The record shrank, which means it was replaced or truncated rather than
  // appended to. The watermark describes a file that no longer exists, so
  // start over: re-shipping is harmless (the server dedupes on hash), whereas
  // reading from a meaningless offset would ship garbage.
  const from = end < shippedBytes ? 0 : shippedBytes;
  const prevHash = from === 0 ? 'genesis' : markPrev;
  if (end <= from) return { lines: [], from, to: from, prevHash };

  let chunk = '';
  try {
    const fd = openSync(RECEIPTS, 'r');
    const buf = Buffer.allocUnsafe(end - from);
    readSync(fd, buf, 0, buf.length, from);
    closeSync(fd);
    chunk = buf.toString('utf8');
  } catch {
    return { lines: [], from, to: from, prevHash };
  }

  const lastNL = chunk.lastIndexOf('\n');
  if (lastNL < 0) return { lines: [], from, to: from, prevHash };
  const complete = chunk.slice(0, lastNL);

  const lines = [];
  const ends = []; // ends[i]: the offset just past lines[i], where a batch that stops after it resumes
  let consumed = 0;
  for (const raw of complete.split('\n')) {
    const bytes = Buffer.byteLength(raw, 'utf8') + 1;
    if (lines.length >= limit) break;
    consumed += bytes;
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
      ends.push(from + consumed);
    } catch {
      /* an unparseable line is still consumed: it cannot be shipped and
               must not wedge the queue behind it forever */
    }
  }
  return { lines, ends, from, to: from + consumed, prevHash };
}

/**
 * The control plane has these. Advance the watermark.
 *
 * `chain` describes the batch, when there was one: `start` the prev its first
 * record chained from, `hashes` the chained hashes it carried, `hashVersions`
 * what the server's answer advertised. The acknowledged head moves to the
 * batch's head only when the batch CONTINUES it (started from it, or carried
 * it). A batch that does not is the record re-shipped from the top after the
 * file shrank; moving the acknowledged head then would forget the very
 * receipts the shrink removed.
 * @param {number} to
 * @param {number} [at]
 * @param {string} [prevHash]
 * @param {{start?: string, hashes?: string[], hashVersions?: number[]}} [chain]
 */
export function markShipped(to, at = Date.now(), prevHash = undefined, chain = undefined) {
  const m = readMark();
  // A watermark past the end of the record describes a file that no longer
  // exists — it was rotated, truncated or replaced. Without this the guard
  // below locks the queue permanently: every later offset is smaller than the
  // stale mark, markShipped refuses them all, and the same receipts ship on
  // every pass forever. pending() already restarts in this case; this is the
  // other half of that.
  const stale = m.shippedBytes > size();
  // Otherwise never move backwards: a late response from a slower batch must
  // not un-ship what a later one already delivered.
  if (!stale && to <= m.shippedBytes) return false;
  let ackedHash = m.ackedHash;
  if (chain && prevHash && prevHash !== 'genesis' && (!ackedHash || chain.start === ackedHash || (chain.hashes || []).includes(ackedHash)))
    ackedHash = prevHash;
  const hashVersions = chain && Array.isArray(chain.hashVersions) ? chain.hashVersions : m.hashVersions;
  return writeMark({ shippedBytes: to, shippedAt: at, lastError: null, prevHash: prevHash || m.prevHash, ackedHash, hashVersions });
}

/** The newest chained hash the control plane acknowledged, or null. */
export const ackedHash = () => readMark().ackedHash;

// The receipt hash version to write lives in store.mjs: the decision path
// needs it and must not load this module (test/hook-latency.test.mjs).
export { hashVersion } from './store.mjs';

/**
 * Parse an Enforcer-Receipt-Hash-Versions header value ("1,2") to [1, 2].
 * @param {string | null | undefined} header
 */
export const parseHashVersions = (header) => {
  const v = String(header || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return v.length ? v : [1];
};

/** Record why shipping failed, without losing the watermark. */
export function markFailure(message) {
  const m = readMark();
  return writeMark({ ...m, lastError: { at: Date.now(), message: String(message).slice(0, 200) } });
}

/** What /status should say about the queue. */
export function stats() {
  const m = readMark();
  const end = size();
  return {
    unshippedBytes: Math.max(0, end - m.shippedBytes),
    shippedAt: m.shippedAt,
    lastError: m.lastError,
    behind: end > m.shippedBytes,
  };
}
