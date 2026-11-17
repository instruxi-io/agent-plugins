// The Grok CLI worker: `grok -p` with Claude-shaped streaming output. No endpoint form (ROUTES.md section 4).
import { isObj } from '../util.mjs';
import { nonClaudeGitRules } from '../git-guard.mjs';
import { knowsModel, readStream, LAND_PR } from './common.mjs';
import { claudeEvents } from './claude.mjs';

/** `grok -p --output-format streaming-messages-json` prints Claude-shaped NDJSON; the older
 *  `--output-format json` single object (no "type" key) is read here. */
export function* grokEvents(path) {
  const text = readStream(path);
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

const caps = { supported: true, experimental: true, models: ['grok'], resume: false };

/** @type {import('./index.mjs').HarnessAdapter} */
export default {
  name: 'grok',
  caps,
  apis: [],
  command(prompt, model, args) {
    const cmd = [args.grok || process.env.GROK_BIN || 'grok', '-p', prompt, '--output-format', 'streaming-messages-json'];
    if (knowsModel(caps, model)) cmd.push('--model', model);
    return cmd;
  },
  // Grok imports Claude Code's enabled plugins, and expands their hooks' ${CLAUDE_PLUGIN_ROOT} from the environment: with ours set, jev-hooks'
  // UserPromptSubmit gate ran enforcer's path, failed, and blocked the first prompt (every grok worker ended `cancelled` at 0 turns).
  // Grok's own enforcer plugin does not read it (ENFORCER_PLUGIN_ROOT stays), so a grok worker gets none.
  env(out) {
    delete out.CLAUDE_PLUGIN_ROOT;
    return out;
  },
  plan: () => ({}),
  promptRules: () => nonClaudeGitRules(LAND_PR),
  events: grokEvents,
};
