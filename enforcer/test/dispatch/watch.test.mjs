// `node --test test/dispatch/watch.test.mjs`: `enforcer dispatch watch` (the lobby supervisor) and the dispatcher's
// --for assignment filter. Fakes only: no network, no process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWatchArgs,
  pickGraphs,
  nextBackoff,
  lobby,
  followStream,
  Watcher,
  readWatchState,
  MIN_POLL,
  BACKOFF_MIN,
  BACKOFF_MAX,
  SHORT_LIFE,
} from '../../src/dispatch/watch.mjs';
import { API } from '../../src/dispatch/api.mjs';
import { parseDispatchArgs } from '../../src/dispatch/run.mjs';
import { graphArg } from '../../src/dispatch-command.mjs';

const row = (graph_id, extra = {}) => ({ graph_id, workers_wanted: 1, my_role: 'editor', my_can: ['read', 'claim'], ...extra });

test('parseWatchArgs: own flags are consumed, dispatcher flags pass through with --for and --agent', () => {
  const { opts, pass } = parseWatchArgs([
    '--for',
    'mine',
    '--agent',
    'dgx-worker',
    '--max-graphs',
    '3',
    '--poll',
    '2',
    '--workers',
    '4',
    '--repo-root',
    '/r',
    '--once',
  ]);
  assert.deepEqual(opts, { for: 'mine', agent: 'dgx-worker', maxGraphs: 3, poll: MIN_POLL, once: true, dryRun: false });
  assert.deepEqual(pass, ['--for', 'mine', '--agent', 'dgx-worker', '--workers', '4', '--repo-root', '/r']);
});

test('parseWatchArgs refuses a graph id, a bad --for and a bad number', () => {
  assert.throws(() => parseWatchArgs(['g1']), /takes no graph id/);
  assert.throws(() => parseWatchArgs(['--for', 'everyone']), /--for must be one of me, mine/);
  assert.throws(() => parseWatchArgs(['--max-graphs', '0']), /--max-graphs must be a whole number/);
  assert.throws(() => parseWatchArgs(['--agent']), /--agent needs a value/);
});

test('pickGraphs: demand, claim right, running, backoff and the --max-graphs cap', () => {
  const rows = [row('a'), row('b', { workers_wanted: 0 }), row('c', { my_role: 'viewer', my_can: ['read'] }), row('d'), row('e'), row('f'), row('../x')];
  const r = pickGraphs(rows, { running: new Set(['d']), backoff: new Map([['e', 2000]]), maxGraphs: 3, now: 1000 });
  assert.deepEqual(r.start, ['a', 'f']);
  const why = Object.fromEntries(r.skipped);
  assert.match(why.c, /cannot claim: share the graph with it as editor/);
  assert.match(why.e, /backing off/);
  assert.match(why['../x'], /not a safe path segment/);
  assert.equal(why.b, undefined); // no demand is not worth a line
  assert.deepEqual(pickGraphs(rows, { running: new Set(['d', 'z']), maxGraphs: 2 }).start, []);
});

test('nextBackoff doubles after short lives up to the cap and clears after a long one', () => {
  assert.equal(nextBackoff(0, 5), BACKOFF_MIN);
  assert.equal(nextBackoff(BACKOFF_MIN, 5), BACKOFF_MIN * 2);
  assert.equal(nextBackoff(BACKOFF_MAX, 5), BACKOFF_MAX);
  assert.equal(nextBackoff(BACKOFF_MAX, SHORT_LIFE), 0);
});

test('lobby reads GET /work?kind=work with for, across pages', async () => {
  const calls = [];
  const items = Array.from({ length: 250 }, (_, i) => row(`g${i}`));
  const api = {
    call: async (m, path) => {
      calls.push(path);
      const off = Number(new URL('http://x' + path).searchParams.get('offset'));
      return { data: { items: items.slice(off, off + 200), total: items.length } };
    },
  };
  const rows = await lobby(api, 'mine');
  assert.equal(rows.length, 250);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^\/work\?kind=work&limit=200&offset=0&for=mine$/);
});

test('followStream wakes on every frame and returns on closed', async () => {
  const enc = new TextEncoder();
  const chunks = [
    'event: ready\ndata: {}\n\nevent: dem',
    'and\ndata: {"graph_id":"g"}\n\n',
    'event: poll\ndata: {}\n\nevent: closed\ndata: {}\n\n',
    'event: never\n\n',
  ];
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.accept, 'text/event-stream');
    assert.equal(init.headers['X-API-Key'], 'k');
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const c of chunks) yield enc.encode(c);
      })(),
    };
  };
  const seen = [];
  await followStream('http://x/work/stream', { 'X-API-Key': 'k' }, (e) => seen.push(e), { fetchImpl });
  assert.deepEqual(seen, ['ready', 'demand', 'poll', 'closed']);
  await assert.rejects(
    followStream('u', {}, () => {}, { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/,
  );
});

