// Read a harness's JSONL session log forward from where the last call stopped.
//
// The same discipline as the Claude Code reader (usage.mjs): a hook fires on
// every tool call, so re-reading the whole log each time is O(session length).
// A cursor file remembers the byte offset and whatever running totals the
// caller folds, so each call costs O(what changed).
//
// The cursor file is named `cursor-<key>.json`, which is the pattern the daily
// sweep (core/sweep.mjs) already ages out.
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, FILE_MODE } from '../core/store.mjs';

const cursorFile = (key) => join(DIR, `cursor-${String(key).replace(/[^\w-]/g, '')}.json`);

// Duplicates are adjacent, so a bounded window is enough to drop a replayed
// line without growing with the session.
const SEEN_MAX = 400;

/**
 * Fold every new complete line of `path` into the cursor `fresh()` describes.
 * `fold(cur, line, seen)` gets each parsed line; `seen` is a Set it may use to
 * skip an id it has already counted. Returns the cursor, or null when the log
 * cannot be read at all.
 */
export function readForward(key, path, fresh, fold) {
  if (!path) return null;
  const cf = cursorFile(key);
  let cur = { ...fresh(), path: '', offset: 0, seen: [] };
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(cf, 'utf8'));
  } catch {}
  // A cursor saved by an older reader lacks a running total this one keeps:
  // its offset is past lines whose share it never counted, so it is no cursor.
  if (saved && Object.keys(fresh()).every((k) => k in saved)) cur = { ...cur, ...saved };

  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  // A different log, or one that shrank, means the cursor describes a file
  // that no longer exists: start over rather than read from a meaningless
  // offset.
  if (cur.path !== path || size < cur.offset) cur = { ...fresh(), path, offset: 0, seen: [] };

  if (size > cur.offset) {
    let chunk = '';
    try {
      const fd = openSync(path, 'r');
      const buf = Buffer.allocUnsafe(size - cur.offset);
      readSync(fd, buf, 0, buf.length, cur.offset);
      closeSync(fd);
      chunk = buf.toString('utf8');
    } catch {
      return cur;
    }

    // Only advance past the last complete line, so a half-written line is read
    // again next time rather than dropped.
    const lastNL = chunk.lastIndexOf('\n');
    const complete = lastNL < 0 ? '' : chunk.slice(0, lastNL);
    cur.offset += lastNL < 0 ? 0 : Buffer.byteLength(complete, 'utf8') + 1;

    const seen = new Set(cur.seen);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      fold(cur, m, seen);
    }
    cur.seen = [...seen].slice(-SEEN_MAX);
    try {
      writeFileSync(cf, JSON.stringify(cur), { mode: FILE_MODE });
    } catch {}
  }
  return cur;
}

/** A whole, non-negative count; anything else is 0. */
export const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The prompt as the status line shows it: one line, at most 140 characters. */
export const taskLine = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
