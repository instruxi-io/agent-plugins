// Receipt hash v2 (RFC 8785) and the local checks around the chain: what a
// governor writes, what verify() accepts and refuses, how the shipper labels a
// record and learns the control plane's versions.
// `node lib/governor/test/receipt-hash.test.mjs`.
// No network: fetch is injected.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'gov-hashv2-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GOVERNOR_HOME = join(home, '.enforcer-governor');
process.env.ENFORCER_HOME = join(home, '.enforcer');
delete process.env.ENFORCER_API_KEY;
mkdirSync(process.env.GOVERNOR_HOME, { recursive: true });
const GH = process.env.GOVERNOR_HOME;

const { canonicalize } = await import('../core/jcs.mjs');
const { receiptHash, seal, V2_PREFIX } = await import('../core/chain.mjs');
const { verify, RECEIPTS } = await import('../core/store.mjs');
const { markShipped, hashVersion, ackedHash, parseHashVersions, pending } = await import('../core/outbox.mjs');
const { toOtlp, shipOnce } = await import('../core/ship.mjs');
const { createGovernor } = await import('../core/index.mjs');
const { saveCredentials } = await import('../core/credentials.mjs');
const { writeChecksOn } = await import('./fixtures/checks-on.mjs');

let pass = 0;
const ok = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const vectors = JSON.parse(readFileSync(new URL('./fixtures/jcs-vectors.json', import.meta.url), 'utf8'));
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n');
const write = (file, ls) => writeFileSync(file, ls.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
const entry = (n, extra = {}) => ({
  ts: `2026-10-29T12:00:0${n}.000Z`,
  agent: 'claude:abcd1234',
  verdict: 'allow',
  reason: `r${n}`,
  source: 'economics',
  tool: 'Read',
  model: 'm',
  tokens: n,
  ...extra,
});
// A file of receipts as the governor writes them, v1 for the first `v1` and v2 after.
function chainFile(file, n, v1 = n) {
  let prev = 'genesis';
  const out = [];
  for (let i = 1; i <= n; i++) {
    const s = seal(prev, entry(i, { spent_usd: i / 100, rule: undefined }), i <= v1 ? 1 : 2);
    out.push({ ...s.entry, hash: s.hash });
    prev = s.hash;
  }
  write(file, out);
  return out;
}

// ── RFC 8785 ─────────────────────────────────────────────────────────────────
await ok('JCS: RFC 8785 Appendix B numbers (shared vectors)', () => {
  const dv = new DataView(new ArrayBuffer(8));
  for (const { bits, expect } of vectors.numbers) {
    dv.setBigUint64(0, BigInt('0x' + bits));
    const n = dv.getFloat64(0);
    if (expect === null) assert.throws(() => canonicalize(n), TypeError, bits);
    else assert.equal(canonicalize(n), expect, bits);
  }
});

await ok('JCS: canonical forms, including UTF-16 key order (shared vectors)', () => {
  for (const c of vectors.canonical) {
    assert.equal(canonicalize(JSON.parse(c.input)), c.expect, c.name);
    assert.equal(canonicalize(JSON.parse(c.expect)), c.expect, `${c.name}: canonical form is a fixed point`);
  }
});

await ok('JCS: refuses what is not I-JSON (shared vectors), and what JSON would silently drop', () => {
  for (const c of vectors.invalid) assert.throws(() => canonicalize(JSON.parse(c.input)), c.name);
  for (const bad of [undefined, () => 1, 1n, new Date(0), { a: undefined }, [undefined], NaN]) assert.throws(() => canonicalize(bad));
  // invalidText (duplicate keys) is the Go side's: JSON.parse has kept the last one.
  assert.ok(vectors.invalidText.length > 0);
});

// ── the two hash versions ───────────────────────────────────────────────────
await ok('receipt hashes match the shared vectors (the Go ingest checks the same file)', () => {
  for (const r of vectors.receipts) {
    const body = JSON.parse(r.body);
    assert.equal(body.hv ?? 1, r.hv, r.name);
    assert.equal(receiptHash(r.prev, body), r.hash, r.name);
  }
  const [v1] = vectors.receipts;
  assert.equal(v1.hash, sha(v1.prev + v1.body), 'v1 is sha256(prev + body text)');
  const v2 = vectors.receipts[1];
  assert.equal(v2.hash, sha(V2_PREFIX + v2.prev + '\n' + canonicalize(JSON.parse(v2.body))), 'v2 is sha256(prefix + prev + "\\n" + JCS(body))');
});

await ok('seal v1 is the hash every earlier governor wrote; seal v2 adds hv and drops undefined fields', () => {
  const e = entry(1, { rule: undefined, decision: { code: 'x', run_id: undefined } });
  assert.deepEqual(seal('genesis', e, 1), { entry: e, hash: sha('genesis' + JSON.stringify(e)) });
  const s = seal('genesis', e, 2);
  assert.equal(s.entry.hv, 2);
  assert.ok(!('rule' in s.entry) && !('run_id' in s.entry.decision), 'the value hashed is the value the line parses back to');
  const line = JSON.parse(JSON.stringify({ ...s.entry, hash: s.hash }));
  const { hash, ...body } = line;
  assert.equal(receiptHash('genesis', body), hash);
  assert.notEqual(s.hash, seal('genesis', e, 1).hash, 'v1 and v2 never agree');
});

// ── verify() ─────────────────────────────────────────────────────────────────
const F = join(home, 'r.jsonl');

await ok('a file of v1 lines then v2 lines verifies as one chain', () => {
  const ls = chainFile(F, 5, 2);
  assert.equal(ls[1].hv, undefined);
  assert.equal(ls[2].hv, 2);
  const v = verify(F);
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal(v.receipts, 5);
  assert.equal(v.head, ls[4].hash);
});

await ok('v2 lines verify whatever their key order; v1 lines do not', () => {
  const ls = chainFile(F, 4, 2).map((l) => JSON.stringify(l));
  const reorder = (s) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s)).reverse()));
  write(F, [ls[0], ls[1], reorder(ls[2]), ls[3]]);
  assert.ok(verify(F).ok, 'a re-ordered v2 line is the same value');
  write(F, [reorder(ls[0]), ...ls.slice(1)]);
  assert.equal(verify(F).brokeAt, 1, 'a v1 hash covers bytes, so re-ordering breaks it');
});

