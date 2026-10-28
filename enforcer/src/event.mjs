// One hook process per event: `enforcer event <name>` runs the governor's decision and the graph
// handlers in this process and prints ONE merged JSON answer. The graph handlers run only when a graph
// context is live (a run file for the actor, GRAPH_ID, or a project graph config).
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateBase } from './state.mjs';
import { logHook, noteFailure } from './graph/hooklog.mjs';
import { loadRun } from './graph/run.mjs';
import { LEGACY_PROJECT_CONFIG } from '../hooks/claude/paths.mjs';
import { cursorPayload, onceKey, once, approvalMessage } from './cursor-once.mjs';

// Cursor runs a preToolUse "ask" (it does not enforce one) and refuses a subagentStart ask, so under
// Cursor the core's ask is a deny that says approval is what is missing.
export function cursorAsk(event, out, ev = {}) {
  const hs = out?.hookSpecificOutput;
  if (!isObj(hs) || hs.permissionDecision !== 'ask' || (event !== 'PreToolUse' && event !== 'SubagentStart')) return out;
  const what = event === 'SubagentStart' ? 'this subagent' : (typeof ev.tool_name === 'string' && ev.tool_name) || 'this tool call';
  const reason = approvalMessage(what, hs.permissionDecisionReason);
  const { updatedInput, ...rest } = hs;
  return { ...out, hookSpecificOutput: { ...rest, permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export const GRAPH_TOOL = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_/;
const PRE_GRAPH = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_(next_work|report|remember|heartbeat)$/;
const POST_GRAPH = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_(next_work|report|heartbeat)$/;

// The actor key: sha256("agent_id:<id>")[:32] for a subagent, else session_id.
export function actorKey(ev) {
  if (ev.agent_id) return process.getBuiltinModule('node:crypto').createHash('sha256').update(`agent_id:${ev.agent_id}`).digest('hex').slice(0, 32);
  return ev.session_id || 'unknown';
}

export function graphContextLive(ev) {
  if (process.env.GRAPH_ID) return true;
  // graph_* tool handlers (track-run, attach-evidence, open-run-guard) create or need the run: never gate them
  if (GRAPH_TOOL.test(ev.tool_name || '')) return true;
  const sid = ev.session_id;
  const data = stateBase();
  if (existsSync(join(data, 'runs', `${actorKey(ev)}.json`))) return true;
  if (sid && existsSync(join(data, 'runs', `${sid}.live`))) return true;
  if (sid && existsSync(join(data, 'runs', `${sid}.json`))) return true;
  let d = ev.cwd || process.cwd();
  for (;;) {
    if (existsSync(join(d, '.enforcer', 'graph.json')) || existsSync(join(d, LEGACY_PROJECT_CONFIG))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

// event -> { gov: governor shim, budget: ms for the graph handlers }
const EVENTS = {
  PreToolUse: { gov: 'pre-tool-use.mjs', budget: 28000 },
  PostToolUse: { gov: 'post-tool-use.mjs', budget: 4500 },
  PostToolUseFailure: { budget: 4500 },
  SessionStart: { gov: 'session.mjs', budget: 9000 },
  SessionEnd: { gov: 'session.mjs', budget: 4500 },
  UserPromptSubmit: { gov: 'user-prompt-submit.mjs' },
  SubagentStart: { gov: 'subagent.mjs' },
  PreCompact: { budget: 9000 },
  SubagentStop: { budget: 4500 },
  Stop: { budget: 4500 },
};
const NAMES = Object.fromEntries(Object.keys(EVENTS).map((k) => [k.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), k]));
export const EVENT_NAMES = Object.keys(NAMES);

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const JOIN = new Set(['additionalContext', 'systemMessage', 'reason']);
// Merge two hook answers: text channels join, a stricter permission decision wins, the rest layer.
export function merge(a, b) {
  if (!isObj(a)) return b;
  if (!isObj(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'permissionDecision') {
      const rank = { allow: 1, defer: 1, ask: 2, deny: 3 };
      if ((rank[v] || 0) > (rank[a[k]] || 0)) out[k] = v;
    } else if (JOIN.has(k) && typeof v === 'string' && typeof a[k] === 'string') out[k] = `${a[k]}\n${v}`;
    else if (isObj(v) && isObj(a[k])) out[k] = merge(a[k], v);
    else out[k] = v;
  }
  return out;
}

async function governor(file, raw) {
  const st = (globalThis.__enforcerEvent = { input: raw, out: '' });
  const { HookExit } = await import('../lib/governor/hooks/lib.mjs');
  try {
    await import(`../lib/governor/hooks/${file}`);
  } catch (e) {
    if (!(e instanceof HookExit)) {
      try {
        process.stderr.write(`enforcer: governor hook failed: ${e?.message || e}\n`);
      } catch {}
    }
  }
  globalThis.__enforcerEvent = undefined;
  try {
    return st.out ? JSON.parse(st.out) : null;
  } catch {
    return null;
  }
}

// Every graph handler runs in this process.
const NATIVE = {
  track_run: ['track-run', 'trackRun'],
  capture_evidence: ['capture', 'captureEvidence'],
  heartbeat: ['heartbeat', 'heartbeat'],
  attach_evidence: ['attach', 'attachEvidence'],
  session_start: ['session', 'sessionStart'],
  start_ticker: ['ticker', 'startTicker'],
  stop_ticker: ['ticker', 'stopTicker'],
  remember_on_compact: ['session', 'rememberOnCompact'],
  open_run_guard: ['session', 'openRunGuard'],
};
/** The run id for a hook log line: the live run of this actor's session, else the environment's. */
const runOf = (ev) => {
  try {
    return loadRun(actorKey(ev))?.run_id || undefined;
  } catch {
    return undefined;
  }
};
/** One deadline for the whole hook, taken at entry: the governor half and the graph half share it (a hook the harness kills
 *  at its timeout drops all of its output). */
export const hookDeadline = (event, t0 = Date.now()) => t0 + (EVENTS[event]?.budget || 5000);
export async function native(handlers, ev, deadline) {
  let out = null;
  for (const h of handlers) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer;
    const t0 = Date.now();
    let outcome = 'ok';
    try {
      const mod = await import(`./graph/hooks/${NATIVE[h][0]}.mjs`);
      const r = await Promise.race([
        h === 'attach_evidence' ? mod[NATIVE[h][1]](ev, { deadline }) : mod[NATIVE[h][1]](ev),
        new Promise((res) => {
          timer = setTimeout(() => res(null), left);
        }),
      ]);
      if (r) out = merge(out, r);
    } catch {
      outcome = 'error';
      const note = noteFailure(ev.session_id, h);
      if (note) out = merge(out, { systemMessage: note });
    } finally {
      clearTimeout(timer);
      logHook({
        hook: h,
        event: ev.hook_event_name || '',
        actor: actorKey(ev),
        outcome,
        ms: Date.now() - t0,
        code: outcome === 'ok' ? 0 : 1,
        run_id: runOf(ev),
      });
    }
  }
  return { out, code: 0 };
}

export async function runEvent(name, opts = {}) {
  const event = NAMES[name];
  if (!event) {
    process.stderr.write(`usage: enforcer event <${EXIT_NAMES()}>\n`);
    return 2;
  }
  const spec = EVENTS[event];
  const deadline = hookDeadline(event);
  const govRun = opts.governorFn || governor;
  const nativeRun = opts.nativeFn || native;
  let raw = '';
  try {
    raw = typeof opts.input === 'string' ? opts.input : readFileSync(0, 'utf8');
  } catch {}
  let ev = {};
  try {
    ev = JSON.parse(raw || '{}') || {};
  } catch {}
  if (!isObj(ev)) ev = {};
  // Cursor: its own payload, through the shim or through the Claude Code hooks Cursor imports.
  // Both are read the same way, as one Cursor event, and decided once (cursor-once.mjs).
  const cursor = !opts.notCursor && cursorPayload(ev);
  let onceK = null;
  if (cursor) {
    const { normalize, EVENTS: CURSOR_EVENTS } = await import('../hooks/cursor/shim.mjs');
    if (typeof ev.cursor_event !== 'string') {
      // Not through the shim: Cursor ran the Claude Code hook itself. Read it as the shim would.
      const ce = CURSOR_EVENTS[ev.hook_event_name] ? ev.hook_event_name : Object.keys(CURSOR_EVENTS).find((k) => CURSOR_EVENTS[k][1] === event);
      normalize(ev, ce);
      raw = JSON.stringify(ev);
    }
    process.env.ENFORCER_HARNESS = 'cursor';
    onceK = onceKey(`${event}${opts.graphOnly ? ':graph' : ''}${opts.only ? `:${opts.only}` : ''}`, ev);
  }
  const decide = async () => {
    let out = null;
    // The harness names the event itself; a shim routed an event it does not own stays silent.
    if (spec.gov && !opts.graphOnly) out = await govRun(spec.gov, raw);
    const denied = out?.hookSpecificOutput?.permissionDecision === 'deny';
    let handlers = [];
    const tool = ev.tool_name || '';
    if (event === 'PreToolUse' && PRE_GRAPH.test(tool)) handlers = ['attach_evidence'];
    else if (event === 'PreToolUse' && tool === 'Bash') handlers = ['start_ticker'];
    else if (event === 'PostToolUse') handlers = [...(POST_GRAPH.test(tool) ? ['track_run'] : []), 'stop_ticker', 'capture_evidence', 'heartbeat'];
    else if (event === 'PostToolUseFailure') handlers = ['stop_ticker', 'capture_evidence', 'heartbeat'];
    else if (event === 'SessionEnd') handlers = ['stop_ticker'];
    else if (event === 'SessionStart' && (!ev.source || /^(startup|resume|compact|clear)$/.test(ev.source))) handlers = ['session_start'];
    else if (event === 'PreCompact') handlers = ['remember_on_compact'];
    else if (event === 'Stop' || event === 'SubagentStop') handlers = ['stop_ticker', 'open_run_guard'];
    if (opts.only) handlers = handlers.filter((h) => h === opts.only);
    if (denied) handlers = [];
    let code = 0;
    if (handlers.length && (event === 'SessionStart' || graphContextLive(ev))) {
      // session-start notices print with or without a graph
      const r = await nativeRun(handlers, ev, deadline);
      out = merge(out, r.out);
      code = r.code;
    }
    if (cursor && out) out = cursorAsk(event, out, ev);
    return { out, code };
  };
  let out, code;
  if (onceK) {
    const { DIR } = await import('../lib/governor/core/store.mjs');
    ({ out, code } = await once(onceK, opts.onceDir || DIR, decide));
  } else ({ out, code } = await decide());
  if (out) (opts.write || ((t) => process.stdout.write(t)))(JSON.stringify(out) + '\n');
  return code;
}
const EXIT_NAMES = () => EVENT_NAMES.join('|');
