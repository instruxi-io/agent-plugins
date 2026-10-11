// Worker stream parsers: claude / grok NDJSON-or-JSON into the Claude-shaped events summarize reads.
import { readFileSync } from 'node:fs';
import { isObj } from './util.mjs';

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function* claudeEvents(path) {
  const text = read(path);
  if (text === null) return;
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObj(e)) {
      if (!isObj(e.message)) e.message = {};
      yield e;
    }
  }
}

/** `grok -p --output-format streaming-messages-json` prints Claude-shaped NDJSON; the older
 *  `--output-format json` single object (no "type" key) is read here. */
export function* grokEvents(path) {
  const text = read(path);
  if (text === null) return;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    yield* claudeEvents(path);
    return;
  }
  if (!isObj(o)) return;
  if ('type' in o) {
    yield* claudeEvents(path);
    return;
  }
  const sid = o.sessionId;
  yield { type: 'system', subtype: 'init', session_id: sid, message: {} };
  const n = o.num_turns || 0;
  for (let i = 0; i < (typeof n === 'number' ? Math.trunc(n) : 0); i++) {
    yield { type: 'assistant', message: { content: [] } };
  }
  const ok = o.stopReason === 'end_turn';
  yield {
    type: 'result',
    subtype: ok ? 'success' : 'error_' + String(o.stopReason),
    result: o.text,
    usage: o.usage,
    num_turns: n,
    session_id: sid,
    total_cost_usd: o.total_cost_usd,
    message: {},
  };
}

export function codexEvents() {
  throw new Error('codex stream parser: no fixture (no real `codex exec --json` sample ' + 'is recorded); refusing to guess the schema');
}

export const HARNESS_PARSERS = { grok: grokEvents, codex: codexEvents };

export function* events(path, harness = 'claude') {
  if (harness !== 'claude') {
    yield* HARNESS_PARSERS[harness](path);
    return;
  }
  yield* claudeEvents(path);
}

export function countTurns(path, harness = 'claude') {
  let n = 0;
  for (const e of events(path, harness)) if (e.type === 'assistant') n++;
  return n;
}

/** Count the compact_boundary events (auto-compaction) in a claude worker's stream. */
export function countCompactions(path) {
  let n = 0;
  for (const e of claudeEvents(path)) if (e.type === 'system' && e.subtype === 'compact_boundary') n++;
  return n;
}
