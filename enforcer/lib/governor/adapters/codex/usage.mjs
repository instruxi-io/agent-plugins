// What a Codex session has cost so far, read from its rollout log.
//
// Codex hands hooks `transcript_path` = the session's rollout file
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; null when the thread store is
// not local). Each line is {timestamp, type, payload} (openai/codex
// codex-rs/history/src/lib.rs RolloutLine, rollout_payload.rs). Two kinds
// matter here:
//
//   {"type":"turn_context","payload":{"model":"gpt-5-codex",...}}
//   {"type":"event_msg","payload":{"type":"token_count","info":{
//       "total_token_usage":{input_tokens, cached_input_tokens, output_tokens,
//                            reasoning_output_tokens, total_tokens},
//       "last_token_usage":{...}}|null, "rate_limits":{...}|null}}
//
// total_token_usage is cumulative for the thread (protocol.rs append_last_usage
// adds last into total). input_tokens INCLUDES cached_input_tokens, and
// reasoning tokens are part of output_tokens (protocol.rs non_cached_input).
// Codex logs no dollar figure, so spend is priced here from the table, each
// increase at the model the latest turn_context named.

import { emptyUsage } from '../../core/cost.mjs';
import { priceOf } from '../../core/policy.mjs';
import { count, readForward, taskLine } from '../tail.mjs';

const fresh = () => ({ usd: 0, model: '', task: '', last: { input: 0, cached: 0, output: 0 }, usage: emptyUsage() });

function fold(cur, m) {
  const p = m?.payload;
  if (!p || typeof p !== 'object') return;
  if (m.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) cur.model = p.model;
    return;
  }
  if (m.type !== 'event_msg') return;
  if (p.type === 'user_message' && typeof p.message === 'string') {
    cur.task = p.message;
    return;
  }
  const t = p.type === 'token_count' ? p.info?.total_token_usage : null;
  if (!t || typeof t !== 'object') return;
  const now = { input: count(t.input_tokens), cached: count(t.cached_input_tokens), output: count(t.output_tokens) };
  // A total that went DOWN is not spend being refunded: it is a total that was
  // reset or rewritten. Take it as the new baseline and count nothing for it,
  // so a reset can never be billed twice.
  if (now.input < cur.last.input || now.cached < cur.last.cached || now.output < cur.last.output) {
    cur.last = now;
    return;
  }
  const dIn = now.input - cur.last.input;
  const dCached = Math.min(now.cached - cur.last.cached, dIn);
  const dOut = now.output - cur.last.output;
  const price = priceOf(cur.model);
  cur.usd += ((dIn - dCached) * price.in + dCached * (price.cin ?? price.in * 0.1) + dOut * price.out) / 1e6;
  // Codex's input includes the cached part, and its output the reasoning.
  cur.usage.input += dIn - dCached;
  cur.usage.cache_read += dCached;
  cur.usage.output += dOut;
  cur.last = now;
}

/**
 * @returns {{tokens:number, usd:null, model:string, task:string, usage:object}}
 *   `usd` is always null: the figure is table arithmetic, not Codex's own, so
 *   it is reported the way the Claude Code transcript reading is, as tokens.
 */
export function readCodexUsage(sessionId, transcriptPath) {
  const out = { tokens: 0, usd: null, model: '', task: '', usage: emptyUsage() };
  const cur = readForward(`codex-${sessionId || 'default'}`, transcriptPath, fresh, fold);
  if (!cur) return out;
  out.model = cur.model;
  out.task = taskLine(cur.task);
  out.usage = { ...cur.usage };
  out.tokens = Math.round((cur.usd * 1e6) / priceOf(cur.model).in);
  return out;
}
