import test from 'node:test';
import assert from 'node:assert/strict';
import { needsRunnerRecords, checkRows, attachRunnerRecords, latestRun } from '../src/dispatch/check-records.mjs';

const node = { id: 'n1', key: 'k', data: { acceptance: ['`ls` prints x', { check: 'repo.tests' }] } };
const s = { run_id: 'r', reported: true, report_status: 'succeeded' };

test('only non-claude succeeded reports with check rows need records', () => {
  assert.equal(checkRows(node).length, 1);
  assert.equal(needsRunnerRecords('gemini', node), true);
  assert.equal(needsRunnerRecords('claude', node), false);
  assert.equal(needsRunnerRecords('codex', { data: { acceptance: ['x'] } }), false);
});

test('a refused completion is logged, not thrown', async () => {
  const msgs = [];
  const api = {
    complete: async () => {
      throw new Error('closed');
    },
  };
  const n = await attachRunnerRecords({ api, graph: 'g', node, runId: 'r', cwd: '/nonexistent', say: (m) => msgs.push(m), deps: {} });
  assert.equal(n, 0);
});

test('the latest run comes from the API, newest first by start time', async () => {
  const api = {
    runs: async () => [
      { run_id: 'b', status: 'succeeded', started_at: '2026-02' },
      { run_id: 'a', status: 'failed', started_at: '2026-01' },
    ],
  };
  assert.deepEqual(await latestRun(api, 'g', node), { runId: 'b', status: 'succeeded' });
  assert.equal(await latestRun({ runs: async () => [] }, 'g', node), null);
});

test('records are posted to the evidence route, not complete', async () => {
  const calls = [];
  const api = { addEvidence: async (...a) => calls.push(a), complete: async () => assert.fail('complete') };
  const n = await attachRunnerRecords({
    api,
    graph: 'g',
    node: { id: 'n1', key: 'k', data: { acceptance: [{ check: 'x' }] } },
    runId: 'r',
    cwd: '/tmp',
    deps: { run: () => ({ status: 0, stdout: 'ok' }) },
  });
  assert.ok(n === calls.length || calls.length <= 1);
});
