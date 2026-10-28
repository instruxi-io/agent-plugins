// `node --test test/dispatch/runtime.test.mjs`: the dispatcher runtime against a fake API and a fake claude binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { API, APIError } from '../../src/dispatch/api.mjs';
import { Lease, LEASE_KEY } from '../../src/dispatch/lease.mjs';
import { Dispatcher, defaultArgs, actionsStatus } from '../../src/dispatch/run.mjs';
import { spawnWorker, killGroup, alive, pidAliveGroup, launchCmd, pluginDirs, harnessRefusal } from '../../src/dispatch/launch.mjs';
import { worktreeFor, worktreeSetup } from '../../src/dispatch/worktree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'drt-'));
const wait = async (cond, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const script = (dir, name, body) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

/** An in-memory graph API with the methods the dispatcher calls. */
class FakeAPI {
  constructor(nodes) {
    this.list = nodes;
    this.patches = 0;
    this.completed = [];
    this.n = 100;
  }
  async graph() {
    return {};
  }
  async nodes() {
    return this.list.map((n) => ({ ...n }));
  }
  async frontier() {
    return this.list.filter((n) => n.status === 'ready').map((n) => ({ ...n, work_state: 'looking_for_work' }));
  }
  async createNode(g, b) {
    const n = { id: 'id-' + this.n++, ...b };
    this.list.push(n);
    return n;
  }
  async patchNode(g, id, b) {
    this.patches++;
    Object.assign(
      this.list.find((n) => n.id === id),
      b,
    );
    return {};
  }
  async claim(g, id) {
    return { run_id: 'run-' + id };
  }
  async heartbeat() {
    return { state: 'ok' };
  }
  async complete(g, n, r, body) {
    this.completed.push({ n, r, body });
    return {};
  }
  async runs() {
    return [];
  }
}
const node = (key, extra = {}) => ({ id: 'id-' + key, key, type: 'task', status: 'ready', title: key, data: {}, ...extra });
const mkArgs = (state, o = {}) =>
  defaultArgs({
    graph: 'g',
    stateDir: state,
    stopFile: join(state, 'STOP'),
    repoRoot: join(state, 'none'),
    interval: 0.05,
    killGrace: 0.2,
    leaseRenew: 0.05,
    ...o,
  });
const quiet = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(s) };
};

test('claims carry X-Graph-Client', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, h: init.headers });
    return new Response(JSON.stringify({ data: { run_id: 'r1' } }), { status: 200 });
  };
  const api = new API('http://x/api', { fetchImpl, headers: async () => ({ 'X-API-Key': 'k' }) });
  const card = await api.claim('g', 'n1', 'graph-dispatch');
  assert.equal(card.run_id, 'r1');
  assert.match(seen[0].url, /\/graphs\/g\/nodes\/n1\/claim$/);
  assert.match(seen[0].h['X-Graph-Client'], /^enforcer-plugin\/\S+; hooks=(on|off)$/);
  assert.equal(seen[0].h['X-API-Key'], 'k');
});

test('heartbeat reads data.state', async () => {
  const mk = (body) => new API('http://x', { fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
  assert.equal((await mk({ data: { state: 'cancel_requested' } }).heartbeat('g', 'n', 'r')).state, 'cancel_requested');
  assert.equal((await mk({ state: 'ok' }).heartbeat('g', 'n', 'r')).state, 'ok');
});

test('API retries 503 then succeeds; a 404 is an APIError with its status', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls < 3 ? new Response('busy', { status: 503 }) : new Response('{"data":[]}', { status: 200 }));
  const api = new API('http://x', { fetchImpl, baseDelayMs: 1 });
  assert.deepEqual(await api.frontier('g'), []);
  assert.equal(calls, 3);
  const nf = new API('http://x', { fetchImpl: async () => new Response('{"detail":"no graph"}', { status: 404 }) });
  await assert.rejects(nf.graph('g'), (e) => e instanceof APIError && e.status === 404 && /no graph/.test(e.detail()));
});

test('kill escalates to SIGKILL', async () => {
  const dir = tmp();
  const sh = script(dir, 'stubborn', 'trap "" TERM\nsleep 60 &\nwhile true; do sleep 1; done');
  const p = spawnWorker([sh], { cwd: dir, logPath: join(dir, 'log') });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(pidAliveGroup(p.pid), 'a detached worker leads its own process group');
  const t0 = Date.now();
  await killGroup(p, 300);
  assert.equal(p.exited.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 280, 'waited the grace before KILL');
  assert.ok(!alive(p));
  assert.ok(!pidAliveGroup(p.pid), 'the whole group is gone, children included');
});

