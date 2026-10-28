// Cursor shim: node shim.mjs <cursorEvent>   (preToolUse, postToolUse, sessionStart ...)
//
// Cursor's hook payloads differ from Claude Code's in three ways, and its answers
// in a fourth, so this shim translates both directions around the shared core
// (bin/enforcer event <name>):
//   - the session is `conversation_id`; a subagent's events carry
//     `parent_conversation_id` and `subagent_id`, which become session_id and agent_id;
//   - tool names: Shell -> Bash, Delete -> Write, `MCP:<tool>` -> mcp__<server>__<tool>;
//     Read, Write, Grep and Task already match;
//   - postToolUse's `tool_output` is a JSON string, and a failure's text is `error_message`;
//   - answers are flat: preToolUse and subagentStart return {permission, user_message,
//     agent_message}, beforeSubmitPrompt {continue}, stop {followup_message}, not
//     Claude Code's hookSpecificOutput.
// See https://cursor.com/docs/hooks.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalMessage } from '../../src/cursor-once.mjs';

export { approvalMessage };

// Cursor event -> the core's kebab event name and the Claude Code name the governor reads.
export const EVENTS = {
  preToolUse: ['pre-tool-use', 'PreToolUse'],
  postToolUse: ['post-tool-use', 'PostToolUse'],
  postToolUseFailure: ['post-tool-use-failure', 'PostToolUseFailure'],
  sessionStart: ['session-start', 'SessionStart'],
  sessionEnd: ['session-end', 'SessionEnd'],
  beforeSubmitPrompt: ['user-prompt-submit', 'UserPromptSubmit'],
  subagentStart: ['subagent-start', 'SubagentStart'],
  subagentStop: ['subagent-stop', 'SubagentStop'],
  preCompact: ['pre-compact', 'PreCompact'],
  stop: ['stop', 'Stop'],
};
// The hooks that gate an action: Cursor blocks on an answer that does not match their schema,
// so they always get a well-formed one.
const PERMISSION = new Set(['preToolUse', 'subagentStart']);
// The core's time, a little under each hook's timeout in hooks.json.
const CHILD_TIMEOUT_MS = { preToolUse: 25000, sessionStart: 13000, preCompact: 13000 };

const TOOLS = {
  Shell: 'Bash',
  Delete: 'Write',
  Read: 'Read',
  Write: 'Write',
  Grep: 'Grep',
  Task: 'Task',
  Edit: 'Edit',
  StrReplace: 'Edit',
  Glob: 'Glob',
  LS: 'Glob',
};
const PATHS = ['file_path', 'path', 'filePath', 'target_file', 'filename', 'file'];
const parse = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
// An MCP server name as Claude Code spells it in a tool name: `plugin-enforcer-enforcer` -> `plugin_enforcer_enforcer`.
const slug = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');

/** The governor's name for a Cursor tool. */
export function toolName(n, ev = {}) {
  if (typeof n !== 'string') return n;
  if (TOOLS[n]) return TOOLS[n];
  if (n.startsWith('MCP:')) {
    const tool = n.slice(4);
    if (tool.startsWith('mcp__')) return tool;
    // Cursor's matcher names only the tool. A server name, when the payload carries one, keeps
    // the rule key the same as Claude Code's; without one the server is `cursor`.
    const server = ev.mcp_server_name || ev.server_name || ev.server;
    const i = tool.indexOf('__');
    if (!server && i > 0) return `mcp__${tool}`;
    return `mcp__${slug(server || 'cursor')}__${tool}`;
  }
  return n;
}

