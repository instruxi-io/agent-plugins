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
//
// Two honest gaps, said rather than filled in:
//   - unmetered: neither place had any usage. That is "Cursor did not say", not
//     $0, so the reading carries `unmetered: true` and the receipts no dollars;
//   - unpriced: Cursor's own model ids (composer-1, auto, default) and ones the
//     table does not have are NOT priced as the dearest Claude: the model reads
//     `unpriced:<id>`, `unpriced: true`, usd null, and the tokens are the raw count.
//     Cursor's `claude-<ver>-<family>` spelling (claude-4.6-sonnet) is read as the
//     table's (claude-sonnet-4-6) first.
import { readFileSync, writeFileSync } from 'node:fs';
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
/** A Cursor model id as the price table's key, or `unpriced:<id>` with price null. */
export function cursorModel(id) {
  const m = String(id || '')
    .trim()
    .toLowerCase();
  const n = m.replace(/^claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)\b/, (_, a, b, f) => `claude-${f}-${a}${b ? `-${b}` : ''}`);
  const p = n ? priceOf(n) : null;
  // priceOf falls back by family and then to the dearest model; only an exact table key counts.
  if (p && n.includes(p.key)) return { model: n, price: p };
  return { model: `unpriced:${m || 'unknown'}`, price: null };
}
const rawTokens = (u) => u.input + u.output + u.cache_read + u.cache_write;
const priced = (u, model) => {
  const p = cursorModel(model).price;
  if (!p) return null;
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
    turns = 0,
    unpriced = 0;
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
    } else if (u) {
      const c = priced(u, model);
      if (c === null) unpriced++;
      else usd += c;
    }
    if (u) add(usage, u);
    turns++;
  }
  return turns
    ? {
        usage,
        usd,
        own: own === turns,
        model,
        turns,
        unpriced: own !== turns && unpriced > 0,
      }
    : null;
}

/**
 * @returns {{tokens:number, usd:number|null, model:string, task:string, usage:object, unmetered?:true, unpriced?:true}}
 *   `usd` is Cursor's own figure when every recorded generation carried one, else null;
 *   `tokens` is the spend in effective input tokens at the model answering now (the raw
 *   count when the model is unpriced).
 */
export function readCursorUsage(sessionId, transcriptPath) {
  const out = { tokens: 0, usd: null, model: '', task: '', usage: emptyUsage() };
  const cur = readForward(`cursor-${sessionId || 'default'}`, transcriptPath, fresh, fold) || fresh();
  const pay = payloadTotals(sessionId);
  const id = pay?.model || cur.model;
  const m = cursorModel(id);
  out.model = id ? m.model : '';
  out.task = taskLine(cur.task);
  const usage = pay ? pay.usage : cur.usage;
  out.usage = { ...usage };
  if (pay?.own) {
    out.usd = pay.usd;
    out.tokens = Math.round((pay.usd * 1e6) / priceOf(m.price ? m.model : '').in);
    return out;
  }
  if (!pay && !cur.turns) {
    sayUnmetered(sessionId);
    out.unmetered = true;
    return out;
  }
  if (!m.price || pay?.unpriced) {
    out.unpriced = true;
    out.model = m.price ? m.model : m.model || 'unpriced:unknown';
    out.tokens = rawTokens(usage);
    return out;
  }
  const usd = pay ? pay.usd : priced(cur.usage, out.model);
  out.tokens = Math.round((usd * 1e6) / m.price.in);
  return out;
}

// Said once per session (a marker beside the sidecar), not on every hook.
function sayUnmetered(sid) {
  try {
    writeFileSync(`${sidecar(sid)}.unmetered`, '', { flag: 'wx', mode: 0o600 });
  } catch {
    return;
  }
  process.stderr.write('enforcer-governor: Cursor reported no token usage for this session; its spend is unmetered, not $0.\n');
}
