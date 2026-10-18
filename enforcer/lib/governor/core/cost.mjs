// What a receipt's cost_usd may carry. Harness-neutral: the rule comes from the
// governance column it lands in, not from where the dollar figure was measured.
export const COST_MAX = 1e6;

/**
 * A dollar figure as a receipt may carry it, or undefined when there is no
 * honest number to send.
 *
 * Undefined rather than 0: the server stores a missing cost as 0 and reads that
 * back as "the edge never reported one", so a fabricated zero and a real zero
 * are the same row. Sending nothing keeps that distinction true.
 *
 * Rounded to six decimals because the column is numeric(12,6) — shipping a full
 * float would be rounded at the far end anyway, and then the receipt's hash
 * would cover a number nobody stored.
 */
export function costUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  // Bound the ROUNDED value, not the raw one: 999999.9999999 is inside the
  // limit until six-decimal rounding lifts it to exactly 1e6, which the server
  // then refuses — and a refused receipt is one the install resends forever.
  const rounded = Math.round(n * 1e6) / 1e6;
  return rounded >= COST_MAX ? undefined : rounded;
}

// The token counts a receipt's `usage` may carry, in the order they are sent.
// `input` excludes cache reads and writes (Anthropic's split; the Grok and Codex
// readers normalise to it). `reasoning` is Grok's own figure as it reported
// it, which may overlap `output`, so a reader must never add it to a total.
export const USAGE_KEYS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning'];
export const USAGE_MAX = 1e12;

/** Running counts for a reader to add to: every key at 0. */
export const emptyUsage = () => Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));

/**
 * Token counts as a receipt may carry them, or undefined when there are none.
 *
 * Counts are what the harness measured; a dollar figure is those counts times a
 * price table that can be wrong (an unlisted model is priced at the most
 * expensive in its family). Shipping the counts lets the server read the
 * session without trusting our table. Whole numbers only, zero keys dropped,
 * and no field at all for a session that used nothing, for the reason costUsd
 * sends nothing rather than a fabricated zero.
 */
export function receiptUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const out = {};
  for (const k of USAGE_KEYS) {
    const n = u[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    const whole = Math.round(n);
    if (whole > 0 && whole < USAGE_MAX) out[k] = whole;
  }
  return Object.keys(out).length ? out : undefined;
}
