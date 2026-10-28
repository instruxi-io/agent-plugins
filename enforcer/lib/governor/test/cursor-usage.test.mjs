// Cursor's spend: from the usage the shim recorded off hook payloads, else from the
// transcript, tolerantly. Also the harness stamp and agent prefix. `node test/cursor-usage.test.mjs`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'gov-cursor-usage-'));
process.env.GOVERNOR_HOME = home;
process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;
delete process.env.ENFORCER_HARNESS;
delete process.env.CLAUDECODE;

const { readCursorUsage, usageOf, cursorModel } = await import('../adapters/cursor/usage.mjs');
const { usageReader, read: meterRead } = await import('../adapters/claude-code/meter.mjs');
const { runningHarness, agentPrefix } = await import('../adapters/claude-code/harness.mjs');
const { priceOf } = await import('../core/policy.mjs');

const T = fileURLToPath(new URL('./fixtures/harness-usage/cursor-transcript.jsonl', import.meta.url));
const T6 = join(home, 'cursor-transcript-46.jsonl');
const ok = (m) => console.log('  ok  ' + m);

assert.equal(runningHarness({ ENFORCER_HARNESS: 'cursor' }), 'cursor');
assert.equal(agentPrefix({ ENFORCER_HARNESS: 'cursor' }), 'cursor');
assert.equal(usageReader('cursor'), readCursorUsage);
ok('ENFORCER_HARNESS=cursor stamps harness cursor, agent prefix cursor:, and reads Cursor usage');

assert.deepEqual(usageOf({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 }), {
  input: 3,
  output: 4,
  cache_read: 5,
  cache_write: 0,
  reasoning: 0,
});
assert.deepEqual(usageOf({ inputTokens: 3, outputTokens: 4 }), { input: 3, output: 4, cache_read: 0, cache_write: 0, reasoning: 0 });
assert.equal(usageOf('nope'), null);
ok('usage in Anthropic, OpenAI and camelCase spellings');

assert.deepEqual(cursorModel('claude-4.6-sonnet'), { model: 'claude-sonnet-4-6', price: priceOf('claude-sonnet-4-6') });
assert.equal(cursorModel('claude-sonnet-4-6').model, 'claude-sonnet-4-6');
assert.equal(cursorModel('claude-4-5-haiku').model, 'claude-haiku-4-5');
for (const id of ['composer-1', 'auto', 'default', 'gpt-9-turbo', 'claude-4.5-sonnet', 'claude-opus-9-9'])
  assert.deepEqual(cursorModel(id), { model: `unpriced:${id}`, price: null }, `${id} is not priced as the dearest model`);
ok("Cursor model ids: claude-<ver>-<family> reads as the table's key; ids the table lacks are unpriced, not Opus");

let u = readCursorUsage('s-transcript', T);
assert.deepEqual(u.usage, { input: 1500, output: 300, cache_read: 4000, cache_write: 0, reasoning: 0 });
assert.equal(u.task, 'Fix the failing auth tests');
// The fixture's model (claude-4.5-sonnet) is not in the table: counted, never priced.
assert.equal(u.model, 'unpriced:claude-4.5-sonnet');
assert.equal(u.unpriced, true);
assert.equal(u.usd, null);
assert.equal(u.tokens, 1500 + 300 + 4000, 'the raw token count');
ok('transcript: generations counted once, corrupt lines skipped, task and model read; an unknown model is unpriced');

writeFileSync(T6, readFileSync(T, 'utf8').replaceAll('claude-4.5-sonnet', 'claude-4.6-sonnet'));
u = readCursorUsage('s-transcript-46', T6);
assert.equal(u.model, 'claude-sonnet-4-6');
assert.equal(u.unpriced, undefined);
const p = priceOf(u.model);
const usd = (1500 * p.in + 300 * p.out + 4000 * (p.cin ?? p.in * 0.1)) / 1e6;
assert.equal(u.tokens, Math.round((usd * 1e6) / p.in));
ok('a known model is priced from the table');

{
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (t) => (lines.push(String(t)), true);
  let a, b;
  try {
    a = readCursorUsage('s-none', join(home, 'missing.jsonl'));
    b = readCursorUsage('s-none', join(home, 'missing.jsonl'));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(a.tokens, 0);
  assert.equal(a.usd, null, 'not $0');
  assert.equal(a.unmetered, true);
  assert.equal(b.unmetered, true);
  assert.equal(lines.filter((l) => /unmetered/.test(l)).length, 1, 'said once per session');
  const r = meterRead('s-none', join(home, 'missing.jsonl'), {}, 'cursor');
  assert.equal(r.source, 'unmetered');
  assert.equal(r.unmetered, undefined);
}
ok('no transcript, no payload: unmetered (not $0, not a throw), logged once');

writeFileSync(
  join(home, 'cursor-usage-s-pay.json'),
  JSON.stringify({
    gens: {
      g1: { usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 0 }, usd: 0.01, model: 'claude-4.5-sonnet' },
      g2: { usage: { input: 20, output: 5, cache_read: 0, cache_write: 0, reasoning: 0 }, usd: 0.02 },
    },
  }),
);
u = readCursorUsage('s-pay', T);
assert.deepEqual(u.usage, { input: 30, output: 10, cache_read: 0, cache_write: 0, reasoning: 0 });
assert.ok(Math.abs(u.usd - 0.03) < 1e-12, 'every generation carried its cost: that figure is the spend');
assert.equal(u.task, 'Fix the failing auth tests', 'the transcript still names the task');
ok('payload usage recorded by the shim wins over the transcript');

writeFileSync(
  join(home, 'cursor-usage-s-composer.json'),
  JSON.stringify({ gens: { g1: { usage: { input: 100, output: 50, cache_read: 0, cache_write: 0, reasoning: 0 }, usd: null, model: 'composer-1' } } }),
);
u = readCursorUsage('s-composer', join(home, 'missing.jsonl'));
assert.equal(u.model, 'unpriced:composer-1');
assert.equal(u.unpriced, true);
assert.equal(u.usd, null);
assert.equal(u.tokens, 150);
assert.equal(meterRead('s-composer', join(home, 'missing.jsonl'), {}, 'cursor').source, 'unpriced');
ok("payload usage from Cursor's own model: unpriced, the raw count, source unpriced");
