// Each harness's spend is read from its OWN session log. Grok Build and Codex
// run the Claude Code hooks, but their transcript_path is their own format, and
// the Claude Code reader found $0 in a real Grok session: a spend limit never
// tripped there. `node test/harness-usage.test.mjs`.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'gov-harness-usage-'));
process.env.GOVERNOR_HOME = home;
process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;
delete process.env.ENFORCER_HARNESS;
delete process.env.CLAUDECODE;
const { writeChecksOn } = await import('./fixtures/checks-on.mjs');
writeChecksOn(home, { dollars: 0.02 });

const { readGrokUsage, TICKS_PER_USD } = await import('../adapters/grok/usage.mjs');
const { readCodexUsage } = await import('../adapters/codex/usage.mjs');
const { readUsage } = await import('../adapters/claude-code/usage.mjs');
const { read, usageReader, recordHarnessCost, HARNESS, TRANSCRIPT } = await import('../adapters/claude-code/meter.mjs');
const { cost, governor } = await import('../adapters/claude-code/index.mjs');
const { toolEvent } = await import('../adapters/claude-code/events.mjs');
const { priceOf } = await import('../core/policy.mjs');
const { DENY, ALLOW } = await import('../core/index.mjs');

const FIX = fileURLToPath(new URL('./fixtures/harness-usage/', import.meta.url));
const GROK = join(FIX, 'grok-updates.jsonl');
const CODEX = join(FIX, 'codex-rollout.jsonl');

let pass = 0;
const ok = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};
let n = 0;
const sid = (p) => `${p}-${++n}`;
// A private copy of a fixture, so a test can grow or rewrite it.
const copy = (src) => {
  const f = join(home, `log-${++n}.jsonl`);
  writeFileSync(f, readFileSync(src, 'utf8'));
  return f;
};
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
const grokTurn = (eventId, usage, model = 'grok-4.7-build') =>
  JSON.stringify({
    timestamp: 1,
    method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate: 'turn_completed', usage: { ...usage, modelUsage: { [model]: usage } } }, _meta: { eventId } },
  }) + '\n';
const grokPrompt = (text, promptIndex, modelId = 'grok-4.7-build') =>
  JSON.stringify({
    timestamp: 1,
    method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { modelId, promptIndex } } },
  }) + '\n';
const codexTotal = (input, cached, output) =>
  JSON.stringify({
    timestamp: 't',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      rate_limits: null,
    },
  }) + '\n';
const codexModel = (model) => JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { model } }) + '\n';

// The fixture's two turns, as Grok priced them.
const GROK_USD = (121495600 + 139481600) / 1e10;

// ── Grok ────────────────────────────────────────────────────────────────────

await ok('grok: a tick is 1e-10 USD (121495600 ticks were exported as $0.01214956)', () => {
  assert.equal(TICKS_PER_USD, 1e10);
  near(121495600 / TICKS_PER_USD, 0.01214956, 'one turn');
});

await ok('grok: sums each completed turn at Grok’s own price, names the model and the prompt', () => {
  const r = readGrokUsage(sid('g'), GROK);
  near(r.usd, GROK_USD, 'usd');
  assert.equal(r.model, 'grok-4.7-build');
  assert.equal(r.task, 'now ship it');
  assert.equal(r.tokens, Math.round((GROK_USD * 1e6) / priceOf('grok-4.7-build').in));
});

await ok('grok: a replayed turn (same eventId) is counted once', () => {
  // The fixture repeats its first turn_completed line; counting it again would
  // add $0.0121 the session never spent.
  const lines = readFileSync(GROK, 'utf8').trim().split('\n');
  assert.equal(lines[3], lines[4], 'the fixture really does repeat a line');
  near(readGrokUsage(sid('g'), GROK).usd, GROK_USD, 'usd');
});

await ok('grok: before any turn completes there is no figure yet, but the model and the prompt are known', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokPrompt('first ', 0) + grokPrompt('prompt', 0));
  const r = readGrokUsage(sid('g'), f);
  assert.equal(r.usd, null);
  assert.equal(r.tokens, 0);
  assert.equal(r.model, 'grok-4.7-build');
  assert.equal(r.task, 'first prompt', 'chunks of one prompt are joined');
});

await ok('grok: a new prompt replaces the task instead of being appended to the last one', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokPrompt('one', 0) + grokPrompt('two', 1));
  assert.equal(readGrokUsage(sid('g'), f).task, 'two');
});

await ok('grok: a long multi-line prompt is shown as one line of at most 140 characters', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokPrompt('line one\n\nline two ' + 'x'.repeat(300), 0));
  const t = readGrokUsage(sid('g'), f).task;
  assert.ok(t.startsWith('line one line two '), t);
  assert.equal(t.length, 140);
});

