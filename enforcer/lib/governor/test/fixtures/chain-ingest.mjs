// Test doubles for the two ends of receipt shipping that a test cannot run for
// real: the control plane's receipt ingest, and a shipper from a governor older
// than hash v2 that still shares this machine's record.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '../../core/jcs.mjs';
import { V2_PREFIX } from '../../core/chain.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const attrsOf = (rec) => Object.fromEntries((rec.attributes || []).map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]));

/**
 * The control plane's receipt ingest, reduced to what decides a chain break:
 * enforcer-governance internal/ingest (receipthash.go hashVersion/ReceiptHash:
 * the version is the enforcer.receipt.hashv attribute, absent is v1, a hash
 * that does not follow is refused as altered) and postgres.go appendReceiptsTx
 * (one head per chain; skip a receipt already held; a chained receipt whose
 * prev is not the head is stored with brk = true). Use it as fetchImpl.
 */
export function fakeIngest() {
  const s = { head: null, rows: [], held: new Set(), refused: [] };
  s.fetch = async (_url, init) => {
    const recs = JSON.parse(init.body).resourceLogs[0].scopeLogs[0].logRecords;
    let rejected = 0;
    for (const rec of recs) {
      const a = attrsOf(rec);
      const text = rec.body.stringValue;
      if (a['enforcer.receipt.chained'] === false) {
        s.rows.push({ text, chained: false, brk: false });
        continue;
      }
      const v = a['enforcer.receipt.hashv'] === undefined ? 1 : Number(a['enforcer.receipt.hashv']);
      const prev = a['enforcer.receipt.prev'];
      const want = v === 1 ? sha(prev + text) : v === 2 ? sha(V2_PREFIX + prev + '\n' + canonicalize(JSON.parse(text))) : null;
      if (want !== a['enforcer.receipt.hash']) {
        rejected++;
        s.refused.push(a['enforcer.receipt.hash']);
        continue;
      }
      if (s.held.has(want)) continue;
      s.held.add(want);
      const brk = s.head !== null && s.head !== prev;
      s.rows.push({ hash: want, prev, chained: true, brk });
      s.head = want;
    }
    return {
      status: 200,
      headers: new Headers({ 'Enforcer-Receipt-Hash-Versions': '1,2' }),
      json: async () => (rejected ? { partialSuccess: { rejectedLogRecords: rejected } } : {}),
    };
  };
  s.breaks = () => s.rows.filter((r) => r.brk);
  return s;
}

/**
 * One pass of the shipper in enforcer 1.4.0 (lib/governor/core/ship.mjs and
 * outbox.mjs), the shape every governor before hash v2 shipped: it hashes
 * every line as v1, so a v2 line goes out with no enforcer.receipt.hashv and
 * the prev it really chains from; it advances the watermark past whatever the
 * server refused; and it rewrites outbox.json with only the four fields it
 * knows, dropping hashVersions and ackedHash.
 */
export async function legacyShipOnce(dir, fetchImpl) {
  const MARK = join(dir, 'outbox.json');
  const RECEIPTS = join(dir, 'receipts.jsonl');
  let m;
  try {
    m = JSON.parse(readFileSync(MARK, 'utf8'));
  } catch {
    m = {};
  }
  const shippedBytes = Number(m.shippedBytes) || 0;
  const end = statSync(RECEIPTS).size;
  const from = end < shippedBytes ? 0 : shippedBytes;
  let prev = from === 0 ? 'genesis' : m.prevHash || 'genesis';
  if (end <= from) return { shipped: 0 };
  const buf = Buffer.alloc(end - from);
  const fd = openSync(RECEIPTS, 'r');
  readSync(fd, buf, 0, buf.length, from);
  closeSync(fd);
  const chunk = buf.toString('utf8');
  const complete = chunk.slice(0, chunk.lastIndexOf('\n') + 1);
  const records = [];
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue;
    const { hash, ...entry } = JSON.parse(raw);
    const text = JSON.stringify(entry);
    const attributes = [];
    if (!hash) attributes.push({ key: 'enforcer.receipt.chained', value: { boolValue: false } });
    else {
      let p = prev;
      if (sha(prev + text) !== hash && sha('genesis' + text) === hash) p = 'genesis';
      attributes.push(
        { key: 'enforcer.receipt.hash', value: { stringValue: hash } },
        { key: 'enforcer.receipt.prev', value: { stringValue: p } },
        { key: 'enforcer.receipt.chained', value: { boolValue: true } },
      );
      prev = hash;
    }
    records.push({ body: { stringValue: text }, attributes });
  }
  const body = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: 'enforcer-governor/receipts' }, logRecords: records }] }] };
  const res = await fetchImpl('legacy', { method: 'POST', body: JSON.stringify(body) });
  if (res.status !== 200) return { error: res.status };
  writeFileSync(MARK, JSON.stringify({ shippedBytes: from + Buffer.byteLength(complete, 'utf8'), shippedAt: Date.now(), lastError: null, prevHash: prev }));
  return { shipped: records.length };
}
