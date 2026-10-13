import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureEvidence, evidenceRunRecords } from '../../src/graph/hooks/capture.mjs';
import { loadEvidence } from '../../src/graph/evidence.mjs';
import { saveRun } from '../../src/graph/run.mjs';

const fresh = () => {
  process.env.ENFORCER_STATE_DIR = join(mkdtempSync(join(realpathSync(tmpdir()), 'cap-')), 'state');
};
const STDOUT = [
  JSON.stringify({ kind: 'command', cmd: 'go vet ./...', exit: 0, output: '', line_index: 0 }),
  JSON.stringify({
    kind: 'command',
    cmd: "go test ./... -run 'DelegationFallback' -v",
    exit: 0,
    output: '--- PASS: TestDelegationFallback (0.01s)\nok',
    line_index: 2,
  }),
  'literals found: 1/1',
].join('\n');

test('evidence run output parses into one final record per item, plus the summary', () => {
  const { finals, summary } = evidenceRunRecords(STDOUT + '\n{not json\n');
  assert.deepEqual(
    finals.map((f) => [f.line, f.cmd, f.exit]),
    [
      [1, 'go vet ./...', 0],
      [3, "go test ./... -run 'DelegationFallback' -v", 0],
    ],
  );
  assert.match(finals[1].output, /--- PASS/);
  assert.equal(summary, 'literals found: 1/1\n{not json');
  assert.deepEqual(evidenceRunRecords('plain output').finals, []);
});

test('the capture hook expands an evidence run into final records under the held run', async () => {
  fresh();
  saveRun('s1', { graph_id: 'g1', node_id: 'n1', run_id: 'r1', key: 'k' });
  await captureEvidence({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'cd /w && enforcer evidence run g1:k --cwd . --timeout 600' },
    tool_response: { stdout: STDOUT, stderr: 'SKIPPED line 1: not run: not an allowed command shape\n' },
  });
  const recs = loadEvidence('s1', 'r1');
  assert.deepEqual(
    recs.map((r) => [r.kind, r.line ?? null, r.exit]),
    [
      ['command', 1, 0],
      ['command', 3, 0],
      ['command', null, 0],
    ],
    'two finals, then the command itself with only the summary',
  );
  assert.match(recs[2].cmd, /enforcer evidence run/);
  assert.match(recs[2].output, /literals found: 1\/1/);
  assert.ok(!recs[2].output.includes('line_index'), 'the JSON items are not repeated as a blob');
  for (const r of recs) assert.equal(r._run, 'r1');
});

test('an ordinary command is captured as before', async () => {
  fresh();
  saveRun('s2', { graph_id: 'g1', node_id: 'n1', run_id: 'r1', key: 'k' });
  await captureEvidence({
    hook_event_name: 'PostToolUse',
    session_id: 's2',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: STDOUT },
  });
  const recs = loadEvidence('s2', 'r1');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].line, undefined);
});
