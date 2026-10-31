// Parallel sessions on one machine share one receipt chain (one install id, one
// receipts.jsonl). The control plane flagged chain breaks on such a machine
// that were not tampering. These tests drive the record from several sessions
// and ship it through a stand-in for the control plane's ingest
// (fixtures/chain-ingest.mjs), and count the breaks it would store.
// `node lib/governor/test/chain-parallel-sessions.test.mjs`. No network.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'gov-parallel-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GOVERNOR_HOME = join(home, '.enforcer-governor');
process.env.ENFORCER_HOME = join(home, '.enforcer');
delete process.env.ENFORCER_API_KEY;
const GH = process.env.GOVERNOR_HOME;
mkdirSync(GH, { recursive: true });

const { verify, RECEIPTS, hashVersion, legacyShipperSeen, SHIP_COMPAT } = await import('../core/store.mjs');
const { shipOnce } = await import('../core/ship.mjs');
const { seal } = await import('../core/chain.mjs');
const { createGovernor } = await import('../core/index.mjs');
const { saveCredentials } = await import('../core/credentials.mjs');
const { writeChecksOn } = await import('./fixtures/checks-on.mjs');
const { fakeIngest, legacyShipOnce } = await import('./fixtures/chain-ingest.mjs');

let pass = 0;
const ok = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};
const lines = () =>
  readFileSync(RECEIPTS, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
// Everything but the sign-in: each scenario starts from an empty record.
const reset = () => {
  for (const f of readdirSync(GH)) if (f !== 'config.json') rmSync(join(GH, f), { recursive: true, force: true });
};
saveCredentials({ enforcer: { api_key: 'env3_' + 'k'.repeat(43), base_url: 'https://api.example.test' } });
// shipOn off: no hook kicks a detached shipper at the fake base URL behind the test's back.
writeChecksOn(GH, { shipOn: false });

async function shipAllNew(ingest) {
  for (let i = 0; i < 50; i++) {
    const r = await shipOnce({}, { fetchImpl: ingest.fetch });
    if (!r.pending) return r;
  }
}

// ── 1. Writers: N sessions appending at once, each its own process ─────────
await ok('8 sessions appending at once, each its own process, leave one chain the server stores without a break', async () => {
  reset();
  const N = 8;
  const M = 25;
  await Promise.all(
    Array.from(
      { length: N },
      (_, i) =>
        new Promise((resolve, reject) => {
          const c = spawn(process.execPath, [new URL('./fixtures/append-many.mjs', import.meta.url).pathname, `claude:s${i}`, String(M)], {
            env: process.env,
            stdio: ['ignore', 'ignore', 'inherit'],
          });
          c.on('error', reject);
          c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`appender ${i} exited ${code}`))));
        }),
    ),
  );
  const ls = lines();
  assert.equal(ls.length, N * M, 'every decision is one line');
  assert.equal(new Set(ls.map((l) => l.agent)).size, N, 'from all the sessions');
  const v = verify(RECEIPTS);
  assert.ok(v.ok && v.breakCount === 0, `the local record chains: ${JSON.stringify(v)}`);
  const ingest = fakeIngest();
  await shipAllNew(ingest);
  assert.equal(ingest.refused.length, 0, 'nothing refused');
  assert.equal(ingest.rows.length, N * M, 'everything stored');
  assert.equal(ingest.breaks().length, 0, 'no chain break');
});