await ok('an edited v2 line, or one whose version is changed, is a break', () => {
  const ls = chainFile(F, 4, 1);
  write(F, [ls[0], ls[1], { ...ls[2], tokens: 999 }, ls[3]]);
  assert.equal(verify(F).brokeAt, 3);
  write(F, [ls[0], { ...ls[1], hv: 1 }, ls[2], ls[3]]);
  assert.equal(verify(F).brokeAt, 2, 'hv is inside the hash');
  write(F, [ls[0], { ...ls[1], hv: 3 }, ls[2], ls[3]]);
  assert.equal(verify(F).brokeAt, 2, 'an unknown version cannot be checked, which is a break');
});

await ok('a last line with its hash removed is a break, not "unverifiable"', () => {
  const ls = chainFile(F, 3, 1);
  const { hash, ...stripped } = ls[2];
  write(F, [ls[0], ls[1], stripped]);
  const v = verify(F);
  assert.ok(!v.ok && v.unhashedTail && v.brokeAt === 3 && !v.blind, JSON.stringify(v));
  // ...including one that claims to be the blind path's.
  write(F, [ls[0], ls[1], { ...stripped, chained: false }]);
  const forged = verify(F);
  assert.ok(!forged.ok && forged.unhashedTail && forged.blind && forged.brokeAt === 3, JSON.stringify(forged));
  // Mid-file, a hashless line that does not say chained:false is already a break.
  const { hash: h2, ...mid } = ls[1];
  write(F, [ls[0], mid, ls[2]]);
  assert.equal(verify(F).brokeAt, 2);
});

