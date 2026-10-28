// `node --test test/dispatch/governor-lane.test.mjs`: a dispatched worker's governor receipts stay in a lane of their own and
// ship under the worker's credential only, so one run is one session under one account. Loopback network only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { workerEnv, governorDir, governorLane, laneId, drainGovernorLane } from '../../src/dispatch/launch.mjs';

const home = () => mkdtempSync(join(tmpdir(), 'lane-'));

test('governorDir resolves the way the governor store does', () => {
  assert.equal(governorDir({ HOME: '/h' }), join('/h', '.config', 'enforcer', 'governor'));
  assert.equal(governorDir({ HOME: '/h', ENFORCER_CONFIG_HOME: '/c' }), join('/c', 'governor'));
  assert.equal(governorDir({ HOME: '/h', GOVERNOR_HOME: '/g' }), '/g');
});

test('laneId is stable per account, differs between accounts, and never carries the key', () => {
  assert.equal(laneId({ agent: 'a1' }), laneId({ agent: 'a1' }));
  assert.notEqual(laneId({ agent: 'a1' }), laneId({ agent: 'a2' }));
  const k = laneId({ agentKey: 'ag_secretsecret' });
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.ok(!k.includes('secret'));
  assert.equal(laneId({}), null);
});

test('governorLane is a private dir under the operator governor dir with the operator config copied in', () => {
  const h = home();
  const base = join(h, '.config', 'enforcer', 'governor');
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'config.json'), JSON.stringify({ shipOn: false }));
  const lane = governorLane({ agent: 'agent-1' }, { HOME: h });
  assert.equal(lane, join(base, 'agents', laneId({ agent: 'agent-1' })));
  assert.equal(statSync(lane).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(join(lane, 'config.json'), 'utf8')), { shipOn: false });
  // the operator's change follows on the next launch
  writeFileSync(join(base, 'config.json'), JSON.stringify({ shipOn: true }));
  assert.equal(governorLane({ agent: 'agent-1' }, { HOME: h }), lane);
  assert.deepEqual(JSON.parse(readFileSync(join(lane, 'config.json'), 'utf8')), { shipOn: true });
  assert.equal(governorLane({}, { HOME: h }), null);
});

test('workerEnv points the governor at the lane only for a worker with its own credential', () => {
  const op = { PATH: '/bin', HOME: '/home/u', GOVERNOR_HOME: '/operator/gov' };
  const own = workerEnv('g', op, { token: 'ag_x', enforcerHome: '/run/home', governorHome: '/lane' });
  assert.equal(own.GOVERNOR_HOME, '/lane');
  assert.equal(own.ENFORCER_API_KEY, 'ag_x');
  // the operator's GOVERNOR_HOME never passes; without a token the worker is the operator and shares the operator record
  assert.equal(workerEnv('g', op, { governorHome: '/lane' }).GOVERNOR_HOME, undefined);
  assert.equal(workerEnv('g', op, { token: 'ag_x' }).GOVERNOR_HOME, undefined);
});

test('drainGovernorLane does nothing without a lane', async () => {
  let spawned = 0;
  assert.equal(await drainGovernorLane({ PATH: '/bin' }, { spawnImpl: () => spawned++ }), null);
  assert.equal(spawned, 0);
});

test('drainGovernorLane waits out a shipper that holds the lock, then stops', async () => {
  const lines = ['Not shipped: another shipper is running.', 'Shipped 3 receipt(s).', 'never'];
  const seen = [];
  const spawnImpl = (bin, args, opts) => {
    seen.push({ args, env: opts.env });
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.kill = () => {};
    const line = lines[seen.length - 1];
    setImmediate(() => {
      p.stdout.emit('data', line + '\n');
      p.emit('close', 0);
    });
    return p;
  };
  const env = { GOVERNOR_HOME: '/lane', ENFORCER_API_KEY: 'ag_x' };
  assert.equal(await drainGovernorLane(env, { spawnImpl, waitMs: 1 }), 'Shipped 3 receipt(s).');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].env, env);
  assert.ok(seen[0].args.includes('--print'));
});

test("the lane ships under the worker's key, and the operator's record is not touched", async () => {
  const got = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      got.push({ key: req.headers['x-api-key'], body: JSON.parse(b) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const h = home();
    const base = join(h, '.config', 'enforcer', 'governor');
    mkdirSync(base, { recursive: true });
    const ingestUrl = `http://127.0.0.1:${srv.address().port}`;
    writeFileSync(join(base, 'config.json'), JSON.stringify({ ingestUrl }));
    // the operator's own pending receipt: must stay where it is, unshipped by the worker
    writeFileSync(join(base, 'receipts.jsonl'), JSON.stringify({ ts: new Date().toISOString(), session: 'operator-session', decision: 'allow' }) + '\n');
    const lane = governorLane({ agent: 'agent-1' }, { HOME: h });
    writeFileSync(join(lane, 'receipts.jsonl'), JSON.stringify({ ts: new Date().toISOString(), session: 'worker-session', decision: 'allow' }) + '\n');
    const env = { ...workerEnv('g', { PATH: process.env.PATH, HOME: h }, { token: 'ag_worker', enforcerHome: join(h, 'run-home'), governorHome: lane }) };
    const line = await drainGovernorLane(env, { waitMs: 1 });
    assert.match(String(line), /Shipped 1 receipt/);
    assert.equal(got.length, 1);
    assert.equal(got[0].key, 'ag_worker');
    const bodies = got[0].body.resourceLogs[0].scopeLogs[0].logRecords.map((r) => JSON.parse(r.body.stringValue).session);
    assert.deepEqual(bodies, ['worker-session']);
    // the worker's shipper never advanced (or even created) the operator's outbox
    assert.equal(existsSync(join(base, 'outbox.json')), false);
  } finally {
    srv.close();
  }
});
