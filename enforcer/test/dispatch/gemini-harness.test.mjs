import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { countTurns, events } from '../../src/dispatch/stream.mjs';
import { summarize } from '../../src/dispatch/summarize.mjs';
import { launchCmd, HARNESSES, HARNESS_CAPS, harnessRefusal } from '../../src/dispatch/launch.mjs';
import { NATIVE } from '../../src/harness-migrate.mjs';

// Recorded from gemini 0.38.0: `gemini -p "..." -o stream-json --approval-mode yolo`.
const FIX = fileURLToPath(new URL('../fixtures/gemini-stream.jsonl', import.meta.url));

test('launchCmd builds a gemini command with the prompt and model', () => {
  const cmd = launchCmd('do the node', 'gemini-3.1-pro-preview', {}, 'k', { harness: 'gemini' });
  assert.deepEqual(cmd, ['gemini', '-p', 'do the node', '-o', 'stream-json', '--approval-mode', 'yolo', '-m', 'gemini-3.1-pro-preview']);
  // a claude model name is not passed to gemini
  assert.ok(!launchCmd('p', 'opus', {}, 'k', { harness: 'gemini' }).includes('-m'));
  assert.equal(launchCmd('p', null, { gemini: '/opt/gemini' }, 'k', { harness: 'gemini' })[0], '/opt/gemini');
});

test('gemini is a supported, experimental harness', () => {
  assert.ok(HARNESSES.includes('gemini'));
  assert.equal(HARNESS_CAPS.gemini.supported, true);
  assert.equal(HARNESS_CAPS.gemini.experimental, true);
  assert.match(harnessRefusal('gemini', false), /experimental/);
  assert.equal(harnessRefusal('gemini', true), null);
});

test("counts the fixture's assistant turns", () => {
  // two streamed assistant messages (delta runs) + one tool_use in the recorded stream
  assert.equal(countTurns(FIX, 'gemini'), 3);
});

test('tool use carries the shell command and its result', () => {
  const evs = [...events(FIX, 'gemini')];
  const tu = evs.flatMap((e) => e.message.content || []).filter((c) => c.type === 'tool_use');
  assert.deepEqual(
    tu.map((c) => c.name),
    ['Bash'],
  );
  assert.match(tu[0].input.command, /echo hello-gemini/);
  const tr = evs.flatMap((e) => e.message.content || []).filter((c) => c.type === 'tool_result');
  assert.equal(tr[0].tool_use_id, tu[0].id);
  assert.equal(tr[0].is_error, false);
});

test('summarize reads usage from the fixture', () => {
  const s = summarize(FIX, 'gemini');
  assert.equal(s.usage.input_tokens, 18589);
  assert.equal(s.usage.output_tokens, 53);
  assert.equal(s.turns, 3);
  assert.equal(s.result, 'success');
  assert.match(s.session_id, /^[0-9a-f-]{36}$/);
});

test('install wires the graph MCP server through gemini mcp add', () => {
  assert.match(NATIVE.gemini, /^gemini mcp add .*--transport http .*enforcer .*X-API-Key/);
});

test('a missing file yields no events', () => {
  assert.deepEqual([...events('/nonexistent/x.jsonl', 'gemini')], []);
});
