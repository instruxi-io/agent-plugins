import test from 'node:test';
import assert from 'node:assert/strict';
import { needsRunnerRecords, checkRows, attachRunnerRecords } from '../src/dispatch/check-records.mjs';

const node = { id: 'n1', key: 'k', data: { acceptance: ['`ls` prints x', { check: 'repo.tests' }] } };
const s = { run_id: 'r', reported: true, report_status: 'succeeded' };

test('only non-claude succeeded reports with check rows need records', () => {
  assert.equal(checkRows(node).length, 1);
  assert.equal(needsRunnerRecords('gemini', s, node), true);
  assert.equal(needsRunnerRecords('claude', s, node), false);
  assert.equal(needsRunnerRecords('gemini', { ...s, report_status: 'failed' }, node), false);
  assert.equal(needsRunnerRecords('codex', s, { data: { acceptance: ['x'] } }), false);
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
