import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { countTurns, events } from '../../src/dispatch/stream.mjs';
import { summarize } from '../../src/dispatch/summarize.mjs';

const FIX = fileURLToPath(new URL('../fixtures/codex-exec.jsonl', import.meta.url));

test("counts the fixture's assistant turns", () => {
  // 2 agent_message + 2 command_execution items in the recorded stream
  assert.equal(countTurns(FIX, 'codex'), 4);
});

test('tool use carries the shell command and its result', () => {
  const evs = [...events(FIX, 'codex')];
  const tu = evs.flatMap((e) => e.message.content || []).filter((c) => c.type === 'tool_use');
  assert.deepEqual(
    tu.map((c) => c.name),
    ['Bash', 'Bash'],
  );
  assert.match(tu[0].input.command, /echo hi/);
});

test('summarize reads usage from the fixture', () => {
  const s = summarize(FIX, 'codex');
  assert.equal(s.usage.input_tokens, 41849);
  assert.equal(s.usage.output_tokens, 132);
  assert.equal(s.turns, 4);
  assert.equal(s.result, 'success');
  assert.ok(s.started);
  assert.match(s.session_id, /^[0-9a-f-]{36}$/);
});

test('a missing file yields no events', () => {
  assert.deepEqual([...events('/nonexistent/x.jsonl', 'codex')], []);
});
