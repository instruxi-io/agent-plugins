// What a Cursor session has cost so far, from whatever Cursor hands the hooks.
//
// UNVERIFIED: Cursor's documented hook payloads carry no per-turn token usage
// (preCompact's context_tokens is the context window, not spend), and its agent
// transcript (transcript_path, JSONL) is documented only as "the conversation".
// So this reads two places, tolerantly, and counts nothing it cannot recognise:
//
//   1. cursor-usage-<session>.json, which the Cursor shim (hooks/cursor/shim.mjs)
//      writes when a hook payload carries a usage object (`usage`, `token_usage`,
//      `tokenUsage`, `tokens`, or flat input_tokens / output_tokens): one figure
//      per generation_id, the latest, so a payload repeated on every tool call
//      of one generation is counted once;
//   2. the transcript: any line with a usage object (line.usage, line.message.usage,
//      line.tokenUsage) in Anthropic, OpenAI or camelCase spelling. A line's id
//      (id, message.id, generation_id) is counted once.
//
// The payload figure wins when there is one; the transcript is still read for
// the model and the last prompt. Spend is priced from the table (usd stays
// null, as Codex's does), unless the payload carried Cursor's own cost.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR } from '../../core/store.mjs';
import { emptyUsage } from '../../core/cost.mjs';
import { priceOf } from '../../core/policy.mjs';
import { count, readForward, taskLine } from '../tail.mjs';

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const first = (u, ...ks) => {
  for (const k of ks) if (typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0) return u[k];
  return 0;
};

/** A usage object in any of the spellings above, as receipt usage keys. */
export function usageOf(u) {
  if (!isObj(u)) return null;
  const usage = {
    input: count(first(u, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens')),
    output: count(first(u, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens')),
    cache_read: count(first(u, 'cache_read_input_tokens', 'cache_read_tokens', 'cacheReadTokens', 'cachedReadTokens')),
    cache_write: count(first(u, 'cache_creation_input_tokens', 'cache_write_tokens', 'cacheWriteTokens', 'cacheCreationTokens')),
    reasoning: count(first(u, 'reasoning_tokens', 'reasoningTokens')),
  };
  // OpenAI's prompt_tokens include the cached reads; Anthropic's input_tokens do not.
  if (typeof u.prompt_tokens === 'number' && isObj(u.prompt_tokens_details)) {
    const c = Math.min(count(u.prompt_tokens_details.cached_tokens), usage.input);
    usage.input -= c;
    usage.cache_read += c;
  }
  return Object.values(usage).some(Boolean) ? usage : null;
}

const add = (a, b) => {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
};
const priced = (u, model) => {
  const p = priceOf(model);
  return (u.input * p.in + u.cache_read * (p.cin ?? p.in * 0.1) + u.cache_write * (p.cw ?? p.in * 1.25) + u.output * p.out) / 1e6;
};

const fresh = () => ({ turns: 0, model: '', task: '', usage: emptyUsage() });
const textOf = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('');
  return '';
};
function fold(cur, m, seen) {
  if (!isObj(m)) return;
  const msg = isObj(m.message) ? m.message : m;
  const role = m.role || msg.role || m.type;
  const model = [m.model, msg.model, m.model_id].find((x) => typeof x === 'string' && x);
  if (model) cur.model = model;
  if (role === 'user') {
    const t = textOf(msg.content ?? m.text ?? m.prompt);
    if (t) cur.task = t;
  }
  const u = usageOf(m.usage) || usageOf(msg.usage) || usageOf(m.tokenUsage) || usageOf(m.token_usage);
  if (!u) return;
  const id = m.id || msg.id || m.generation_id || m.requestId;
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  add(cur.usage, u);
  cur.turns++;
}

const sidecar = (sid) => join(DIR, `cursor-usage-${String(sid || 'default').replace(/[^\w-]/g, '')}.json`);

/** The payload figures the shim recorded for this session, summed over generations. */
export function payloadTotals(sessionId) {
  let d;
  try {
    d = JSON.parse(readFileSync(sidecar(sessionId), 'utf8'));
  } catch {
    return null;
  }
  if (!isObj(d?.gens)) return null;
  const usage = emptyUsage();
  let usd = 0,
    own = 0,
    model = '',
    turns = 0;
  for (const g of Object.values(d.gens)) {
    const u = usageOf(
      isObj(g?.usage)
        ? {
            input_tokens: g.usage.input,
            output_tokens: g.usage.output,
            cache_read_tokens: g.usage.cache_read,
            cache_write_tokens: g.usage.cache_write,
            reasoning_tokens: g.usage.reasoning,
          }
        : null,
    );
    if (typeof g?.model === 'string' && g.model) model = g.model;
    if (typeof g?.usd === 'number' && Number.isFinite(g.usd) && g.usd >= 0) {
      usd += g.usd;
      own++;
    } else if (u) usd += priced(u, model);
    if (u) add(usage, u);
    turns++;
  }
  return turns ? { usage, usd, own: own === turns, model, turns } : null;
}

/**
 * @returns {{tokens:number, usd:number|null, model:string, task:string, usage:object}}
 *   `usd` is Cursor's own figure when every recorded generation carried one, else null;
 *   `tokens` is the spend in effective input tokens at the model answering now.
 */
export function readCursorUsage(sessionId, transcriptPath) {
  const out = { tokens: 0, usd: null, model: '', task: '', usage: emptyUsage() };
  const cur = readForward(`cursor-${sessionId || 'default'}`, transcriptPath, fresh, fold) || fresh();
  const pay = payloadTotals(sessionId);
  out.model = pay?.model || cur.model;
  out.task = taskLine(cur.task);
  if (pay) {
    out.usage = { ...pay.usage };
    if (pay.own) out.usd = pay.usd;
    out.tokens = Math.round((pay.usd * 1e6) / priceOf(out.model).in);
    return out;
  }
  out.usage = { ...cur.usage };
  if (cur.turns) out.tokens = Math.round((priced(cur.usage, out.model) * 1e6) / priceOf(out.model).in);
  return out;
}