/** Cursor's payload in the shape the shared core reads. Mutates and returns `ev`. */
export function normalize(ev, cursorEvent = ev.hook_event_name) {
  const spec = EVENTS[cursorEvent];
  if (spec) ev.hook_event_name = spec[1];
  if (ev.cursor_event === undefined && cursorEvent) ev.cursor_event = cursorEvent;
  // A subagent's own events name the parent conversation: its session is the parent's and the
  // subagent is the agent, so the governor's actor key is the same one Claude Code would use.
  const sub = ev.subagent_id || (ev.parent_conversation_id && ev.conversation_id !== ev.parent_conversation_id ? ev.conversation_id : undefined);
  if (ev.parent_conversation_id && sub) {
    ev.session_id = ev.parent_conversation_id;
    if (!ev.agent_id) ev.agent_id = sub;
  } else if (!ev.session_id && ev.conversation_id) ev.session_id = ev.conversation_id;
  if (ev.subagent_type !== undefined && ev.agent_type === undefined) ev.agent_type = ev.subagent_type;
  if (ev.subagent_id !== undefined && cursorEvent === 'subagentStart' && ev.agent_id === undefined) ev.agent_id = ev.subagent_id;
  if (!ev.transcript_path && process.env.CURSOR_TRANSCRIPT_PATH) ev.transcript_path = process.env.CURSOR_TRANSCRIPT_PATH;
  if (!ev.cwd) ev.cwd = (Array.isArray(ev.workspace_roots) && ev.workspace_roots[0]) || process.env.CURSOR_PROJECT_DIR || undefined;
  if (cursorEvent === 'subagentStart' && ev.task !== undefined && ev.prompt === undefined) ev.prompt = ev.task;
  if (cursorEvent === 'stop' || cursorEvent === 'subagentStop') ev.stop_hook_active = (ev.loop_count || 0) > 0;
  if (cursorEvent === 'sessionStart' && ev.source === undefined) ev.source = 'startup';

  const raw = ev.tool_name;
  ev.tool_name = toolName(raw, ev);
  if ('tool_input' in ev) ev.tool_input = parse(ev.tool_input);
  if (ev.tool_response === undefined && ev.tool_output !== undefined) ev.tool_response = parse(ev.tool_output);
  if (cursorEvent === 'postToolUseFailure' && ev.error === undefined && ev.error_message !== undefined) {
    ev.error = ev.error_message;
    if (ev.tool_response === undefined) ev.tool_response = { error: ev.error_message, failure_type: ev.failure_type };
  }
  const ti = ev.tool_input;
  if (isObj(ti)) {
    if (ev.tool_name === 'Bash' && typeof ti.command !== 'string' && typeof ti.cmd === 'string') ti.command = ti.cmd;
    if ((ev.tool_name === 'Write' || ev.tool_name === 'Edit' || ev.tool_name === 'Read') && !ti.file_path) {
      const k = PATHS.find((x) => typeof ti[x] === 'string');
      if (k) ti.file_path = ti[k];
    }
  }
  return ev;
}

const reasonOf = (out) => {
  const hs = isObj(out?.hookSpecificOutput) ? out.hookSpecificOutput : {};
  return [hs.permissionDecisionReason, out?.reason, out?.stopReason].find((x) => typeof x === 'string' && x) || '';
};

/** The core's Claude Code-shaped answer as Cursor's answer for `cursorEvent`; null means print nothing. */
export function toCursor(cursorEvent, out, ev = {}) {
  const hs = isObj(out?.hookSpecificOutput) ? out.hookSpecificOutput : {};
  const sys = typeof out?.systemMessage === 'string' && out.systemMessage ? out.systemMessage : '';
  const ctx = typeof hs.additionalContext === 'string' && hs.additionalContext ? hs.additionalContext : '';
  const why = reasonOf(out);
  const blocked = out?.decision === 'block' || out?.continue === false;
  if (cursorEvent === 'preToolUse' || cursorEvent === 'subagentStart') {
    let permission = hs.permissionDecision === 'deny' || hs.permissionDecision === 'ask' ? hs.permissionDecision : blocked ? 'deny' : 'allow';
    // Cursor does not enforce "ask" on preToolUse (it runs the call) and treats it as deny on
    // subagentStart, so an ask is a deny here, with a reason that says approval is what is missing.
    let msg = [why, sys].filter(Boolean).join('\n');
    let agent = why || msg;
    if (permission === 'ask') {
      permission = 'deny';
      msg = approvalMessage(cursorEvent === 'subagentStart' ? 'this subagent' : (typeof ev.tool_name === 'string' && ev.tool_name) || 'this tool call', why);
      agent = msg;
      if (sys) msg += '\n' + sys;
    }
    const a = { permission };
    if (permission !== 'allow' && msg) {
      a.user_message = msg;
      a.agent_message = agent;
    } else if (sys) a.user_message = sys;
    // A rewritten input only ever rides on an allow: a denied call must not carry one.
    if (cursorEvent === 'preToolUse' && permission === 'allow' && isObj(hs.updatedInput)) a.updated_input = hs.updatedInput;
    return a;
  }
  if (cursorEvent === 'beforeSubmitPrompt') {
    const a = { continue: !blocked };
    if (blocked && (why || sys)) a.user_message = why || sys;
    return a;
  }
  if (cursorEvent === 'stop' || cursorEvent === 'subagentStop') {
    // Claude Code's "block the stop" is Cursor's follow-up message: the agent carries on with it.
    if (blocked && why) return { followup_message: why };
    return out ? {} : null;
  }
  if (cursorEvent === 'postToolUse' || cursorEvent === 'postToolUseFailure') {
    const text = [ctx, sys].filter(Boolean).join('\n');
    return text ? { additional_context: text } : out ? {} : null;
  }
  if (cursorEvent === 'sessionStart') {
    const a = { env: { ENFORCER_HARNESS: 'cursor' } };
    const text = [ctx, sys].filter(Boolean).join('\n');
    if (text) a.additional_context = text;
    return a;
  }
  if (cursorEvent === 'preCompact') return sys || ctx ? { user_message: sys || ctx } : out ? {} : null;
  return out ? {} : null;
}