await ok('grok: a turn without Grok’s own figure is priced from its tokens, never counted as free', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokTurn('t1', { inputTokens: 1000, cachedReadTokens: 400, outputTokens: 100 }));
  const p = priceOf('grok-4.7-build');
  near(readGrokUsage(sid('g'), f).usd, (600 * p.in + 400 * p.cin + 100 * p.out) / 1e6, 'usd');
});

await ok('grok: a nonsense figure falls back to the tokens instead of poisoning the total', () => {
  for (const bad of [-5, 'free', null, Number.NaN]) {
    const f = join(home, `g-${++n}.jsonl`);
    writeFileSync(f, grokTurn('t1', { inputTokens: 1000, outputTokens: 0, costUsdTicks: bad }));
    const r = readGrokUsage(sid('g'), f);
    near(r.usd, (1000 * priceOf('grok-4.7-build').in) / 1e6, String(bad));
  }
});

await ok('grok: cached reads above the input are capped, so no turn prices below zero', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokTurn('t1', { inputTokens: 100, cachedReadTokens: 5000, outputTokens: 0 }));
  near(readGrokUsage(sid('g'), f).usd, (100 * priceOf('grok-4.7-build').cin) / 1e6, 'usd');
});

await ok('grok: a model switch is followed, and each turn keeps the price it was charged', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(
    f,
    grokTurn('a', { inputTokens: 10, outputTokens: 1, costUsdTicks: 1e8 }, 'grok-4.7-build') +
      grokTurn('b', { inputTokens: 10, outputTokens: 1, costUsdTicks: 2e8 }, 'grok-4.3'),
  );
  const r = readGrokUsage(sid('g'), f);
  near(r.usd, 0.03, 'usd');
  assert.equal(r.model, 'grok-4.3');
  assert.equal(r.tokens, Math.round((0.03 * 1e6) / priceOf('grok-4.3').in), 'tokens at the model answering now');
});

await ok('grok: reads only what was appended since the last call', () => {
  const f = copy(GROK);
  const s = sid('g');
  near(readGrokUsage(s, f).usd, GROK_USD, 'first read');
  appendFileSync(f, grokTurn('later', { inputTokens: 1, outputTokens: 1, costUsdTicks: 5e8 }));
  near(readGrokUsage(s, f).usd, GROK_USD + 0.05, 'after one more turn');
  near(readGrokUsage(s, f).usd, GROK_USD + 0.05, 'a read with nothing new changes nothing');
});

await ok('grok: a half-written line is read once it is complete, not dropped', () => {
  const f = join(home, `g-${++n}.jsonl`);
  const line = grokTurn('t1', { inputTokens: 1, outputTokens: 1, costUsdTicks: 1e9 });
  const s = sid('g');
  writeFileSync(f, line.slice(0, 40));
  assert.equal(readGrokUsage(s, f).usd, null);
  appendFileSync(f, line.slice(40));
  near(readGrokUsage(s, f).usd, 0.1, 'usd');
});

await ok('grok: a log that shrank or changed is read again from the top', () => {
  const f = copy(GROK);
  const s = sid('g');
  readGrokUsage(s, f);
  writeFileSync(f, grokTurn('fresh', { inputTokens: 1, outputTokens: 1, costUsdTicks: 1e8 }));
  near(readGrokUsage(s, f).usd, 0.01, 'after the rewrite');
  near(readGrokUsage(s, GROK).usd, GROK_USD, 'pointed at another log');
});

await ok('grok: garbage lines and other updates are skipped', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, 'not json\n{"params":null}\n{"params":{"update":"x"}}\n[]\n' + grokTurn('t', { inputTokens: 1, outputTokens: 1, costUsdTicks: 1e8 }));
  near(readGrokUsage(sid('g'), f).usd, 0.01, 'usd');
});

await ok('grok: no log, or one that does not exist, reads as nothing rather than throwing', () => {
  for (const p of [null, undefined, '', join(home, 'missing.jsonl')]) {
    assert.deepEqual(readGrokUsage(sid('g'), p), { tokens: 0, usd: null, model: '', task: '' }, String(p));
  }
});

await ok('grok: the cursor is a sweepable cursor-*.json, apart from the Claude Code reader’s', () => {
  const s = sid('g');
  readGrokUsage(s, GROK);
  readUsage(s, GROK);
  const files = readdirSync(home);
  assert.ok(files.includes(`cursor-grok-${s}.json`), files.join(' '));
  assert.ok(/^(cost|cursor)-[\w-]+\.json$/.test(`cursor-grok-${s}.json`), 'matches core/sweep.mjs SCRATCH');
});