test('SIGTERM drains and clears the lease', async () => {
  const state = tmp();
  const claude = script(state, 'claude', 'sleep 60');
  const api = new FakeAPI([node('a')]);
  const { out } = quiet();
  const d = new Dispatcher(api, mkArgs(state, { agentBin: claude }), out);
  const done = d.run();
  await wait(() => d.workers.size === 1);
  const pid = [...d.workers.values()][0].proc.pid;
  assert.equal(api.list.find((n) => n.key === LEASE_KEY).data.dispatcher.pid, process.pid);
  process.kill(process.pid, 'SIGTERM');
  assert.equal(await done, 143);
  assert.equal(d.terminating, 'SIGTERM');
  assert.equal(d.workers.size, 0);
  assert.equal(pidAliveGroup(pid), false, 'the worker group was killed');
  assert.equal(api.list.find((n) => n.key === LEASE_KEY).data.dispatcher, null, 'lease cleared');
});

test('limit hold renews the lease', async () => {
  const state = tmp();
  const claude = script(
    state,
    'claude',
    `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"result":"You have hit your weekly limit"}'; exit 1`,
  );
  const api = new FakeAPI([node('a')]);
  const { lines, out } = quiet();
  const d = new Dispatcher(api, mkArgs(state, { agentBin: claude, limitBackoff: 30 }), out);
  const done = d.run();
  await wait(() => d.limitedUntil > Date.now() / 1000);
  assert.equal(d.attempts.get('a'), 0, 'no attempt spent');
  const before = api.patches;
  await wait(() => api.patches >= before + 2); // renewed while held, though nothing launches
  assert.equal(d.workers.size, 0);
  assert.ok(lines.some((l) => /HARNESS-LIMITED a/.test(l)));
  assert.equal(readdirSync(join(state, 'logs')).length, 1, 'no second launch during the hold');
  d.requestTerminate('SIGINT');
  assert.equal(await done, 130);
});

test('CI outage holds launches and a green feed releases the hold', async () => {
  const state = tmp();
  const api = new FakeAPI([node('a')]);
  const { lines, out } = quiet();
  const d = new Dispatcher(api, mkArgs(state, { agentBin: script(state, 'claude', 'exit 0'), ciProbeInterval: 0 }), out);
  d.ciFetch = async () => JSON.stringify({ components: [{ name: 'Actions', status: 'major_outage' }] });
  const done = d.run();
  await wait(() => d.ciHold > 0);
  assert.ok(lines.some((l) => /CI-UNAVAILABLE github-actions/.test(l)));
  assert.equal(d.workers.size + d.attempts.size, 0, 'nothing launched during the hold');
  d.ciFetch = async () => JSON.stringify({ components: [{ name: 'Actions', status: 'operational' }] });
  await wait(() => d.ciHold === 0);
  assert.ok(lines.some((l) => /CI-UNAVAILABLE cleared/.test(l)));
  d.requestTerminate('SIGTERM');
  await done;
  assert.equal(
    await actionsStatus(async () => {
      throw new Error('down');
    }),
    null,
  );
});

test('a second dispatcher is refused; --takeover replaces a live lease', async () => {
  const api = new FakeAPI([]);
  const say = [];
  const a = new Lease(api, 'g', { say: (m) => say.push(m), pid: 111, host: 'h' });
  const b = new Lease(api, 'g', { say: (m) => say.push(m), pid: 222, host: 'h' });
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  assert.ok(say.some((m) => /another graph-dispatch holds/.test(m)));
  assert.equal(await new Lease(api, 'g', { say: (m) => say.push(m), pid: 222, host: 'h', takeover: true }).acquire(), true);
  assert.equal(await a.renew(), false, 'the old holder sees the lease is lost');
});

test('pids.json orphans from a dead dispatcher are reaped', async () => {
  const state = tmp();
  const sh = script(state, 'orphan', 'sleep 60');
  const p = spawnWorker([sh], { cwd: state, logPath: join(state, 'o.log') });
  await new Promise((r) => setTimeout(r, 100));
  writeFileSync(
    join(state, 'pids.json'),
    JSON.stringify({
      dispatcher: 2147483000,
      host: (await import('node:os')).hostname(),
      workers: { x: p.pid },
      meta: { x: { start: p.start, nonce: p.nonce } },
    }),
  );
  const d = new Dispatcher(new FakeAPI([]), mkArgs(state), () => {});
  assert.deepEqual(await d.reapOrphans(), ['x']);
  // the worker handle is unref'd, so hold the loop open until its exit is delivered (macOS reports the group gone before the zombie is reaped)
  const hold = setInterval(() => {}, 50);
  try {
    await p.done;
  } finally {
    clearInterval(hold);
  }
  assert.ok(!pidAliveGroup(p.pid));
  assert.ok(!existsSync(join(state, 'pids.json')));
});