function harness(rowsByPass, { startCodes = {}, aliveSet = new Set() } = {}) {
  let t = 1000;
  let pass = 0;
  const started = [];
  const out = [];
  const cfgHome = mkdtempSync(join(tmpdir(), 'watch-'));
  const w = new Watcher({ for: 'mine', agent: 'dgx-worker', maxGraphs: 2, poll: 30, once: false, dryRun: false }, ['--for', 'mine'], {
    api: { call: async () => ({ data: { items: rowsByPass[Math.min(pass, rowsByPass.length - 1)], total: 1 } }) },
    env: {},
    cfgHome,
    pid: 4242,
    start: async (g, argv) => {
      started.push([g, argv]);
      const rc = startCodes[g] ?? 0;
      if (rc === 0) aliveSet.add(g);
      return rc;
    },
    alive: (g) => (aliveSet.has(g) ? 1 : null),
    out: (s) => out.push(s),
    now: () => t,
  });
  return {
    w,
    started,
    out,
    aliveSet,
    cfgHome,
    advance: (s) => (t += s),
    next: async () => {
      await w.pass_();
      pass++;
    },
  };
}

test('Watcher starts each advertised graph once and leaves running ones alone', async () => {
  const h = harness([[row('a'), row('b')]]);
  await h.next();
  await h.next();
  assert.deepEqual(
    h.started.map(([g]) => g),
    ['a', 'b'],
  );
  assert.deepEqual(h.started[0][1], ['--for', 'mine']);
  const st = readWatchState(h.cfgHome);
  assert.equal(st.pid, 4242);
  assert.deepEqual(st.running, ['a', 'b']);
  assert.equal(st.for, 'mine');
});

test('Watcher restarts a graph after its dispatcher went idle, and backs off one that dies young', async () => {
  const h = harness([[row('a'), row('b')]]);
  await h.next(); // starts a and b at t=1000
  h.advance(SHORT_LIFE + 10);
  h.aliveSet.delete('a'); // a lived long: went idle
  h.advance(0);
  await h.next();
  assert.deepEqual(
    h.started.map(([g]) => g),
    ['a', 'b', 'a'],
  ); // restarted at once
  h.aliveSet.delete('b');
  h.aliveSet.delete('a');
  h.advance(5); // a died 5 s after its restart: short life
  await h.next();
  const log = h.out.join('');
  assert.match(log, /dispatcher for a exited after 5s; not restarting it for 60s/);
  assert.equal(h.started.filter(([g]) => g === 'a').length, 2); // backing off, not restarted
  assert.match(JSON.stringify(readWatchState(h.cfgHome).backoff), /"a":/);
  h.advance(BACKOFF_MIN + 1);
  await h.next();
  assert.equal(h.started.filter(([g]) => g === 'a').length, 3);
});

test('Watcher backs off a failed start (preflight) and treats exit 3 as running', async () => {
  const h = harness([[row('bad'), row('held')]], { startCodes: { bad: 2, held: 3 } });
  await h.next();
  await h.next();
  assert.deepEqual(
    h.started.map(([g]) => g),
    ['bad', 'held'],
  );
  assert.match(h.out.join(''), /start bad failed \(exit 2: preflight or routes\); retrying in 60s/);
});

test('Watcher counts a dispatcher someone else started, and keeps going after a lobby error', async () => {
  const h = harness([[row('mine-already'), row('new')]], { aliveSet: new Set(['mine-already']) });
  h.w.d.api = {
    call: async () => {
      throw new Error('HTTP 503');
    },
  };
  await h.next();
  assert.match(h.out.join(''), /lobby read failed \(HTTP 503\)/);
  assert.equal(readWatchState(h.cfgHome).last_error, 'HTTP 503');
  h.w.d.api = { call: async () => ({ data: { items: [row('mine-already'), row('new')], total: 2 } }) };
  await h.next();
  assert.deepEqual(
    h.started.map(([g]) => g),
    ['new'],
  );
});

test('dry run says what it would start and starts nothing', async () => {
  const h = harness([[row('a')]]);
  h.w.o.dryRun = true;
  await h.next();
  assert.deepEqual(h.started, []);
  assert.match(h.out.join(''), /would start a dispatcher for a/);
});

test('the dispatcher: --for is validated and asks the frontier for=…', async () => {
  assert.equal(parseDispatchArgs(['--graph', 'g', '--for', 'mine']).for, 'mine');
  assert.equal(parseDispatchArgs(['--graph', 'g']).for, null);
  assert.throws(() => parseDispatchArgs(['--graph', 'g', '--for', 'all']), /--for must be one of me, mine/);
  const paths = [];
  const api = new API('http://x', { headers: () => ({}) });
  api.call = async (m, p) => {
    paths.push(p);
    return { data: [] };
  };
  await api.frontier('g1', 'mine');
  await api.frontier('g1');
  assert.deepEqual(paths, ['/graphs/g1/frontier?for=mine', '/graphs/g1/frontier']);
});

test('enforcer dispatch <graph> --for mine: mine is the flag value, not the graph id', () => {
  assert.equal(graphArg(['--for', 'mine', 'g1']), 'g1');
  assert.equal(graphArg(['g1', '--for', 'me']), 'g1');
});

test('watch.json is private', () => {
  const h = harness([[row('a')]]);
  h.w.save(new Set(['a']));
  const p = join(h.cfgHome, 'dispatch', 'watch.json');
  assert.ok(JSON.parse(readFileSync(p, 'utf8')).running.includes('a'));
});
