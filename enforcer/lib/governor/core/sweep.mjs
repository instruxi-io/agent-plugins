// Per-session scratch files, swept.
//
// Two files are written per session and never removed: `cost-<id>.json` (the
// harness's own total, written by the status line) and `cursor-<id>.json` (how
// far the transcript has been read, plus the running spend). Both are
// per-session by necessity — that is what makes the transcript read O(what
// changed) instead of O(session) — and both stop meaning anything once the
// session is gone. Fifty sessions in, the directory is a hundred files nobody
// reads and nothing deletes.
//
// BY AGE, NOT BY SESSION END. Deleting the current session's files when
// SessionEnd fires is the obvious rule and the wrong one: SessionEnd also fires
// on /clear and on exit, and `--resume` brings the same session id back. The
// cursor is what stops the transcript being re-read from the top, so removing
// it on an exit that turns out to be temporary silently un-does the thing it
// exists for. Age answers the question the session id cannot: nothing has
// touched this file for a week, so no session is still using it.
//
// Re-reading is correct either way — readUsage recomputes the same total from
// offset 0 — so the cost of being wrong here is a slow first tool call, not a
// wrong number. Age keeps even that rare.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DIR } from './store.mjs';

// Only these two. Everything else in the directory is durable state — the
// chain head, the receipts, the shipping watermark, the credential — and a
// sweep that could reach any of them would be a data-loss bug waiting on a
// filename change. Matching a narrow pattern is the whole safety argument.
const SCRATCH = /^(cost|cursor)-[\w-]+\.json$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete per-session scratch files untouched for `sweepDays` days.
 * Never throws: a governor that cannot tidy up must still govern.
 *
 * @param {{sweepDays?: number}} cfg
 * @param {{now?: number, dir?: string}} deps
 * @returns {{removed: number, bytes: number, skipped: number}}
 */
export function sweep(cfg = {}, { now = Date.now(), dir = DIR } = {}) {
  const out = { removed: 0, bytes: 0, skipped: 0 };
  const days = Number(cfg.sweepDays ?? 7);
  // 0 (or anything not a positive number) is off, deliberately: someone who
  // wants every scratch file kept for an audit should be able to say so.
  if (!Number.isFinite(days) || days <= 0) return out;
  const cutoff = now - days * DAY_MS;

  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }

  for (const name of names) {
    if (!SCRATCH.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      // mtime, not birthtime: a resumed session rewrites its cursor, which is
      // exactly the evidence that it is still in use.
      if (st.mtimeMs > cutoff) continue;
      unlinkSync(path);
      out.removed++;
      out.bytes += st.size;
    } catch {
      out.skipped++;
    } // raced with a live session, or not ours to delete
  }
  return out;
}
