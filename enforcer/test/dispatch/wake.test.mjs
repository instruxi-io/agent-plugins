// `node --test test/dispatch/wake.test.mjs`: a worker's exit wakes the dispatcher, so a chain of fast nodes is not
// paced by --interval (a 10-step chain of 14 s workers took 10 x 30 s before). Fake API and fake claude only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher, defaultArgs } from '../../src/dispatch/run.mjs';

test('a worker that exits wakes the loop: a two-step chain finishes well inside one --interval', async () => {
  const state = mkdtempSync(join(tmpdir(), 'wake-'));
  const ev = (id) =>
    [
      { type: 'system', subtype: 'init', session_id: 'S', mcp_servers: [] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__x__graph_report', input: { node_id: id, status: 'succeeded' } }] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
  writeFileSync(join(state, 'a.jsonl'), ev('id-a') + '\n');
  writeFileSync(join(state, 'b.jsonl'), ev('id-b') + '\n');
  const claude = join(state, 'claude');
  writeFileSync(claude, `#!/bin/sh\nfor x in "$@"; do case "$x" in graph:*) k=\${x#graph:};; esac; done\ncat '${state}/'$k.jsonl\ntouch '${state}/done.'$k\n`);
  chmodSync(claude, 0o755);
  const list = [
    { id: 'id-a', key: 'a', type: 'task', status: 'ready', title: 'a', data: {} },
    { id: 'id-b', key: 'b', type: 'task', status: 'blocked', title: 'b', data: {} },
  ];
  const sync = () => {
    const done = new Set(
      readdirSync(state)
        .filter((f) => f.startsWith('done.'))
        .map((f) => f.slice(5)),
    );
    for (const n of list) if (done.has(n.key)) n.status = 'done';
    if (list[0].status === 'done' && list[1].status === 'blocked') list[1].status = 'ready';
  };
  const api = {
    graph: async () => ({}),
    nodes: async () => (sync(), list.map((n) => ({ ...n }))),
    frontier: async () => (sync(), list.filter((n) => n.status === 'ready').map((n) => ({ ...n, work_state: 'looking_for_work' }))),
    createNode: async (g, b) => {
      const n = { id: 'id-' + b.key, ...b };
      list.push(n);
      return n;
    },
    patchNode: async (g, id, b) => (
      Object.assign(
        list.find((n) => n.id === id),
        b,
      ),
      {}
    ),
    claim: async (g, id) => ({ run_id: 'run-' + id }),
    heartbeat: async () => ({ state: 'ok' }),
    complete: async () => ({}),
    runs: async () => [],
    observations: async () => [],
  };
  const lines = [];
  const d = new Dispatcher(
    api,
    defaultArgs({
      graph: 'g',
      stateDir: state,
      stopFile: join(state, 'STOP'),
      repoRoot: join(state, 'none'),
      interval: 5,
      killGrace: 0.2,
      leaseRenew: 5,
      agentBin: claude,
    }),
    (s) => lines.push(s),
  );
  const t0 = Date.now();
  const run = d.run();
  while (!lines.some((l) => / done b /.test(l))) {
    if (Date.now() - t0 > 4500) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const took = Date.now() - t0;
  d.requestTerminate('SIGINT');
  await run;
  assert.ok(
    lines.some((l) => / done b /.test(l)),
    `b never finished inside one interval:\n${lines.join('')}`,
  );
  assert.ok(took < 4500, `took ${took} ms with --interval 5`);
});
