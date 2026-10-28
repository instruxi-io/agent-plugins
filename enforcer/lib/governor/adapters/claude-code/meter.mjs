// Where the money figure comes from — and, just as importantly, which source
// it came from.
//
// v1 and v2 computed spend themselves: parse the transcript, apply a weight
// table, price it against a hand-maintained list of ~20 models across four
// vendors. That was the only option when the tool was a daemon talking to a
// proxy. It is no longer, and it was never going to be right: Claude Code
// computes the same figure, and it can compute it at an organisation's
// CONTRACTED rates. A third-party price list is not merely stale-prone against
// that, it is unknowable — there is no public number to look up.
//
// So the harness's figure wins wherever we can get it. The catch is that
// PreToolUse is not handed it: cost reaches the status line, not the hook. The
// status line runs on every render, so it records what it is given and the
// hook reads it back. That makes the good source available without a daemon,
// and when it is missing — nobody pasted the statusLine block, or the session
// has not rendered yet — the transcript arithmetic is still there underneath.
//
// Every reading says which of the two it is, and that lands in the receipt. An
// auditor asking "how did you know what this cost" gets an answer instead of
// an assumption.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, FILE_MODE } from '../../core/store.mjs';
import { priceOf } from '../../core/policy.mjs';
import { readUsage } from './usage.mjs';
import { runningHarness } from './harness.mjs';
import { readGrokUsage } from '../grok/usage.mjs';
import { readCodexUsage } from '../codex/usage.mjs';
import { readCursorUsage } from '../cursor/usage.mjs';

export const HARNESS = 'harness';
export const TRANSCRIPT = 'transcript';

// The harness figure is only as good as its last render. A session whose status
// line has not been drawn for a long time is not evidence of current spend, and
// silently trusting a stale number is worse than falling back to arithmetic we
// know is live. Ten minutes is generous for a line that redraws on every turn.
const STALE_MS = 10 * 60 * 1000;

const file = (id) => join(DIR, `cost-${String(id || 'default').replace(/[^\w-]/g, '')}.json`);

/** Called by the status line with what Claude Code handed it. Never throws. */
export function recordHarnessCost(sessionId, cost) {
  const usd = cost && typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null;
  if (usd === null || !Number.isFinite(usd) || usd < 0) return false;
  try {
    writeFileSync(file(sessionId), JSON.stringify({ usd, at: Date.now() }), { mode: FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

/**
 * The harness's own figure for this session, or null when there is not a
 * trustworthy one. Exported because the session-end summary needs the same
 * number the hook uses: a receipt that says $6.34 while the status line says
 * $8.10 is two answers to one question.
 */
export function harnessUsd(sessionId) {
  try {
    const d = JSON.parse(readFileSync(file(sessionId), 'utf8'));
    if (typeof d.usd !== 'number' || !Number.isFinite(d.usd) || d.usd < 0) return null;
    if (Date.now() - (d.at || 0) > STALE_MS) return null;
    return d.usd;
  } catch {
    return null;
  }
}

/**
 * What this session has cost, in the unit the budget is denominated in.
 * @returns {{tokens:number, usd:number|null, model:string, task:string, source:string}}
 */
// Grok Build and Codex run these same hooks, but their transcript_path points
// at their OWN log format, which the Claude Code reader finds nothing in: it
// read $0 from a real Grok session, so a spend limit never tripped there. Each
// harness's log gets its own reader.
const READERS = { 'grok-cli': readGrokUsage, codex: readCodexUsage, cursor: readCursorUsage };
export const usageReader = (harness = runningHarness()) => READERS[harness] || readUsage;

export function read(sessionId, transcriptPath, cfg = {}, harness = runningHarness()) {
  // The transcript pass is not optional even when the harness figure exists:
  // it is where the model and the last prompt come from, and both are needed
  // to price the budget and to say what the agent is working on.
  const { usd: own, ...t } = usageReader(harness)(sessionId, transcriptPath);
  // Grok writes its own price into its log; the status line is Claude Code's.
  const usd = typeof own === 'number' ? own : harnessUsd(sessionId);
  if (usd === null) return { ...t, usd: null, source: TRANSCRIPT };

  // Budgets are effective tokens, so convert at the model that is answering
  // now — the same unit the rest of the policy compares against.
  const perM = priceOf(t.model, cfg.model).in;
  return { ...t, tokens: Math.round((usd * 1e6) / perM), usd, source: HARNESS };
}

// ── the receipt's money field ───────────────────────────────────────────────

/** The control plane refuses a cost outside these bounds (ingest/decode.go). */
// costUsd and COST_MAX moved to core/cost.mjs: the rule is the receipt column's,
// not Claude Code's. Re-exported so existing imports keep working.
export { costUsd, COST_MAX } from '../../core/cost.mjs';
