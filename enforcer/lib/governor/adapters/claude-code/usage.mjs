// What the session has cost so far, read from the transcript.
//
// v1 re-read the WHOLE transcript on every tool call: O(session length), and
// measured at 221ms on a small transcript rising to 299ms on 17MB. The read
// dominated. Here the file is only ever read forward from where the last call
// stopped, so cost is O(what changed) no matter how long the session runs.
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, FILE_MODE } from '../../core/store.mjs';
import { priceOf, rateFor } from '../../core/policy.mjs';
import { emptyUsage } from '../../core/cost.mjs';

const cursorFile = (id) => join(DIR, `cursor-${String(id).replace(/[^\w-]/g, '')}.json`);

// A single API response appears on several transcript lines. Summing every
// line double-counted spend ~2.3x on a long session, which grounded agents at
// well under half the limit the human set -- so each message id counts once.
// The window is bounded because duplicates are always adjacent; an unbounded
// set would grow with the session, which is the thing this file exists to stop.
const SEEN_MAX = 400;

// A web search or fetch is billed per request, $10 per 1000, whatever model
// asked for it.
const SERVER_TOOL_USD = 0.01;

const CURSOR_V = 3;

export function readUsage(sessionId, transcriptPath) {
  const out = { tokens: 0, model: '', task: '', usage: emptyUsage() };
  if (!transcriptPath) return out;

  const cf = cursorFile(sessionId || 'default');
  let cur = { v: 0, path: '', offset: 0, usd: 0, seen: [], model: '', task: '', usage: null };
  try {
    cur = { ...cur, ...JSON.parse(readFileSync(cf, 'utf8')) };
  } catch {}

  let size = 0;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return out;
  }

  // A different transcript, or one that shrank (compaction rewrites it), means
  // the cursor describes a file that no longer exists. Start over rather than
  // read from a meaningless offset. So does a cursor an older reader saved:
  // CURSOR_V names what a cursor's totals mean (2: token counts kept, 3: each
  // model's own cache-read rate), and an older one's totals were kept by
  // rules this reader no longer follows.
  if (cur.path !== transcriptPath || size < cur.offset || cur.v !== CURSOR_V || !cur.usage) {
    cur = { v: CURSOR_V, path: transcriptPath, offset: 0, usd: 0, seen: [], model: '', task: '', usage: emptyUsage() };
  }

  if (size > cur.offset) {
    let chunk = '';
    try {
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.allocUnsafe(size - cur.offset);
      readSync(fd, buf, 0, buf.length, cur.offset);
      closeSync(fd);
      chunk = buf.toString('utf8');
    } catch {
      return out;
    }

    // Only advance past the last complete line, so a half-written line is read
    // again next time rather than dropped.
    const lastNL = chunk.lastIndexOf('\n');
    const complete = lastNL < 0 ? '' : chunk.slice(0, lastNL);
    cur.offset += lastNL < 0 ? 0 : Buffer.byteLength(complete, 'utf8') + 1;

    const seen = new Set(cur.seen);
    for (const line of complete.split('\n')) {
      if (!line.includes('"usage"') && !line.includes('"last-prompt"')) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m?.type === 'last-prompt' && m.lastPrompt) cur.task = m.lastPrompt;
      if (m?.message?.model) cur.model = m.message.model;
      const u = m?.message?.usage;
      if (!u) continue;
      const id = m?.message?.id || m?.requestId;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      // Price each message at the model that ANSWERED it. A session that
      // switched models part-way is a mix, and pricing the whole transcript at
      // whatever is current mis-states it by the ratio between the two.
      // Cache writes are not one price. A 5-minute TTL costs 1.25x input, a
      // 1-hour TTL costs 2x, and usage.cache_creation carries the split. v2
      // weighted every write at 1.25x, so any session on the 1-hour TTL was
      // metered low -- measured at 10.7% under on a real session whose 85,623
      // cache-creation tokens were ALL ephemeral_1h. Fall back to the flat
      // figure only when the breakdown is absent.
      const cc = u.cache_creation || {};
      const h1 = cc.ephemeral_1h_input_tokens || 0;
      const m5 = cc.ephemeral_5m_input_tokens || 0;
      const flat = u.cache_creation_input_tokens || 0;
      const written = h1 || m5 ? h1 + m5 : flat;
      const read = u.cache_read_input_tokens || 0;
      // Output and cache reads at the model's own rates, not a weight shared by
      // every Claude model: the 5.5 family reads cache at 0.05x input, not
      // 0.1x, and a session is mostly cache reads. Haiku 5.5's rate also
      // depends on how long THIS request's prompt was.
      const r = rateFor(m?.message?.model || cur.model, (u.input_tokens || 0) + read + written);
      const write = h1 || m5 ? 2 * h1 + 1.25 * m5 : 1.25 * flat;
      // Server tools bill per request, not per token, and never entered v2's
      // sum at all; the figure is small but it is not zero on a research-heavy run.
      const st = u.server_tool_use || {};
      const calls = (st.web_search_requests || 0) + (st.web_fetch_requests || 0);
      cur.usd += ((u.input_tokens || 0) * r.in + (u.output_tokens || 0) * r.out + write * r.in + read * r.cin) / 1e6 + calls * SERVER_TOOL_USD;
      // The counts as measured, unweighted: what the receipt reports.
      cur.usage.input += u.input_tokens || 0;
      cur.usage.output += u.output_tokens || 0;
      cur.usage.cache_read += read;
      cur.usage.cache_write += written;
    }
    cur.seen = [...seen].slice(-SEEN_MAX);
    try {
      writeFileSync(cf, JSON.stringify(cur), { mode: FILE_MODE });
    } catch {}
  }

  // Back into effective tokens at the model answering NOW -- the unit the
  // budget is denominated in.
  out.model = cur.model;
  out.task = (cur.task || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  out.tokens = Math.round((cur.usd * 1e6) / priceOf(cur.model).in);
  out.usage = { ...cur.usage };
  return out;
}
