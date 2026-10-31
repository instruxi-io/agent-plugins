// Ship the record to the control plane — receipts as OTLP log records.
//
// The receipt file is the record on this machine; this makes it a record that
// outlives the machine and that the organisation can read across its fleet.
// It is the ONLY place the governor sends receipts anywhere, and it sends them
// with the Enforcer credential the machine already holds: there is no database
// or broker credential on the edge, and never will be.
//
// WHY OTLP. It is the standard telemetry protocol, Claude Code already speaks it
// for its own metrics and events, and the server accepts both on one endpoint.
// OTLP/JSON over fetch keeps the plugin dependency-free: no gRPC library, no
// protobuf runtime, nothing to build.
//
// WHAT IS SENT, per receipt: the entry text, its hash, the hash it was chained
// to, and (for hash v2) enforcer.receipt.hashv = "2". The server recomputes the
// hash (chain.mjs: v1 over the exact text, v2 over its RFC 8785 form) and
// refuses a record that does not match, so an edited line is caught THERE, not
// just by /enforcer-governor:verify here. Its answer says which versions it
// verifies (Enforcer-Receipt-Hash-Versions); that is how the governor learns it
// may write v2 (outbox.mjs hashVersion()).
//
// WHEN. Never inside a hook's decision path: the hooks spawn bin/ship.mjs
// detached (see kick()), so a slow or absent network cannot add latency to a
// tool call. Delivery is at-least-once; the server skips a receipt it holds.

import { hookFetch } from './http.mjs';
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DIR, privateDir, FILE_MODE } from './store.mjs';
import { pending, markShipped, markFailure, parseHashVersions, noteLegacyShipper } from './outbox.mjs';
import { receiptHash, versionOf, GENESIS, VERSIONS } from './chain.mjs';
import { authHeaders, baseUrl, isFederated } from './credentials.mjs';

export const RECEIPT_SCOPE = 'enforcer-governor/receipts';
export const INGEST_PATH = '/api/v1/governance/otlp/v1/logs';
/** The ingest response header naming the receipt hash versions it verifies. */
export const HASH_VERSIONS_HEADER = 'Enforcer-Receipt-Hash-Versions';

const INSTALL = () => join(DIR, 'install.json');
const LOCK = () => join(DIR, '.ship.lock');

/**
 * This machine's stable id: the chain id the server files receipts under. One
 * per install, created once. Not derived from the credential, because the
 * credential changes with every sign-in and the chain must not.
 */
export function installId() {
  try {
    const id = JSON.parse(readFileSync(INSTALL(), 'utf8'))?.id;
    if (typeof id === 'string' && id) return id;
  } catch {
    /* first run */
  }
  const id = randomUUID();
  try {
    privateDir(DIR);
    writeFileSync(INSTALL(), JSON.stringify({ id, created_at: new Date().toISOString() }), { mode: FILE_MODE });
  } catch {
    /* an unwritable dir still ships this run under this id */
  }
  return id;
}

const kv = (key, value) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } });

/**
 * Turn receipt lines into one OTLP/JSON logs export.
 *
 * `prev` is the chained hash before the first line. Each line's hashed body is
 * the line minus `hash` — writeReceipt appends hash last, so removing it gives
 * back exactly the text a v1 hash covered. A v2 line (hv: 2) is hashed over
 * its canonical form, so its text needs no such care, and is sent with
 * enforcer.receipt.hashv = "2".
 *
 * A line whose hash does not follow from the running prev may still be honest:
 * the governor's state was reset and it chained from 'genesis' again. That
 * record is sent with prev = 'genesis' so it verifies, and the server records a
 * chain break — which is what happened — instead of refusing it as altered.
 * A line that verifies against neither is sent as-is and refused: it WAS altered.
 *
 * `newer`, when set, is the unknown hash version the batch stopped at: only
 * the first `count` lines were turned into records.
 *
 * @returns {{ body: object, prev: string, count: number, hashes: string[], newer?: unknown }}
 */
export function toOtlp(lines, prev, install, version = '') {
  const records = [];
  const hashes = [];
  const hashOf = (p, e) => {
    try {
      return receiptHash(p, e);
    } catch {
      return null;
    }
  };
  let newer;
  for (const line of lines) {
    const { hash, ...entry } = line;
    // A line hashed under a version this shipper does not know is not sent at
    // all, and nothing after it is: sent as-is it would be checked under the
    // wrong version and refused, the watermark would pass it, and the next
    // stored receipt would name it as prev -- a chain break on the server. The
    // batch stops here and the watermark with it, so the newer governor that
    // wrote the line (it shares this record) ships it labelled.
    if (hash && !VERSIONS.includes(versionOf(entry))) {
      newer = versionOf(entry);
      break;
    }
    const text = JSON.stringify(entry);
    const t = Date.parse(entry.ts);
    const record = {
      ...(Number.isFinite(t) ? { timeUnixNano: String(BigInt(t) * 1_000_000n) } : {}),
      body: { stringValue: text },
      attributes: [],
    };
    if (!hash) {
      record.attributes.push(kv('enforcer.receipt.chained', false));
    } else {
      let from = prev;
      if (hashOf(prev, entry) !== hash && hashOf(GENESIS, entry) === hash) from = GENESIS;
      record.attributes.push(kv('enforcer.receipt.hash', hash), kv('enforcer.receipt.prev', from), kv('enforcer.receipt.chained', true));
      // Only v2 is labelled: a server without v2 then refuses just these, and
      // every v1 record is sent exactly as it always was.
      if (versionOf(entry) !== 1) record.attributes.push(kv('enforcer.receipt.hashv', String(versionOf(entry))));
      prev = hash;
      hashes.push(hash);
    }
    // Which harness decided this, as attributes a collector can group by
    // without parsing the body. Per RECORD, not on the resource: the resource
    // is the install (one chain), and two harnesses may share a home and so a
    // chain and a batch. The body already carries the same two fields -- it is
    // the text that was hashed -- so these add a label, never a claim.
    //
    // NOT the receipt's `client`. The ingest stores `client` as the PROJECT the
    // decision was attributed to (the console's per-project spend), so filling
    // it from the harness would misfile every receipt. Lines written before
    // receipts named a harness get neither attribute.
    if (typeof entry.harness === 'string' && entry.harness) record.attributes.push(kv('enforcer.receipt.harness', entry.harness));
    if (typeof entry.adapter_version === 'string' && entry.adapter_version)
      record.attributes.push(kv('enforcer.receipt.adapter_version', entry.adapter_version));
    records.push(record);
  }
  return {
    body: {
      resourceLogs: [
        {
          resource: {
            attributes: [kv('service.name', 'enforcer-governor'), kv('enforcer.install_id', install), ...(version ? [kv('service.version', version)] : [])],
          },
          scopeLogs: [{ scope: { name: RECEIPT_SCOPE }, logRecords: records }],
        },
      ],
    },
    prev,
    count: records.length,
    hashes,
    ...(newer !== undefined ? { newer } : {}),
  };
}

