// Cursor's spend: from the usage the shim recorded off hook payloads, else from the
// transcript, tolerantly. Also the harness stamp and agent prefix. `node test/cursor-usage.test.mjs`.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'gov-cursor-usage-'));
process.env.GOVERNOR_HOME = home;
process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;
delete process.env.ENFORCER_HARNESS;
delete process.env.CLAUDECODE;

const { readCursorUsage, usageOf } = await import('../adapters/cursor/usage.mjs');
const { usageReader } = await import('../adapters/claude-code/meter.mjs');
const { runningHarness, agentPrefix } = await import('../adapters/claude-code/harness.mjs');
const { priceOf } = await import('../core/policy.mjs');

const T = fileURLToPath(new URL('./fixtures/harness-usage/cursor-transcript.jsonl', import.meta.url));
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

let u = readCursorUsage('s-transcript', T);
assert.deepEqual(u.usage, { input: 1500, output: 300, cache_read: 4000, cache_write: 0, reasoning: 0 });
assert.equal(u.model, 'claude-4.5-sonnet');
assert.equal(u.task, 'Fix the failing auth tests');
assert.equal(u.usd, null, 'priced from the table, not a Cursor figure');
const p = priceOf(u.model);
const usd = (1500 * p.in + 300 * p.out + 4000 * (p.cin ?? p.in * 0.1)) / 1e6;
assert.equal(u.tokens, Math.round((usd * 1e6) / p.in));
ok('transcript: generations counted once, corrupt lines skipped, task and model read');

assert.equal(readCursorUsage('s-none', join(home, 'missing.jsonl')).tokens, 0);
ok('no transcript, no payload: zero, not a throw');

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
