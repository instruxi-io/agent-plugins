// `node --test test/dispatch-attend.test.mjs`: attended dispatch (--attend) against a fake API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsYou, newItems, attentionLine, loadSeen, saveSeen } from '../src/dispatch/attention.mjs';
import { Dispatcher, defaultArgs, parseDispatchArgs } from '../src/dispatch/run.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'attend-'));
const gate = { id: 'g1', key: 'sign-off', type: 'gate', status: 'active', title: 'Ship it?', data: {} };

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

class Fake {
  constructor(nodes, ready = []) {
    this.list = nodes;
    this.ready = ready;
    this.reviews = 0;
    this.nodeCalls = 0;
  }
  async graph() {
    return {};
  }
  async nodes() {
    this.nodeCalls++;
    return this.list.map((n) => ({ ...n }));
  }
  async frontier() {
    return this.ready;
  }
  async reviewOpen() {
    this.reviews++;
    return [];
  }
  async runs() {
    return [];
  }
}

test('attention rings once per item across restarts', () => {
  const state = tmp();
  const items = needsYou([gate], [{ id: 'r1', node_key: 'a', reason: 'verdict pending' }], new Set(['g1']));
  assert.deepEqual(
    items.map((i) => i.id),
    ['review:r1', 'gate:sign-off'],
  );
  let seen = loadSeen(state);
  const first = newItems(seen, items);
  assert.equal(first.length, 2);
  for (const i of first) seen.add(i.id);
  saveSeen(state, seen);
  seen = loadSeen(state); // a restart
  assert.equal(newItems(seen, items).length, 0);
  const more = newItems(seen, [...items, ...needsYou([{ ...gate, id: 'g2', key: 'other' }], [], new Set(['g2']))]);
  assert.deepEqual(
    more.map((i) => i.id),
    ['gate:other'],
  );
});

test('attention line format', () => {
  const [i] = needsYou([gate], [], new Set(['g1']));
  assert.equal(attentionLine(i, 'G'), 'ATTENTION gate sign-off: Ship it? (answer with: graphwatch attend G, or graph_review / graph_decide)');
  assert.deepEqual(needsYou([gate], [], new Set()), [], 'a gate whose prerequisites are not done is not yet needed');
  assert.deepEqual(needsYou([{ ...gate, status: 'done' }], [], new Set(['g1'])), []);
});

test('attend keeps the dispatcher up while a gate is ready', async () => {
  const state = tmp();
  const api = new Fake([gate], [gate]);
  const lines = [];
  const d = new Dispatcher(api, mkArgs(state, { attend: true }), (s) => lines.push(s));
  const done = d.run();
  const t0 = Date.now();
  while (api.nodeCalls < 4 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(api.nodeCalls >= 4, 'more than two passes and still running');
  d.requestTerminate('SIGTERM');
  assert.equal(await done, 143);
  const rings = lines.filter((l) => /ATTENTION gate sign-off/.test(l));
  assert.equal(rings.length, 1);
  assert.ok(lines.some((l) => /waiting on you: 1 item\(s\)/.test(l)));
});

test('without attend the exit path is unchanged', async () => {
  const state = tmp();
  const api = new Fake([gate], [gate]);
  const lines = [];
  const rc = await new Dispatcher(api, mkArgs(state), (s) => lines.push(s)).run();
  assert.equal(rc, 0);
  assert.equal(api.reviews, 0);
  assert.ok(lines.some((l) => /nothing runnable or running; exiting/.test(l)));
  assert.ok(!lines.some((l) => /ATTENTION|waiting on you/.test(l)));
  assert.equal(parseDispatchArgs(['g'], {}).attend, false);
  assert.equal(parseDispatchArgs(['g', '--attend'], {}).attend, true);
  assert.equal(parseDispatchArgs(['g'], { ENFORCER_DISPATCH_ATTEND: '1' }).attend, true);
});

test('dispatch status prints needs you', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/dispatch-command.mjs', import.meta.url), 'utf8');
  assert.match(src, /needs you: \$\{needsYou\.length\}/);
});
