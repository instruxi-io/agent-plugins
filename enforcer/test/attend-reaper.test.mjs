// `node --test test/attend-reaper.test.mjs`: attend rings, the orphan reaper, spawnAllowed timeouts and the shared hook deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { needsYou, newItems, loadSeen } from '../src/dispatch/attention.mjs';
import { Dispatcher, defaultArgs } from '../src/dispatch/run.mjs';
import { pidAlive, procStartTime } from '../src/dispatch/launch.mjs';
import { spawnAllowed } from '../src/acceptance-allowlist.mjs';
import { runEvent, hookDeadline } from '../src/event.mjs';
import { acceptanceRecords } from '../src/graph/hooks/attach.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'attend-reaper-'));
const mkArgs = (state, o = {}) =>
  defaultArgs({
    graph: 'g',
    stateDir: state,
    stopFile: join(state, 'STOP'),
    repoRoot: join(state, 'none'),
    interval: 0.02,
    attendPoll: 0.02,
    noLease: true,
    ...o,
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a gate re-activated in a new epoch rings again', async () => {
  const state = tmp();
  const g1 = { id: 'g1', key: 'sign-off', type: 'gate', status: 'active', epoch: 1, title: 'Ship?', data: {} };
  const api = {
    frontierCalls: 0,
    async frontier() {
      return [g1];
    },
    async reviewOpen() {
      return [];
    },
  };
  const lines = [];
  const d = new Dispatcher(api, mkArgs(state, { attend: true }), (s) => lines.push(s));
  await d.attention([g1], [g1]);
  await d.attention([g1], [g1]);
  assert.equal(lines.filter((l) => /ATTENTION gate sign-off/.test(l)).length, 1);
  await d.attention([{ ...g1, status: 'done' }], []); // decided: pruned
  assert.equal(loadSeen(state).size, 0);
  await d.attention([{ ...g1, epoch: 2 }], [g1]); // re-activated after a reset
  assert.equal(lines.filter((l) => /ATTENTION gate sign-off/.test(l)).length, 2);
  assert.notEqual(needsYou([g1], [], new Set(['g1']))[0].id, needsYou([{ ...g1, epoch: 2 }], [], new Set(['g1']))[0].id);
  assert.equal(newItems(new Set([needsYou([g1], [], new Set(['g1']))[0].id]), needsYou([{ ...g1, epoch: 2 }], [], new Set(['g1']))).length, 1);
});

test('attend rings during a usage hold', async () => {
  const state = tmp();
  const g1 = { id: 'g1', key: 'sign-off', type: 'gate', status: 'active', title: 'Ship?', data: {} };
  const api = {
    async nodes() {
      return [g1];
    },
    async frontier() {
      return [g1];
    },
    async reviewOpen() {
      return [];
    },
    async graph() {
      return {};
    },
  };
  const lines = [];
  const d = new Dispatcher(api, mkArgs(state, { attend: true }), (s) => lines.push(s));
  d.limitedUntil = Date.now() / 1000 + 600;
  const done = d.run();
  const t0 = Date.now();
  while (!lines.some((l) => /ATTENTION gate sign-off/.test(l)) && Date.now() - t0 < 5000) await sleep(20);
  d.requestTerminate('SIGTERM');
  await done;
  assert.ok(
    lines.some((l) => /ATTENTION gate sign-off/.test(l)),
    lines.join('\n'),
  );
});

test("attention reuses the tick's frontier", async () => {
  const state = tmp();
  const g1 = { id: 'g1', key: 'sign-off', type: 'gate', status: 'active', title: 'Ship?', data: {} };
  let calls = 0;
  const api = {
    async frontier() {
      calls++;
      return [g1];
    },
    async reviewOpen() {
      return [];
    },
  };
  const d = new Dispatcher(api, mkArgs(state, { attend: true }), () => {});
  await d.attention([g1], [g1]);
  assert.equal(calls, 0);
});

test('a non-leader dispatcher is still judged alive', async () => {
  // a child in the SAME group as this test process (not a group leader), like a dispatcher started with `&`
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    assert.ok(pidAlive(child.pid));
    const state = tmp();
    const worker = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore', detached: true });
    try {
      writeFileSync(
        join(state, 'pids.json'),
        JSON.stringify({
          dispatcher: child.pid,
          dispatcherStart: procStartTime(child.pid),
          workers: { w: worker.pid },
          meta: { w: { start: procStartTime(worker.pid), nonce: 'x' } },
        }),
      );
      const d = new Dispatcher({}, mkArgs(state), () => {});
      assert.deepEqual(await d.reapOrphans(), []);
      assert.equal(pidAlive(worker.pid), true, "the live dispatcher's worker is not killed");
      assert.ok(existsSync(join(state, 'pids.json')));
    } finally {
      worker.kill('SIGKILL');
    }
  } finally {
    child.kill('SIGKILL');
  }
});

test('a timed-out acceptance run kills its grandchildren', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const marker = join(dir, 'pid');
  // spawnAllowed only runs allowlisted binaries: inject the runner but keep its options, then check the group dies
  let opts;
  const r = spawnAllowed(['git', 'status'], {
    cwd: dir,
    timeoutMs: 500,
    run: (bin, args, o) => {
      opts = o;
      return spawnSync('sh', ['-c', `sleep 30 & echo $! > ${marker}; wait`], { ...o });
    },
  });
  assert.equal(r.timedOut, true);
  assert.equal(opts.detached, true);
  await sleep(200);
  const { readFileSync } = await import('node:fs');
  const gpid = Number(readFileSync(marker, 'utf8').trim());
  assert.equal(pidAlive(gpid), false, 'the grandchild is gone');
});

test('the session hook shares one deadline across the governor and graph halves', async () => {
  const t0 = Date.now();
  let seen;
  {
    await runEvent('session-start', {
      input: '{}',
      write: () => {},
      governorFn: async () => {
        await sleep(300);
        return null;
      },
      nativeFn: async (_h, _ev, deadline) => {
        seen = deadline;
        return { out: null, code: 0 };
      },
    });
  }
  assert.ok(seen <= hookDeadline('SessionStart', t0) + 50, 'the graph half gets what the governor left, not a fresh budget');
  // and the acceptance runs respect it: a spent deadline runs no line
  const dir = tmp();
  spawnSync('git', ['init', '-q', dir]);
  const recs = acceptanceRecords({ cwd: dir }, { acceptance: ['`git status` exits 0'], key: 'k', node_id: 'n' }, { deadline: Date.now() });
  assert.ok(
    recs.every((x) => x.kind === 'note'),
    JSON.stringify(recs),
  );
});