/**
 * Ship one batch. Never throws.
 * @returns Promise<{ shipped?: number, rejected?: number, pending?: boolean, skipped?: string, error?: string }>
 */
export async function shipOnce(cfg = {}, { fetchImpl = hookFetch, now = Date.now, limit = 500 } = {}) {
  // Before anything here rewrites the mark: was it last written by a shipper
  // older than hash v2? Then the governor stays on v1 for a while (outbox.mjs).
  noteLegacyShipper(now());
  if (cfg.shipOn === false) return { skipped: 'shipping is switched off (shipOn)' };
  if (!isFederated()) return { skipped: 'not signed in to Enforcer' };
  const batch = pending(limit);
  if (!batch.lines.length) {
    // Only unparseable lines in range: advance past them so they cannot wedge the queue.
    if (batch.to > batch.from) markShipped(batch.to, now(), batch.prevHash);
    return { shipped: 0 };
  }
  const headers = await authHeaders({ fetchImpl, now });
  if (!headers['X-API-Key'] && !headers.Authorization) return { skipped: 'not signed in to Enforcer' };

  const { body, prev, count, hashes, newer } = toOtlp(batch.lines, batch.prevHash, installId(), cfg.version || '');
  let to = batch.to;
  if (newer !== undefined) {
    const why = `a receipt is hashed under version ${JSON.stringify(newer)}, which this governor cannot ship; the newer governor on this machine ships it`;
    if (!count) {
      markFailure(why);
      return { skipped: why };
    }
    to = batch.ends[count - 1];
  }
  const url = (cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '') + INGEST_PATH;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 200) {
      let rejected = 0;
      try {
        rejected = Number((await res.json())?.partialSuccess?.rejectedLogRecords) || 0;
      } catch {
        /* empty body is full success */
      }
      // Advance even past refused records: the server will never accept them,
      // and holding the watermark would resend them forever. They are still in
      // the local file, where /enforcer-governor:verify names them.
      // What the server verifies rides on the same answer. A 200 without the
      // header is a server that predates hash v2, and the governor goes back
      // to writing v1 -- which every server takes.
      const hashVersions = parseHashVersions(res.headers?.get?.(HASH_VERSIONS_HEADER));
      markShipped(to, now(), prev, { start: batch.prevHash, hashes, hashVersions });
      if (rejected) markFailure(`${rejected} receipt(s) refused by the control plane as altered or malformed`);
      return { shipped: count - rejected, rejected, pending: newer === undefined && batch.lines.length >= limit };
    }
    const why =
      res.status === 401 || res.status === 403
        ? "Enforcer did not accept this machine's credential; type /enforcer:login to sign in again"
        : `control plane answered HTTP ${res.status}`;
    markFailure(why);
    return { error: why };
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? 'control plane did not answer in time' : 'control plane unreachable';
    markFailure(why);
    return { error: why };
  }
}

/** Ship until caught up, bounded, holding a lock so two shippers never race. */
export async function shipAll(cfg = {}, deps = {}, maxBatches = 20) {
  if (!takeLock()) return { skipped: 'another shipper is running' };
  try {
    let total = 0,
      last = {};
    for (let i = 0; i < maxBatches; i++) {
      last = await shipOnce(cfg, deps);
      total += last.shipped || 0;
      if (!last.pending) break;
    }
    return { ...last, shipped: total };
  } finally {
    dropLock();
  }
}

// A lock file with a staleness bound: a shipper killed mid-flight must not
// block every later one.
const LOCK_STALE_MS = 2 * 60_000;
function takeLock() {
  try {
    privateDir(DIR);
  } catch {}
  try {
    closeSync(openSync(LOCK(), 'wx', FILE_MODE));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK()).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(LOCK());
        closeSync(openSync(LOCK(), 'wx', FILE_MODE));
        return true;
      }
    } catch {}
    return false;
  }
}
function dropLock() {
  try {
    unlinkSync(LOCK());
  } catch {}
}

// kick() and SHIPPER live in kick.mjs, so a hook can kick without loading this module.
export { kick, SHIPPER } from './kick.mjs';