// Token usage when a payload carries it. Cursor's documented hook payloads carry none today
// (preCompact's context_tokens is the context window, not spend), so this reads the field
// names other harnesses use and records them per generation for the usage reader
// (lib/governor/adapters/cursor/usage.mjs). The exact Cursor field name is unverified.
const USAGE_FIELDS = ['usage', 'token_usage', 'tokenUsage', 'tokens'];
export function payloadUsage(ev) {
  for (const k of USAGE_FIELDS) if (isObj(ev?.[k])) return ev[k];
  const flat = ['input_tokens', 'output_tokens', 'inputTokens', 'outputTokens'].some((k) => typeof ev?.[k] === 'number');
  return flat ? ev : null;
}
export function recordUsage(ev, dir) {
  const u = payloadUsage(ev);
  const sid = ev.session_id;
  if (!u || !sid || !dir) return false;
  const pick = (...ks) => {
    for (const k of ks) if (typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0) return u[k];
    return 0;
  };
  const usage = {
    input: pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'),
    output: pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'),
    cache_read: pick('cache_read_tokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cachedReadTokens'),
    cache_write: pick('cache_write_tokens', 'cacheWriteTokens', 'cache_creation_input_tokens', 'cacheCreationTokens'),
    reasoning: pick('reasoning_tokens', 'reasoningTokens'),
  };
  const usd = pick('cost_usd', 'costUsd', 'total_cost_usd');
  if (!Object.values(usage).some(Boolean) && !usd) return false;
  const f = join(dir, `cursor-usage-${String(sid).replace(/[^\w-]/g, '')}.json`);
  let d = { gens: {} };
  try {
    d = JSON.parse(readFileSync(f, 'utf8'));
    if (!isObj(d.gens)) d = { gens: {} };
  } catch {}
  // One figure per generation, the latest: a payload repeated on every tool call of one
  // generation is then counted once.
  // Without an id, the payload's own figures name it: the same payload seen twice is one entry.
  const gen =
    ev.generation_id ||
    ev.tool_use_id ||
    `h${createHash('sha256')
      .update(JSON.stringify([ev.conversation_id || sid, usage, usd, ev.model_id || ev.model || '']))
      .digest('hex')
      .slice(0, 16)}`;
  d.gens[gen] = { usage, usd: usd || null, model: ev.model_id || ev.model || '' };
  d.at = Date.now();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, JSON.stringify(d), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let [cursorEvent, ...rest] = process.argv.slice(2);
  let ev = {},
    bad = false;
  const raw = (() => {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      bad = true;
      return '';
    }
  })();
  try {
    ev = JSON.parse(raw);
    if (!isObj(ev)) throw 0;
  } catch {
    bad = true;
    ev = {};
  }
  if (!EVENTS[cursorEvent] && EVENTS[ev.hook_event_name]) cursorEvent = ev.hook_event_name;
  const print = (a) => {
    if (a) process.stdout.write(JSON.stringify(a) + '\n');
  };
  // A governor that cannot run must not be an allow. Cursor accepts "ask" on preToolUse but
  // does not enforce it today, so a gate that cannot decide denies.
  const fail = (why) => {
    process.stderr.write(`enforcer-governor: ${why}\n`);
    if (PERMISSION.has(cursorEvent)) {
      const m = `enforcer-governor:governor_error ${why}`;
      print({ permission: 'deny', user_message: m, agent_message: m });
      process.exit(0);
    }
    process.exit(1);
  };
  if (!EVENTS[cursorEvent]) {
    process.stderr.write(`usage: shim.mjs <${Object.keys(EVENTS).join('|')}>\n`);
    process.exit(PERMISSION.has(ev.hook_event_name) ? 2 : 1);
  }
  if (bad && PERMISSION.has(cursorEvent)) fail('unreadable or empty hook input');
  normalize(ev, cursorEvent);
  process.env.ENFORCER_HARNESS = 'cursor';
  try {
    const { DIR } = await import('../../lib/governor/core/store.mjs');
    recordUsage(ev, DIR);
  } catch {}
  const r = spawnSync(process.execPath, [join(root, 'bin', 'enforcer'), 'event', EVENTS[cursorEvent][0], ...rest], {
    input: JSON.stringify(ev),
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
    // Under Cursor's own hook timeout (hooks.json), so a stuck governor is this shim's deny, not Cursor's default.
    timeout: CHILD_TIMEOUT_MS[cursorEvent] || 8000,
  });
  if (r.status === null || r.error) fail(`hook child did not run to completion (${r.error?.message || r.signal})`);
  let out = null;
  const text = String(r.stdout || '').trim();
  if (text) {
    try {
      out = JSON.parse(text.split('\n').filter(Boolean).pop());
    } catch {
      if (PERMISSION.has(cursorEvent)) fail('governor answer was not JSON');
    }
  }
  if (r.status !== 0 && PERMISSION.has(cursorEvent) && !out) fail(`hook child exited ${r.status}`);
  print(toCursor(cursorEvent, out, ev));
  process.exit(PERMISSION.has(cursorEvent) ? 0 : r.status);
}
