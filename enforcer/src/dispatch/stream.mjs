// Worker stream parsers: claude / grok / codex / gemini NDJSON-or-JSON into the Claude-shaped events summarize reads.
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

/** `gemini -p -o stream-json` (0.38) prints one JSON event per line (fixture: test/fixtures/gemini-stream.jsonl):
 *  init{session_id,model}, message{role,content,delta}, tool_use{tool_name,tool_id,parameters},
 *  tool_result{tool_id,status,output?}, result{status,stats{input_tokens,output_tokens,cached,tool_calls}}.
 *  Consecutive assistant `delta` messages are one assistant turn; each tool_use is one more. */
export function* geminiEvents(path) {
  const text = read(path);
  if (text === null) return;
  let sid = null;
  let turns = 0;
  let buf = null;
  const flush = function* () {
    if (buf === null) return;
    turns++;
    yield { type: 'assistant', message: { content: [{ type: 'text', text: buf }] } };
    buf = null;
  };
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    if (e.type === 'message' && e.role === 'assistant') {
      buf = (buf ?? '') + String(e.content ?? '');
      continue;
    }
    yield* flush();
    if (e.type === 'init') {
      sid = typeof e.session_id === 'string' ? e.session_id : null;
      yield { type: 'system', subtype: 'init', session_id: sid, model: e.model, message: {} };
    } else if (e.type === 'tool_use') {
      turns++;
      const name = e.tool_name === 'run_shell_command' ? 'Bash' : String(e.tool_name ?? '');
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: e.tool_id, name, input: isObj(e.parameters) ? e.parameters : {} }] } };
    } else if (e.type === 'tool_result') {
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: e.tool_id, is_error: e.status !== 'success', content: String(e.output ?? '') }] },
      };
    } else if (e.type === 'result') {
      const st = isObj(e.stats) ? e.stats : {};
      const ok = e.status === 'success';
      yield {
        type: 'result',
        subtype: ok ? 'success' : 'error_' + String(e.status),
        is_error: !ok,
        num_turns: turns,
        session_id: sid,
        usage: { input_tokens: st.input_tokens, output_tokens: st.output_tokens, cache_read_input_tokens: st.cached },
        message: {},
      };
    }
  }
  yield* flush();
}

export const HARNESS_PARSERS = { grok: grokEvents, codex: codexEvents, gemini: geminiEvents };

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
