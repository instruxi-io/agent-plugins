// What a Grok Build session has cost so far, read from its own session log.
//
// Grok hands hooks `transcript_path` = ~/.grok/sessions/<cwd>/<session>/updates.jsonl.
// Each line is {timestamp, method, params: {sessionId, update, _meta: {eventId}}}.
// A `turn_completed` update carries that TURN's usage (not a running total):
//
//   usage: {inputTokens, cachedReadTokens, outputTokens, reasoningTokens,
//           modelCalls, costUsdTicks, modelUsage: {<model>: {...same}}}
//
// costUsdTicks is Grok's own price for the turn in units of 1e-10 USD: a
// grok 1.0.46 turn logged 121495600 ticks and exported grok_code.cost.usage =
// 0.01214956 USD for the same turn. Grok's figure wins, as Claude Code's does:
// it is the harness's own number, priced at whatever rate the account pays.
//
// The limit: usage lands when a turn COMPLETES. A hook mid-turn sees every
// finished turn's spend but not the one in flight.
import { priceOf } from '../../core/policy.mjs';
import { count, readForward, taskLine } from '../tail.mjs';

export const TICKS_PER_USD = 1e10;

const fresh = () => ({ usd: 0, turns: 0, model: '', task: '', prompt: null });

// A turn without Grok's own figure (an older or newer build that drops the
// field) is priced from its tokens at the table's rate for its model, so it is
// never counted as free. inputTokens includes the cached reads.
function priced(u, model) {
  const p = priceOf(model);
  const input = count(u.inputTokens);
  const cached = Math.min(count(u.cachedReadTokens), input);
  return ((input - cached) * p.in + cached * (p.cin ?? p.in * 0.1) + count(u.outputTokens) * p.out) / 1e6;
}

function fold(cur, m, seen) {
  const u = m?.params?.update;
  if (!u || typeof u !== 'object') return;
  // A prompt can arrive in several chunks; chunks of one prompt share its
  // promptIndex, and the model answering it is named before any usage lands.
  if (u.sessionUpdate === 'user_message_chunk') {
    const at = u._meta?.promptIndex;
    const text = typeof u.content?.text === 'string' ? u.content.text : '';
    cur.task = at !== undefined && at === cur.prompt ? cur.task + text : text;
    cur.prompt = at;
    if (typeof u._meta?.modelId === 'string' && u._meta.modelId) cur.model = u._meta.modelId;
    return;
  }
  if (u.sessionUpdate !== 'turn_completed' || !u.usage || typeof u.usage !== 'object') return;
  const id = m.params._meta?.eventId;
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  const models = Object.keys(u.usage.modelUsage || {});
  if (models.length) cur.model = models[models.length - 1];
  const ticks = u.usage.costUsdTicks;
  cur.usd += typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0 ? ticks / TICKS_PER_USD : priced(u.usage, cur.model);
  cur.turns++;
}

/**
 * @returns {{tokens:number, usd:number|null, model:string, task:string}}
 *   `usd` is Grok's own figure, null until a turn has completed; `tokens` is
 *   that figure in effective input tokens at the model answering now.
 */
export function readGrokUsage(sessionId, transcriptPath) {
  const out = { tokens: 0, usd: null, model: '', task: '' };
  const cur = readForward(`grok-${sessionId || 'default'}`, transcriptPath, fresh, fold);
  if (!cur) return out;
  out.model = cur.model;
  out.task = taskLine(cur.task);
  if (!cur.turns) return out;
  out.usd = cur.usd;
  out.tokens = Math.round((cur.usd * 1e6) / priceOf(cur.model).in);
  return out;
}