await ok('deleting the newest lines is "truncated" against the state head or the acknowledged hash', () => {
  const ls = chainFile(F, 5, 2);
  write(F, ls.slice(0, 3));
  assert.ok(verify(F).ok, 'the file alone cannot see a clean cut');
  const byState = verify(F, { state: { prevHash: ls[4].hash } });
  assert.ok(!byState.ok && byState.headMismatch && byState.receipts === 3, `state head: ${JSON.stringify(byState)}`);
  const byAck = verify(F, { state: { prevHash: ls[2].hash }, acked: ls[3].hash });
  assert.ok(!byAck.ok && byAck.truncated && byAck.receipts === 3, `acknowledged hash: ${JSON.stringify(byAck)}`);
  assert.ok(verify(F, { state: { prevHash: ls[2].hash }, acked: ls[1].hash }).ok, 'holding both copies is intact');
  assert.ok(verify(F, { acked: null }).ok, 'nothing acknowledged yet');
  // The case only the acknowledged hash catches: the governor has carried on
  // after the cut, so state.json's head is the cut-down file's own tail again
  // (loadState() re-derives it from the file).
  assert.ok(verify(F, { state: { prevHash: ls[2].hash }, acked: ls[4].hash }).truncated);
  unlinkSync(F);
  const gone = verify(F, { acked: ls[3].hash });
  assert.ok(gone.missing && gone.truncated, 'a deleted file is missing, once something was acknowledged');
  assert.ok(verify(F).ok, 'and empty when nothing was');
});

// ── the outbox: acknowledged head and advertised versions ───────────────────
await ok('the acknowledged head follows the chain, and survives the file being cut and re-shipped', () => {
  const ls = chainFile(RECEIPTS, 4, 4);
  let b = pending();
  markShipped(b.to, Date.now(), ls[3].hash, { start: b.prevHash, hashes: ls.map((l) => l.hash), hashVersions: [1] });
  assert.equal(ackedHash(), ls[3].hash);
  // Cut the last two lines: pending() starts over from the top...
  write(RECEIPTS, ls.slice(0, 2));
  b = pending();
  assert.equal(b.from, 0);
  markShipped(b.to, Date.now(), ls[1].hash, { start: b.prevHash, hashes: [ls[0].hash, ls[1].hash], hashVersions: [1] });
  assert.equal(ackedHash(), ls[3].hash, '...and the re-ship does not forget what the server had');
  assert.ok(verify(RECEIPTS, { acked: ackedHash() }).truncated);
  unlinkSync(join(GH, 'outbox.json'));
  unlinkSync(RECEIPTS);
});

await ok('an outbox written before ackedHash existed: its prevHash is the acknowledged head', () => {
  writeFileSync(join(GH, 'outbox.json'), JSON.stringify({ shippedBytes: 10, prevHash: 'a'.repeat(64) }));
  assert.equal(ackedHash(), 'a'.repeat(64));
  assert.equal(hashVersion(), 1, 'and it writes v1 until told otherwise');
  unlinkSync(join(GH, 'outbox.json'));
});

await ok('parseHashVersions reads the header, and anything else is v1', () => {
  assert.deepEqual(parseHashVersions('1,2'), [1, 2]);
  assert.deepEqual(parseHashVersions(' 1, 2 '), [1, 2]);
  assert.deepEqual(parseHashVersions(null), [1]);
  assert.deepEqual(parseHashVersions('x'), [1]);
});

// ── the shipper ─────────────────────────────────────────────────────────────
const attrs = (rec) => Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue]));

await ok('a v2 line ships with enforcer.receipt.hashv = "2"; a v1 line ships exactly as before', () => {
  const ls = chainFile(F, 3, 1);
  const { body, hashes } = toOtlp(ls, 'genesis', 'i');
  const recs = body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(attrs(recs[0])['enforcer.receipt.hashv'], undefined);
  assert.equal(attrs(recs[1])['enforcer.receipt.hashv'], '2');
  assert.equal(attrs(recs[1])['enforcer.receipt.prev'], ls[0].hash, 'v2 chains onto the v1 hash');
  // What the server recomputes from the record alone:
  const a = attrs(recs[2]);
  assert.equal(sha(V2_PREFIX + a['enforcer.receipt.prev'] + '\n' + canonicalize(JSON.parse(recs[2].body.stringValue))), a['enforcer.receipt.hash']);
  assert.deepEqual(
    hashes,
    ls.map((l) => l.hash),
  );
});

await ok('a v2 line re-chained from genesis after a state reset is sent so it verifies', () => {
  const [a] = chainFile(F, 1, 0); // all v2
  const b = { ...a }; // the same line chained from genesis again
  const recs = toOtlp([a, b], 'genesis', 'i').body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(attrs(recs[1])['enforcer.receipt.prev'], 'genesis');
});

