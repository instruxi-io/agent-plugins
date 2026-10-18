// Claude prices as Anthropic publishes them, and the transcript reader paying
// them per message. Source for every figure below:
// Anthropic's pricing page (docs: about-claude/pricing), read 2026-10-18.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-claude-prices-'));
process.env.GOVERNOR_HOME = home;
process.env.ENFORCER_HOME = join(home, 'e');

const { MODELS, priceOf, rateFor, weightsFor } = await import('../core/policy.mjs');
const { readUsage } = await import('../adapters/claude-code/usage.mjs');

let pass = 0;
const ok = (label, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + label);
};
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
let n = 0;
const transcript = (...msgs) => {
  const f = join(home, `t-${++n}.jsonl`);
  writeFileSync(f, msgs.map(([id, model, usage]) => JSON.stringify({ type: 'assistant', message: { id, model, usage } })).join('\n') + '\n');
  return f;
};
// What the reader charged, in dollars, at the model it ended on.
const usd = (f) => {
  const r = readUsage(`s-${++n}`, f);
  return (r.tokens * priceOf(r.model).in) / 1e6;
};

ok('every current Claude model has its published rates', () => {
  const want = {
    'claude-fable-5-1': [10, 50, 0.25],
    'claude-mythos-5-1': [10, 50, 0.25],
    'claude-fable-5': [10, 50, 1],
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-opus-5': [5, 25, 0.5],
    'claude-sonnet-5-5': [2, 10, 0.1],
    'claude-sonnet-5': [2, 10, 0.2],
    'claude-haiku-5-5': [0.1, 0.5, 0.01],
    'claude-haiku-4-5': [1, 5, 0.1],
  };
  for (const [model, [i, o, c]] of Object.entries(want)) {
    const r = rateFor(model);
    assert.equal(r.key, model, `${model} is its own row, not a prefix's`);
    assert.deepEqual([r.in, r.out], [i, o], model);
    near(r.cin, c, `${model} cache read`);
  }
});

ok('a dated or suffixed id finds its own row before the shorter family name', () => {
  assert.equal(priceOf('claude-opus-5-5-20261001').key, 'claude-opus-5-5');
  assert.equal(priceOf('claude-fable-5-1').key, 'claude-fable-5-1');
  assert.equal(priceOf('claude-sonnet-5-5[1m]').key, 'claude-sonnet-5-5');
  assert.equal(priceOf('claude-haiku-5-5').key, 'claude-haiku-5-5');
  assert.equal(priceOf('claude-opus-5').key, 'claude-opus-5', 'Opus 5 itself is unchanged');
});

ok('Haiku 5.5 pays its long rates only past 100,000 prompt tokens', () => {
  assert.deepEqual([rateFor('claude-haiku-5-5', 100_000).in, rateFor('claude-haiku-5-5', 100_000).out], [0.1, 0.5], 'exactly 100,000 is not over');
  const long = rateFor('claude-haiku-5-5', 100_001);
  assert.deepEqual([long.in, long.out, long.cin], [0.5, 2.5, 0.05]);
  assert.equal(rateFor('claude-opus-5-5', 900_000).in, 4, 'no other model has a tier');
});

ok('weights follow each model, so a 5.5 cache read is 0.05x input', () => {
  near(weightsFor('claude-opus-5-5').cacheRead, 0.05, 'opus 5.5');
  near(weightsFor('claude-fable-5-1').cacheRead, 0.025, 'fable 5.1');
  near(weightsFor('claude-opus-5').cacheRead, 0.1, 'opus 5');
});

ok('every Claude row keeps Anthropic’s output at 5x input', () => {
  for (const [k, m] of Object.entries(MODELS)) if (m.p === 'anthropic') assert.ok(m.out === 5 * m.in, `${k}: Anthropic output is 5x input`);
});

// A real headless Claude Code run on Haiku 5.5 (2026-10-18): Claude Code
// reported total_cost_usd 0.00420298 for these counts, its cache writes on the
// 1-hour TTL. 1.3.23 metered it at $0.21, pricing Haiku 5.5 as Opus 5.
ok('the reader reproduces Claude Code’s own figure for a Haiku 5.5 session', () => {
  const f = transcript([
    'm1',
    'claude-haiku-5-5',
    { input_tokens: 4, output_tokens: 196, cache_read_input_tokens: 40718, cache_creation: { ephemeral_1h_input_tokens: 18487, ephemeral_5m_input_tokens: 0 } },
  ]);
  near(usd(f), 0.004203, 'haiku 5.5');
  assert.ok(Math.abs(usd(f) - 0.00420298) < 5e-8, 'within rounding of Claude Code’s 0.00420298');
});

ok('a Haiku 5.5 request over 100,000 prompt tokens pays the long rates for the whole request', () => {
  const f = transcript(['m1', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 120_000 }]);
  near(usd(f), (1000 * 0.5 + 100 * 2.5 + 120_000 * 0.05) / 1e6, 'long tier');
});

ok('each message is tiered on its own prompt', () => {
  const f = transcript(
    ['a', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 50_000 }],
    ['b', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 150_000 }],
  );
  near(usd(f), (10 * 0.1 + 10 * 0.5 + 50_000 * 0.01) / 1e6 + (10 * 0.5 + 10 * 2.5 + 150_000 * 0.05) / 1e6, 'short then long');
});

ok('Opus 5.5 and Fable 5.1 cache reads are charged at their own rates', () => {
  near(usd(transcript(['o', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }])), 0.2, 'opus 5.5');
  near(usd(transcript(['f', 'claude-fable-5-1', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }])), 0.25, 'fable 5.1');
  near(usd(transcript(['o5', 'claude-opus-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }])), 0.5, 'opus 5');
});

ok('cache writes are 1.25x (5-minute) and 2x (1-hour) input on the new models too', () => {
  near(
    usd(
      transcript([
        'w',
        'claude-opus-5-5',
        { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } },
      ]),
    ),
    5 + 8,
    'opus 5.5',
  );
});

ok('a web search costs $0.01 whatever model asked for it', () => {
  near(usd(transcript(['s', 'claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }])), 0.03, 'haiku');
  near(usd(transcript(['s2', 'claude-opus-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_fetch_requests: 1 } }])), 0.01, 'opus');
});

ok('a cursor priced by an older reader is read again from the top', () => {
  const f = transcript(['x', 'claude-haiku-5-5', { input_tokens: 0, output_tokens: 1_000_000 }]);
  const s = `s-${++n}`;
  // 1.3.23's cursor: counts kept, but its usd priced Haiku 5.5 as Opus 5.
  writeFileSync(
    join(home, `cursor-${s}.json`),
    JSON.stringify({
      path: f,
      offset: 1e9,
      usd: 25,
      seen: ['x'],
      model: 'claude-haiku-5-5',
      task: '',
      usage: { input: 0, output: 1_000_000, cache_read: 0, cache_write: 0, reasoning: 0 },
    }),
  );
  const r = readUsage(s, f);
  near((r.tokens * priceOf(r.model).in) / 1e6, 0.5, 'repriced at Haiku 5.5');
});

console.log(`\n  ${pass} passed`);
