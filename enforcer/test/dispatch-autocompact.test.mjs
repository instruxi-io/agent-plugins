// `node --test test/dispatch-autocompact.test.mjs`: dispatch --autocompact. No network, no real claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCompactions } from '../src/dispatch/stream.mjs';
import { launchCmd } from '../src/dispatch/launch.mjs';
import { Dispatcher, defaultArgs, parseDispatchArgs, main } from '../src/dispatch/run.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'dac-'));
const env = (extra = {}) => ({ ENFORCER_CONFIG_HOME: tmp(), HOME: tmp(), ...extra });

test('the claude argv carries autocompact only when it is not auto', () => {
  const c = launchCmd('p', 'sonnet', { autocompact: '150000' }, 'k');
  const i = c.indexOf('--autocompact');
  assert.ok(i > 0);
  assert.equal(c[i + 1], '150000');
  assert.ok(!launchCmd('p', 'sonnet', { autocompact: 'auto' }, 'k').includes('--autocompact'));
  assert.ok(!launchCmd('p', 'sonnet', {}, 'k').includes('--autocompact'));
});

test('grok and codex argv never carry autocompact', () => {
  for (const harness of ['grok', 'codex']) {
    const c = launchCmd('p', 'sonnet', { harness, autocompact: '150000' }, 'k');
    assert.ok(!c.includes('--autocompact'), harness);
    assert.ok(!c.includes('150000'), harness);
  }
});

test('without the flag the argv is byte-identical to before', () => {
  const base = launchCmd('p', 'sonnet', {}, 'k');
  assert.deepEqual(launchCmd('p', 'sonnet', { autocompact: 'auto' }, 'k'), base);
  assert.deepEqual(launchCmd('p', 'sonnet', { autocompact: '200000' }, 'k').slice(0, base.length), base);
  assert.equal(parseDispatchArgs(['g'], env()).autocompact, 'auto');
});

test('a bad value exits 2 with the message', async () => {
  for (const bad of ['99999', '1000001', 'lots', '1e5', '']) {
    const errs = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => (errs.push(String(s)), true);
    let rc;
    try {
      rc = await main(['g', '--autocompact', bad], env());
    } finally {
      process.stderr.write = orig;
    }
    assert.equal(rc, 2, bad);
    assert.match(errs.join(''), /--autocompact must be auto or 100000\.\.1000000/);
  }
  assert.equal(parseDispatchArgs(['g', '--autocompact', '100000'], env()).autocompact, '100000');
  assert.equal(parseDispatchArgs(['g', '--autocompact', '1000000'], env()).autocompact, '1000000');
});

test('the env var sets the default and the flag overrides it', () => {
  const e = env({ ENFORCER_DISPATCH_AUTOCOMPACT: '300000' });
  assert.equal(parseDispatchArgs(['g'], e).autocompact, '300000');
  assert.equal(parseDispatchArgs(['g', '--autocompact', '150000'], e).autocompact, '150000');
  assert.equal(parseDispatchArgs(['g', '--autocompact', 'auto'], e).autocompact, 'auto');
});

test('compact_boundary events are counted in the done line', { skip: process.platform === 'win32' && 'the fake claude is a sh script' }, async () => {
  const state = tmp();
  const ev = [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'assistant', message: { content: [] } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  writeFileSync(join(state, 'events.jsonl'), ev + '\n');
  assert.equal(countCompactions(join(state, 'events.jsonl')), 2);
  const bin = join(state, 'claude');
  writeFileSync(bin, `#!/bin/sh\ncat '${join(state, 'events.jsonl')}'\n`);
  chmodSync(bin, 0o755);
  const list = [{ id: 'id-a', key: 'a', type: 'task', status: 'ready', title: 'a', data: {} }];
  let n = 100;
  const api = {
    graph: async () => ({}),
    nodes: async () => list.map((x) => ({ ...x })),
    frontier: async () => list.filter((x) => x.status === 'ready').map((x) => ({ ...x, work_state: 'looking_for_work' })),
    createNode: async (g, body) => (list.push({ id: 'id-' + n++, ...body }), list[list.length - 1]),
    patchNode: async (g, id, body) => (
      Object.assign(
        list.find((x) => x.id === id),
        body,
      ),
      {}
    ),
    claim: async (g, id) => ({ run_id: 'run-' + id }),
    heartbeat: async () => ({ state: 'ok' }),
    complete: async () => ({}),
    runs: async () => [],
  };
  const lines = [];
  const a = defaultArgs({
    graph: 'g',
    stateDir: state,
    stopFile: join(state, 'STOP'),
    repoRoot: join(state, 'none'),
    interval: 0.05,
    killGrace: 0.2,
    leaseRenew: 0.05,
    agentBin: bin,
    autocompact: '150000',
  });
  const d = new Dispatcher(api, a, (s) => lines.push(s));
  const run = d.run();
  const end = Date.now() + 8000;
  while (!lines.some((l) => /done a /.test(l)) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  d.requestTerminate('SIGINT');
  await run;
  const done = lines.find((l) => /done a /.test(l));
  assert.ok(done, lines.join('\n'));
  assert.match(done, /compactions=2/);
  assert.match(done, /autocompact=150000/);
  assert.ok(
    lines.some((l) => /launch a .*autocompact=150000/.test(l)),
    lines.join('\n'),
  );
});