saveCredentials({ enforcer: { api_key: 'env3_' + 'k'.repeat(43), base_url: 'https://api.example.test' } });

// ── the gate: v2 only after the control plane says so ───────────────────────
writeChecksOn(GH);
await ok('the governor writes v1 until the control plane advertises v2, then v2, then v1 again if it stops', async () => {
  const gov = createGovernor({ harness: 'test-harness' });
  const ev = (n) => ({ agent: 'h:1', tool: 'Read', name: 'Read', action: `Read:/w/a${n}.ts`, input: {}, cwd: '/w/acme' });
  await gov.before(ev(1));
  assert.equal(JSON.parse(lines(RECEIPTS)[0]).hv, undefined, 'no capability seen: v1');

  // A server without hash v2: 200, no header.
  let r = await shipOnce({}, { fetchImpl: async () => ({ status: 200, headers: new Headers(), json: async () => ({}) }) });
  assert.equal(r.shipped, 1);
  await gov.before(ev(2));
  assert.equal(JSON.parse(lines(RECEIPTS)[1]).hv, undefined, 'an old server keeps the governor on v1');

  // A server with it.
  let sent;
  r = await shipOnce(
    {},
    {
      fetchImpl: async (u, init) => {
        sent = JSON.parse(init.body);
        return { status: 200, headers: new Headers({ 'Enforcer-Receipt-Hash-Versions': '1,2' }), json: async () => ({}) };
      },
    },
  );
  assert.equal(r.shipped, 1);
  assert.equal(attrs(sent.resourceLogs[0].scopeLogs[0].logRecords[0])['enforcer.receipt.hashv'], undefined, 'the v1 line went as v1');
  assert.equal(hashVersion(), 2);
  await gov.before(ev(3));
  gov.session.end({ agent: 'h:1' });
  const third = JSON.parse(lines(RECEIPTS)[2]);
  assert.equal(third.hv, 2, 'after the capability: v2');
  assert.equal(third.harness, 'test-harness');

  // The v2 lines ship labelled; a later answer without the header goes back to v1.
  r = await shipOnce(
    {},
    {
      fetchImpl: async (u, init) => {
        sent = JSON.parse(init.body);
        return { status: 200, json: async () => ({}) };
      },
    },
  );
  const recs = sent.resourceLogs[0].scopeLogs[0].logRecords;
  assert.ok(recs.length >= 1 && recs.every((x) => attrs(x)['enforcer.receipt.hashv'] === '2'));
  assert.equal(hashVersion(), 1, 'no header (or no headers object at all) is a server without v2');

  const v = verify(RECEIPTS, { acked: ackedHash() });
  assert.ok(v.ok, `the mixed record verifies end to end: ${JSON.stringify(v)}`);
  assert.equal(ackedHash(), v.head, 'and the acknowledged head is its last line');
});

await ok('governor verify says lines are missing from the end, and exits 1, even after the governor carried on', () => {
  const all = lines(RECEIPTS);
  const cli = () => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [new URL('../src/report.mjs', import.meta.url).pathname, 'verify'], { env: process.env, encoding: 'utf8' }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  let r = cli();
  assert.equal(r.code, 0, r.out);
  writeFileSync(RECEIPTS, all.slice(0, -1).join('\n') + '\n');
  r = cli();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /missing from the end/);
  // The governor carries on and its state head becomes the cut file's tail
  // again (loadState() re-derives it): only the acknowledged hash still knows.
  const st = JSON.parse(readFileSync(join(GH, 'state.json'), 'utf8'));
  writeFileSync(join(GH, 'state.json'), JSON.stringify({ ...st, prevHash: JSON.parse(all.at(-2)).hash }));
  r = cli();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /newest receipt the control plane acknowledged/);
  writeFileSync(join(GH, 'state.json'), JSON.stringify(st));
  writeFileSync(RECEIPTS, all.join('\n') + '\n');
  const last = JSON.parse(all.at(-1));
  delete last.hash;
  writeFileSync(RECEIPTS, [...all.slice(0, -1), JSON.stringify(last)].join('\n') + '\n');
  r = cli();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the last, carries no hash/);
});

console.log(`receipt hash v2 and the local chain checks: ${pass} ok`);
