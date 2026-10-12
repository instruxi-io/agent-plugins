// The receipt chain and its lock survive crashes, dead holders and tampering.
// `node test/store.test.mjs`. No framework: a failed assert exits non-zero.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'gov-store-'));
process.env.GOVERNOR_HOME = home;
const store = await import('../core/store.mjs');
const { withLock, loadState, saveState, commit, verify, RECEIPTS } = store;

let pass = 0;
const ok = (label, fn) => {
  fn();
  pass++;
  console.log('  ok  - ' + label);
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
const reset = () => {
  for (const f of readdirSync(home)) rmSync(join(home, f), { recursive: true, force: true });
};
const link = (state, n) => {
  const e = { n };
  const h = sha(state.prevHash + JSON.stringify(e));
  return commit(state, e, h) ? h : null;
};
const lines = () => readFileSync(RECEIPTS, 'utf8').split('\n').filter(Boolean);

ok('live holder lock is not broken', () => {
  reset();
  // A live process (this one's child) holds the lock with a very old mtime.
  const child = spawn('sleep', ['30']);
  try {
    writeFileSync(join(home, '.lock'), `${child.pid}:abc`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(home, '.lock'), old, old);
    const r = withLock(() => 'ran');
    assert.equal(r.ok, false, 'a live holder is waited on, then we give up; never broken by age');
    assert.equal(readFileSync(join(home, '.lock'), 'utf8'), `${child.pid}:abc`);
  } finally {
    child.kill();
  }
});

ok("dead holder lock is broken, and a release never deletes another owner's lock", () => {
  reset();
  const dead = spawnSync('true'); // exited: its pid is dead
  writeFileSync(join(home, '.lock'), `${dead.pid || 999999}:abc`);
  assert.equal(withLock(() => 1).ok, true);
  assert.equal(existsSync(join(home, '.lock')), false);
  // someone else takes the lock while we run: our release leaves it alone
  const r = withLock(() => {
    writeFileSync(join(home, '.lock'), `${process.pid}:someone-else`);
    return 1;
  });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(home, '.lock'), 'utf8'), `${process.pid}:someone-else`);
  rmSync(join(home, '.lock'));
});

ok('crash between receipt and state does not fork', () => {
  reset();
  let s = loadState();
  const h1 = link(s, 1);
  // receipt 2 lands, the process dies before saveState: state still says h1
  const e2 = { n: 2 };
  const h2 = sha(h1 + JSON.stringify(e2));
  store.writeReceipt(e2, h2);
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prevHash, h1);
  s = loadState();
  assert.equal(s.prevHash, h2, 'the next process continues from the chain head');
  link(s, 3);
  assert.deepEqual(verify(RECEIPTS, { state: loadState() }).ok, true);
  assert.equal(verify().ok, true);
  assert.equal(lines().length, 3);
});

ok('half-written state does not reset the chain to genesis', () => {
  reset();
  let s = loadState();
  link(s, 1);
  link(s, 2);
  const head = s.prevHash;
  writeFileSync(join(home, 'state.json'), '{"agents":{"a"');
  assert.equal(loadState().prevHash, head);
});

ok('disk-full append does not advance', () => {
  reset();
  const s = loadState();
  const h1 = link(s, 1);
  // the receipt file cannot be appended to: replace it with a directory
  rmSync(RECEIPTS);
  mkdirSync(RECEIPTS);
  const e = { n: 2 };
  assert.equal(commit(s, e, sha(h1 + JSON.stringify(e))), false);
  assert.equal(s.prevHash, h1);
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).prevHash, h1);
  rmSync(RECEIPTS, { recursive: true });
});

ok('state is written by rename, leaving no temp file', () => {
  reset();
  const s = loadState();
  saveState(s);
  assert.deepEqual(
    readdirSync(home).filter((f) => f.endsWith('.tmp')),
    [],
  );
  assert.ok(existsSync(join(home, 'state.json')));
});

ok('verify rejects hashless tail', () => {
  reset();
  const s = loadState();
  link(s, 1);
  link(s, 2);
  link(s, 3);
  const ls = lines().map(JSON.parse);
  delete ls[2].hash;
  writeFileSync(RECEIPTS, ls.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, false);
  assert.equal(v.brokeAt, 3);
});

ok('legacy hashless lines before the first hashed line are still history', () => {
  reset();
  writeFileSync(RECEIPTS, JSON.stringify({ old: 1 }) + '\n');
  const s = loadState();
  link(s, 1);
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, true);
  assert.equal(v.unverifiable, 1);
});

ok('a declared unchained (blind path) line is not a stripped hash', () => {
  reset();
  const s = loadState();
  link(s, 1);
  store.writeReceipt({ n: 'blind', chained: false }, undefined);
  link(s, 2);
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.unverifiable, 1);
});

ok('verify rejects head mismatch', () => {
  reset();
  const s = loadState();
  link(s, 1);
  link(s, 2);
  link(s, 3);
  const ls = lines();
  writeFileSync(RECEIPTS, ls.slice(0, 2).join('\n') + '\n'); // truncated tail: still chains line by line
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, false);
  assert.equal(v.headMismatch, true);
});

ok('verify names every break and counts the lines that still chain', () => {
  reset();
  const s = loadState();
  for (let i = 1; i <= 200; i++) link(s, i);
  const ls = lines();
  for (const i of [17, 120]) ls[i] = ls[i].replace('"n":', '"n":9');
  writeFileSync(RECEIPTS, ls.join('\n') + '\n');
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, false);
  assert.deepEqual(v.breaks, [18, 121]);
  assert.equal(v.breakCount, 2);
  assert.equal(v.brokeAt, 18);
  assert.equal(v.linked, 198);
  assert.equal(v.headMatches, true);
});

ok('verify still fails the record when the head does not match', () => {
  reset();
  const s = loadState();
  for (let i = 1; i <= 5; i++) link(s, i);
  writeFileSync(RECEIPTS, lines().slice(0, 3).join('\n') + '\n');
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, false);
  assert.equal(v.headMismatch, true);
  assert.equal(v.headMatches, false);
  assert.equal(v.linked, 3);
});

ok('verify on an intact chain is unchanged', () => {
  reset();
  const s = loadState();
  for (let i = 1; i <= 10; i++) link(s, i);
  const v = verify(RECEIPTS, { state: s });
  assert.equal(v.ok, true);
  assert.deepEqual(v.breaks, []);
  assert.equal(v.linked, v.receipts);
  assert.equal(v.headMatches, true);
});

ok('verify report text for a broken chain exits 1', () => {
  reset();
  const s = loadState();
  for (let i = 1; i <= 6; i++) link(s, i);
  const ls = lines();
  ls[2] = ls[2].replace('"n":', '"n":9');
  writeFileSync(RECEIPTS, ls.join('\n') + '\n');
  const r = spawnSync(process.execPath, [new URL('../core/report.mjs', import.meta.url).pathname, 'verify'], {
    env: { ...process.env, GOVERNOR_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /lines do not match the one before them/);
  assert.match(r.stdout, /5 of 6 lines chain correctly/);
});

console.log(`\n  ${pass} passed`);