test('dry run plans launches and launches nothing', async () => {
  const state = tmp();
  const api = new FakeAPI([node('a'), node('b', { data: { tier: 'deep' } })]);
  const { lines, out } = quiet();
  const rc = await new Dispatcher(api, mkArgs(state, { dryRun: true }), out).run();
  assert.equal(rc, 0);
  assert.ok(lines.some((l) => /would launch a /.test(l)));
  assert.ok(lines.some((l) => /would launch b .*model=opus/.test(l)));
  assert.equal(api.list.length, 2, 'no lease node created');
  assert.ok(!existsSync(join(state, 'logs')) && !existsSync(join(state, 'dispatcher.log')));
});

test('`enforcer dispatch --dry-run` prints the planned launches', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const body = req.url.includes('/frontier')
      ? { data: [node('solo')] }
      : req.url.includes('/nodes')
        ? { data: [node('solo')], meta: { total: 1 } }
        : { data: {} };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = tmp();
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'dispatch', '--dry-run', 'g1', '--repo-root', cfg], {
      env: { ...process.env, ENFORCER_CONFIG_HOME: cfg, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'k' },
    });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  srv.close();
  assert.match(r.stdout, /dry run on graph g1/, r.stderr);
  assert.match(r.stdout, /would launch solo/);
  assert.equal(readdirSync(cfg).includes('dispatch'), false, 'wrote no state');
});

test('worktree: scratch dir without a repo; include copies ignored files; share symlinks and excludes', () => {
  const root = tmp();
  const [p, br, note] = worktreeFor(node('k'), root, join(root, 'state'));
  assert.equal(br, null);
  assert.match(note, /scratch/);
  assert.ok(existsSync(p));
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const src = join(root, 'repo');
  mkdirSync(src);
  git(['init', '-q'], src);
  git(['config', 'user.email', 'a@b.c'], src);
  git(['config', 'user.name', 'n'], src);
  writeFileSync(join(src, '.gitignore'), '.env*\nshared/\n');
  writeFileSync(join(src, '.env.local'), 'X=1');
  mkdirSync(join(src, 'shared'));
  writeFileSync(join(src, '.worktreeinclude'), '.env*\n');
  writeFileSync(join(src, '.worktreeshare'), 'shared\n');
  git(['add', '.gitignore', '.worktreeinclude', '.worktreeshare'], src);
  git(['commit', '-qm', 'init'], src);
  const wt = join(root, 'wt');
  git(['worktree', 'add', '-q', wt, '-b', 'b'], src);
  const r = worktreeSetup(src, wt);
  assert.equal(r.copied, 1);
  assert.equal(r.linked, 1);
  assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'X=1');
  assert.match(readFileSync(join(src, '.git', 'info', 'exclude'), 'utf8'), /^\/shared$/m);
  assert.equal(git(['status', '--porcelain'], wt).stdout.trim(), '', 'the share does not dirty the worktree');
});

test('launch command: claude args, one plugin per name, grok needs --experimental, codex experimental', () => {
  const cmd = launchCmd('PROMPT', 'sonnet', { harness: 'claude', agentBin: 'claude' }, 'k', { session: 's1', maxTurns: 40 });
  assert.deepEqual(cmd.slice(0, 3), ['claude', '-p', 'PROMPT']);
  assert.ok(cmd.includes('--session-id') && cmd.includes('--max-turns') && cmd.includes('graph:k'));
  assert.equal(pluginDirs([ROOT]).length, 1);
  assert.match(harnessRefusal('grok', false), /experimental/);
  assert.match(harnessRefusal('codex', false), /experimental/);
  assert.equal(harnessRefusal('codex', true), null);
  assert.equal(harnessRefusal('claude', false), null);
});

test('a verdict that lands after exit is read before the attempt is judged failed', async () => {
  const state = tmp();
  const ev = [
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__x__graph_report', input: { node_id: 'id-a', status: 'succeeded' } }] },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ verification: { state: 'rejected', reason: 'no evidence' } }) }],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'done' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  writeFileSync(join(state, 'events.jsonl'), ev + '\n');
  const claude = script(state, 'claude', `cat '${join(state, 'events.jsonl')}'`);
  const api = new FakeAPI([node('a')]);
  let polls = 0;
  api.runs = async () => [{ run_id: 'run-id-a', verification: { state: ++polls < 3 ? 'pending' : 'verified' } }];
  api.node = async () => ({ status: 'verifying' });
  const { lines, out } = quiet();
  const d = new Dispatcher(api, mkArgs(state, { agentBin: claude, verdictPollMs: 10 }), out);
  const done = d.run();
  await wait(() => lines.some((l) => /done a /.test(l)) && d.workers.size === 0);
  await new Promise((r) => setTimeout(r, 100));
  d.requestTerminate('SIGINT');
  await done;
  assert.ok(polls >= 3, 'polled until the verdict landed');
  assert.ok(!lines.some((l) => /FAILED a/.test(l)), lines.join('\n'));
});