// ── Codex ───────────────────────────────────────────────────────────────────

// The fixture's three totals: gpt-5-codex (priced as GPT-5) for two, then
// gpt-5.5 for the third. input includes cached; each increase is priced.
const g5 = priceOf('gpt-5-codex');
const g55 = priceOf('gpt-5.5');
const CODEX_USD =
  (2200 * g5.in + 3000 * g5.cin + 410 * g5.out) / 1e6 +
  (500 * g5.in + 6400 * g5.cin + 490 * g5.out) / 1e6 +
  (2000 * g55.in + 6000 * g55.cin + 400 * g55.out) / 1e6;

await ok('codex: prices each increase in the cumulative total at the model that turn named', () => {
  assert.equal(g5.key, 'gpt-5', 'gpt-5-codex is priced as GPT-5');
  near(CODEX_USD, 0.03855, 'the hand-worked figure');
  const r = readCodexUsage(sid('c'), CODEX);
  assert.equal(r.usd, null, 'Codex logs no dollars, so it is not reported as its own figure');
  assert.equal(r.model, 'gpt-5.5');
  assert.equal(r.task, 'make the build green');
  assert.equal(r.tokens, Math.round((CODEX_USD * 1e6) / g55.in));
});

await ok('codex: a token_count with info null (before the first response) counts nothing', () => {
  const f = join(home, `c-${++n}.jsonl`);
  writeFileSync(f, readFileSync(CODEX, 'utf8').split('\n').slice(0, 4).join('\n') + '\n');
  assert.equal(readCodexUsage(sid('c'), f).tokens, 0);
});

await ok('codex: the same total seen twice is not billed twice', () => {
  const f = join(home, `c-${++n}.jsonl`);
  writeFileSync(f, codexModel('gpt-5') + codexTotal(1000, 0, 0) + codexTotal(1000, 0, 0));
  assert.equal(readCodexUsage(sid('c'), f).tokens, 1000);
});

await ok('codex: a total that went down is a new baseline, never a refund and never billed twice', () => {
  const f = join(home, `c-${++n}.jsonl`);
  writeFileSync(f, codexModel('gpt-5') + codexTotal(5000, 0, 0) + codexTotal(100, 0, 0) + codexTotal(1100, 0, 0));
  assert.equal(readCodexUsage(sid('c'), f).tokens, 6000, '5000, then nothing for the reset, then 1000 more');
});

await ok('codex: cached input above the new input is capped, so no increase prices below zero', () => {
  const f = join(home, `c-${++n}.jsonl`);
  writeFileSync(f, codexModel('gpt-5') + codexTotal(1000, 0, 0) + codexTotal(1100, 900, 0));
  const usd = (1000 * g5.in + 100 * g5.cin) / 1e6;
  assert.equal(readCodexUsage(sid('c'), f).tokens, Math.round((usd * 1e6) / g5.in));
});

await ok('codex: reads only what was appended since the last call', () => {
  const f = copy(CODEX);
  const s = sid('c');
  const first = readCodexUsage(s, f).tokens;
  appendFileSync(f, codexTotal(21100, 15400, 1300));
  assert.equal(readCodexUsage(s, f).tokens, first + 1000, '1000 more uncached input at gpt-5.5');
});

await ok('codex: other line types, garbage and missing fields are skipped', () => {
  const f = join(home, `c-${++n}.jsonl`);
  writeFileSync(
    f,
    'nope\n{}\n{"type":"event_msg"}\n{"type":"event_msg","payload":{"type":"token_count","info":{}}}\n{"type":"response_item","payload":{"type":"message"}}\n' +
      codexModel('gpt-5') +
      codexTotal(10, 0, 0),
  );
  assert.equal(readCodexUsage(sid('c'), f).tokens, 10);
});

await ok('codex: transcript_path is null when the thread store is not local, and that reads as nothing', () => {
  assert.deepEqual(readCodexUsage(sid('c'), null), { tokens: 0, usd: null, model: '', task: '' });
});

// ── Choosing the reader ───────────────────────────────────────────────────────

await ok('the Claude Code reader finds nothing in either log: the bug this fixes', () => {
  assert.equal(readUsage(sid('x'), GROK).tokens, 0);
  assert.equal(readUsage(sid('x'), CODEX).tokens, 0);
});

