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

/** `codex exec --json` prints one JSON event per line (fixture: test/fixtures/codex-exec.jsonl):
 *  thread.started{thread_id}, turn.started, item.started|completed{item:{id,type,...}}, turn.completed{usage}.
 *  Item types read: agent_message{text}, command_execution{command,aggregated_output,exit_code,status}.
 *  Anything else (including `error` items, which the fixture shows as warnings) is ignored. */
export function* codexEvents(path) {
  const text = read(path);
  if (text === null) return;
  let sid = null;
  let turns = 0;
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    const item = isObj(e.item) ? e.item : {};
    if (e.type === 'thread.started') {
      sid = typeof e.thread_id === 'string' ? e.thread_id : null;
      yield { type: 'system', subtype: 'init', session_id: sid, message: {} };
    } else if (e.type === 'item.completed' && item.type === 'agent_message') {
      turns++;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: String(item.text ?? '') }] } };
    } else if (e.type === 'item.completed' && item.type === 'command_execution') {
      turns++;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command } }] } };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: item.exit_code !== 0, content: String(item.aggregated_output ?? '') }] },
      };
    } else if (e.type === 'turn.completed') {
      const u = isObj(e.usage) ? e.usage : {};
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: turns,
        session_id: sid,
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens },
        message: {},
      };
    }
  }
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