// ── 2. Shippers: a session still running a pre-hash-v2 plugin ──────────────
// Seen live: every receipt on the machine came from 2.10, but long-lived
// sessions started on an older plugin (1.4.0) kept kicking THEIR shipper
// against the same record. It sends a v2 line unlabelled, the server refuses
// it, its watermark passes it, and the next receipt stored names it as prev.
// Breaks arrived in pairs from different sessions within one second: the v1
// lines on either side of a refused v2 one, shipped in one batch.
await ok('a pre-v2 shipper in a parallel session: after it is first seen, no more refused receipts and no more breaks', async () => {
  reset();
  const ingest = fakeIngest();
  const gov = createGovernor({ harness: 'test-harness' });
  let n = 0;
  const decide = (agent) => gov.before({ agent, tool: 'Read', name: 'Read', action: `Read:/w/${n++}.ts`, input: {}, cwd: '/w/acme' });
  // round r: two sessions decide, then one shipper runs -- the 2.10 one on even
  // rounds, the old one on odd. writtenIn maps a hash to its round.
  const writtenIn = new Map();
  const ROUNDS = 10;
  for (let r = 0; r < ROUNDS; r++) {
    await decide('claude:aaaa1111');
    await decide('claude:bbbb2222');
    for (const l of lines()) if (!writtenIn.has(l.hash)) writtenIn.set(l.hash, r);
    if (r % 2 === 0) await shipOnce({}, { fetchImpl: ingest.fetch });
    else await legacyShipOnce(GH, ingest.fetch);
  }
  await shipAllNew(ingest);
  assert.ok(verify(RECEIPTS).ok, 'the local record itself always chained');
  // Round 1 is the old shipper's first appearance: the v2 lines it ships then
  // were written before anything on this machine could know it was there, so
  // they are refused, and the first receipt stored after them (round 2) is a
  // break. That much is out of the client's hands (see the server note in
  // outbox.mjs noteLegacyShipper). Everything after must be clean.
  const refusedLater = ingest.refused.filter((h) => writtenIn.get(h) > 1);
  const breaksLater = ingest.breaks().filter((row) => writtenIn.get(row.hash) > 2);
  console.log(
    `      ${ROUNDS} rounds: ${ingest.refused.length} refused, ${ingest.breaks().length} breaks in all; after the first sighting ${refusedLater.length} refused, ${breaksLater.length} breaks`,
  );
  assert.equal(refusedLater.length, 0, 'no receipt written after the old shipper was seen is refused');
  assert.equal(breaksLater.length, 0, 'and no break follows');
  assert.ok(legacyShipperSeen(), 'the sighting is remembered');
  assert.equal(hashVersion(), 1, 'so the governor stays on v1 although the server advertises v2');
});

await ok('an install upgraded from before hash v2 is not mistaken for an old shipper', async () => {
  reset();
  // The mark a pre-v2 governor left behind, and no compatibility note yet.
  const gov = createGovernor({ harness: 'test-harness' });
  await gov.before({ agent: 'claude:cccc3333', tool: 'Read', name: 'Read', action: 'Read:/w/u.ts', input: {}, cwd: '/w/acme' });
  const ingest = fakeIngest();
  await legacyShipOnce(GH, ingest.fetch);
  await gov.before({ agent: 'claude:cccc3333', tool: 'Read', name: 'Read', action: 'Read:/w/v.ts', input: {}, cwd: '/w/acme' });
  await shipOnce({}, { fetchImpl: ingest.fetch });
  assert.ok(!legacyShipperSeen(), 'no sighting: the 2.10 shipper had never written the mark');
  assert.equal(hashVersion(), 2, 'v2 straight away');
  assert.equal(JSON.parse(readFileSync(SHIP_COMPAT, 'utf8')).markVersion, 2);
});

await ok('the v1 hold ends a week after the last sighting', async () => {
  writeFileSync(SHIP_COMPAT, JSON.stringify({ markVersion: 2, legacyShipperAt: Date.now() - 8 * 86400000 }));
  assert.ok(!legacyShipperSeen());
  assert.equal(hashVersion(), 2);
  writeFileSync(SHIP_COMPAT, JSON.stringify({ markVersion: 2, legacyShipperAt: Date.now() - 6 * 86400000 }));
  assert.equal(hashVersion(), 1);
});

// ── 3. The same failure, one version up: this shipper meets a newer line ──
await ok('a line hashed under a version this shipper does not know is left for the newer shipper, not sent and passed', async () => {
  reset();
  const ingest = fakeIngest();
  let prev = 'genesis';
  const add = (hv, n) => {
    const s = seal(prev, { ts: `2026-10-31T20:17:3${n}.000Z`, agent: `claude:s${n}`, verdict: 'allow', reason: 'r', source: 'economics', tool: 'Read' }, hv);
    // A future v3 line: the body says hv 3 and its hash is something only a
    // newer governor computes. Its value here does not matter; that it is not
    // sent does.
    const entry = hv === 3 ? { ...s.entry, hv: 3 } : s.entry;
    const hash = hv === 3 ? 'f'.repeat(64) : s.hash;
    appendFileSync(RECEIPTS, JSON.stringify({ ...entry, hash }) + '\n');
    prev = hash;
  };
  add(1, 1);
  add(2, 2);
  add(3, 3);
  add(1, 4);
  const r = await shipOnce({}, { fetchImpl: ingest.fetch });
  assert.equal(r.shipped, 2, 'the two lines before it ship');
  assert.equal(ingest.refused.length, 0, 'nothing is sent that the server must refuse');
  assert.equal(ingest.breaks().length, 0, 'and nothing stored after a gap');
  const again = await shipOnce({}, { fetchImpl: ingest.fetch });
  assert.match(again.skipped || '', /version 3/, 'the queue waits at the newer line');
  assert.equal(ingest.rows.length, 2, 'and the line after it is not sent past it');
});

console.log(`\nparallel sessions on one chain: ${pass} ok`);
