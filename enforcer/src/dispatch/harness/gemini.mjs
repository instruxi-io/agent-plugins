// The Gemini CLI worker: `gemini -p -o stream-json` with yolo approvals. No endpoint form (ROUTES.md section 4).
import { isObj } from '../util.mjs';
import { nonClaudeGitRules } from '../git-guard.mjs';
import { knowsModel, readStream, LAND_PR } from './common.mjs';

/** `gemini -p -o stream-json` (0.38) prints one JSON event per line (fixture: test/fixtures/gemini-stream.jsonl):
 *  init{session_id,model}, message{role,content,delta}, tool_use{tool_name,tool_id,parameters},
 *  tool_result{tool_id,status,output?}, result{status,stats{input_tokens,output_tokens,cached,tool_calls}}.
 *  Consecutive assistant `delta` messages are one assistant turn; each tool_use is one more. */
export function* geminiEvents(path) {
  const text = readStream(path);
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

const caps = { supported: true, experimental: true, models: ['gemini', 'auto'], resume: false };

/** @type {import('./index.mjs').HarnessAdapter} */
export default {
  name: 'gemini',
  caps,
  apis: [],
  command(prompt, model, args) {
    // gemini 0.38 headless: -p prompt, -o stream-json (NDJSON, fixture test/fixtures/gemini-stream.jsonl), yolo approves tools.
    const cmd = [args.gemini || process.env.GEMINI_BIN || 'gemini', '-p', prompt, '-o', 'stream-json', '--approval-mode', 'yolo'];
    if (knowsModel(caps, model)) cmd.push('-m', model);
    return cmd;
  },
  plan: () => ({}),
  promptRules: () => nonClaudeGitRules(LAND_PR),
  events: geminiEvents,
};