await ok('each running harness gets its own reader, and anything else keeps Claude Code’s', () => {
  assert.equal(usageReader('grok-cli'), readGrokUsage);
  assert.equal(usageReader('codex'), readCodexUsage);
  assert.equal(usageReader('claude-code'), readUsage);
  assert.equal(usageReader(''), readUsage);
  process.env.ENFORCER_HARNESS = 'grok';
  assert.equal(usageReader(), readGrokUsage, 'the default follows ENFORCER_HARNESS');
  delete process.env.ENFORCER_HARNESS;
});

await ok('grok: the meter takes Grok’s own figure as the harness’s, like Claude Code’s status line', () => {
  const r = read(sid('m'), GROK, {}, 'grok-cli');
  assert.equal(r.source, HARNESS);
  near(r.usd, GROK_USD, 'usd');
  assert.equal(r.model, 'grok-4.7-build');
});

await ok('grok: before a turn completes the meter falls back the way Claude Code’s does', () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokPrompt('hi', 0));
  const r = read(sid('m'), f, {}, 'grok-cli');
  assert.equal(r.source, TRANSCRIPT);
  assert.equal(r.usd, null);
});

await ok('codex: the meter reports table arithmetic as the transcript, not the harness', () => {
  const r = read(sid('m'), CODEX, {}, 'codex');
  assert.equal(r.source, TRANSCRIPT);
  assert.equal(r.usd, null);
  assert.ok(r.tokens > 0);
});

await ok('a fresh status-line figure still wins for Claude Code, and never leaks into Grok', () => {
  const s = sid('m');
  recordHarnessCost(s, { total_cost_usd: 3 });
  assert.equal(read(s, null, {}, 'claude-code').usd, 3);
  near(read(s, GROK, {}, 'grok-cli').usd, GROK_USD, 'Grok’s own figure, not the status line’s');
});

await ok('the session-end total uses the running harness’s reader', () => {
  process.env.ENFORCER_HARNESS = 'grok';
  const t = cost.total({ session: sid('t'), transcript: GROK });
  near(t.usd, GROK_USD, 'grok usd');
  assert.equal(t.source, HARNESS);
  process.env.ENFORCER_HARNESS = 'codex';
  const c = cost.total({ session: sid('t'), transcript: CODEX });
  assert.equal(c.usd, null);
  assert.equal(c.source, TRANSCRIPT);
  assert.equal(c.tokens, Math.round((CODEX_USD * 1e6) / g55.in));
  delete process.env.ENFORCER_HARNESS;
});

// ── End to end: the limit trips ───────────────────────────────────────────────

// $0.026 of Grok spend against a $0.02 limit. Before this change the Claude
// Code reader saw $0 and let the call through.
const grokCall = (session, transcript) =>
  toolEvent({
    session_id: session,
    transcript_path: transcript,
    tool_name: 'Read',
    tool_input: { file_path: '/w/a.ts' },
    cwd: '/w',
    hook_event_name: 'PreToolUse',
  });

await ok('grok: a session past its dollar limit is stopped', async () => {
  process.env.ENFORCER_HARNESS = 'grok';
  const r = await governor().before(grokCall(sid('e2e'), GROK));
  delete process.env.ENFORCER_HARNESS;
  assert.equal(r.verdict.action, DENY, `got ${r.verdict.action}`);
  assert.ok(r.verdict.stopsAgent);
});

await ok('grok: the same session under its limit is allowed', async () => {
  const f = join(home, `g-${++n}.jsonl`);
  writeFileSync(f, grokTurn('t', { inputTokens: 1, outputTokens: 1, costUsdTicks: 1e7 }));
  process.env.ENFORCER_HARNESS = 'grok';
  const r = await governor().before(grokCall(sid('e2e'), f));
  delete process.env.ENFORCER_HARNESS;
  assert.equal(r.verdict.action, ALLOW, `got ${r.verdict.action}`);
});

await ok('codex: a session past its dollar limit is stopped', async () => {
  process.env.ENFORCER_HARNESS = 'codex';
  const r = await governor().before(grokCall(sid('e2e'), CODEX));
  delete process.env.ENFORCER_HARNESS;
  assert.equal(r.verdict.action, DENY, `$0.0386 of Codex spend against $0.02: got ${r.verdict.action}`);
});

await ok('the receipt records the dollars the harness’s own reader saw', () => {
  const recs = readFileSync(join(home, 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const grok = recs.find((r) => r.harness === 'grok-cli' && r.meter === HARNESS);
  assert.ok(grok, 'a grok-cli receipt metered by the harness');
  assert.ok(Math.abs(grok.spent_usd - GROK_USD) < 0.0001, `spent_usd ${grok.spent_usd}`);
  assert.ok(existsSync(join(home, 'receipts.jsonl')));
});

console.log(`\n  ${pass} passed`);
