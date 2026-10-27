// `node --test test/dispatch/per-node-harness.test.mjs`: each worker carries the harness it was launched on (pids.json too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dispatcher, defaultArgs, pidsEntries, workerHarness } from '../../src/dispatch/run.mjs';
import { launchCmd, spawnWorker } from '../../src/dispatch/launch.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dispatch');
const tmp = () => mkdtempSync(join(tmpdir(), 'pnh-'));

class FakeAPI {
  constructor() {
    this.completed = [];
  }
  async nodes() {
    return [];
  }
  async complete(g, n, r, body) {
    this.completed.push({ n, r, body });
    return {};
  }
  async runs() {
    return [];
  }
}
const mkArgs = (state, o = {}) =>
  defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), killGrace: 0.2, ...o });
const exited = (pid) => ({ pid, exited: 0, returncode: 0, start: null, nonce: null });
const worker = (key, harness, log) => ({
  kind: 'agent',
  node: { id: 'id-' + key, key, type: 'task', data: {} },
  key,
  logPath: join(FX, log),
  proc: exited(4242),
  started: 0,
  resources: new Set(),
  path: '/tmp/' + key,
  model: 'sonnet',
  ...(harness ? { harness } : {}),
  turns: 0,
  maxTurns: 80,
  session: 's-' + key,
});

test('two workers on different harnesses are reaped with their own parser', async () => {
  const state = tmp();
  const lines = [];
  // --harness claude is the default for every node; the grok worker must still be read with the grok parser
  const d = new Dispatcher(new FakeAPI(), mkArgs(state, { harness: 'claude' }), (m) => lines.push(m));
  d.workers.set('c', worker('c', 'claude', 'claude-e2e.jsonl'));
  d.workers.set('k', worker('k', 'grok', 'grok-ok.json'));
  await d.reap();
  assert.equal(d.workers.size, 0, 'both reaped');
  const done = (k) => lines.find((l) => l.includes(`done ${k} `)) ?? lines.join('\n');
  assert.match(done('c'), /turns=23 result=success/);
  // the claude parser reads this grok log as turns=0 result=null: turns=1 result=success shows the grok parser ran
  assert.match(done('k'), /turns=1 result=success/);
});

test('the harness chosen at launch is the worker harness and goes into launchCmd', () => {
  const d = new Dispatcher(new FakeAPI(), mkArgs(tmp(), { harness: 'grok' }), () => {});
  assert.equal(d.harnessFor({ key: 'x' }), 'grok');
  assert.equal(new Dispatcher(new FakeAPI(), mkArgs(tmp()), () => {}).harnessFor({ key: 'x' }), 'claude');
  assert.equal(launchCmd('p', 'm', { harness: 'claude' }, 'k', { harness: 'grok' })[1], '-p');
  assert.match(launchCmd('p', 'm', { harness: 'claude' }, 'k', { harness: 'grok' })[0], /grok/);
  assert.ok(launchCmd('p', 'm', { harness: 'grok' }, 'k', { harness: 'claude' }).includes('--agent'));
  assert.equal(workerHarness({}), 'claude');
});

test('pids.json records each worker harness', () => {
  const state = tmp();
  const d = new Dispatcher(new FakeAPI(), mkArgs(state), () => {});
  d.workers.set('c', worker('c', 'claude', 'claude-e2e.jsonl'));
  d.workers.set('k', worker('k', 'grok', 'grok-ok.json'));
  d.writePids();
  const rec = JSON.parse(readFileSync(join(state, 'pids.json'), 'utf8'));
  assert.equal(rec.meta.c.harness, 'claude');
  assert.equal(rec.meta.k.harness, 'grok');
  assert.deepEqual(
    pidsEntries(rec).map((e) => [e.key, e.harness]),
    [
      ['c', 'claude'],
      ['k', 'grok'],
    ],
  );
});

test('a pids.json with no harness field resumes as claude', async () => {
  const state = tmp();
  // the shape an older dispatcher wrote: meta carries start and nonce, no harness
  const old = { dispatcher: 2147483000, host: hostname(), workers: { a: 1, b: 2 }, meta: { a: { start: 1, nonce: 'n' } } };
  assert.deepEqual(
    pidsEntries(old).map((e) => [e.key, e.harness]),
    [
      ['a', 'claude'],
      ['b', 'claude'],
    ],
  );
  // and a live orphan from such a file is reaped as a claude worker
  const sh = join(state, 'orphan');
  writeFileSync(sh, '#!/bin/sh\nsleep 60\n');
  chmodSync(sh, 0o755);
  const p = spawnWorker([sh], { cwd: state, logPath: join(state, 'o.log') });
  await new Promise((r) => setTimeout(r, 100));
  writeFileSync(join(state, 'pids.json'), JSON.stringify({ ...old, workers: { x: p.pid }, meta: { x: { start: p.start, nonce: p.nonce } } }));
  const lines = [];
  const d = new Dispatcher(new FakeAPI(), mkArgs(state), (m) => lines.push(m));
  assert.deepEqual(await d.reapOrphans(), ['x']);
  assert.ok(
    lines.some((l) => /reaped orphan worker x pid \d+ \(claude\)/.test(l)),
    lines.join('\n'),
  );
  const hold = setInterval(() => {}, 50);
  try {
    await p.done;
  } finally {
    clearInterval(hold);
  }
});
