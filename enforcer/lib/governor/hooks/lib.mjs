// Shared plumbing for every hook in this plugin.
//
// The contract that actually works: exit 0 and print JSON. Never exit 2 with
// JSON -- that combination is ignored.
import { readFileSync } from 'node:fs';
import { headlessFrom } from '../core/worker.mjs';

// In-process mode (bin/enforcer event): the runner sets globalThis.__enforcerEvent = { input, out }
// and imports a shim. Where a shim would write JSON and exit, it records the JSON and throws
// HookExit instead, so one node process can run the governor and the graph handlers and merge them.
export class HookExit extends Error {}
function exit0() {
  if (globalThis.__enforcerEvent) throw new HookExit('exit');
  process.exit(0);
}
const rethrowExit = (e) => {
  if (e instanceof HookExit) throw e;
};

// Codex names its tools apply_patch and shell (command may be an argv array).
// Map them to Edit and Bash so the Edit/Write and Bash rules match.
export function codexNormalize(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.tool_name !== 'string') return ev;
  const ti = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : null;
  if (ev.tool_name === 'apply_patch') {
    ev.tool_name = 'Edit';
    const text = ti ? String(ti.command ?? ti.input ?? ti.patch ?? '') : String(ev.tool_input ?? '');
    const m = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
    ev.tool_input = { ...(ti || {}), ...(ti?.file_path || !m ? {} : { file_path: m[1].trim() }) };
  } else if (ev.tool_name === 'shell' || ev.tool_name === 'local_shell') {
    ev.tool_name = 'Bash';
    const c = ti?.command;
    if (Array.isArray(c)) {
      const a = c.map(String);
      const wrapped = a.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]) && /^-\w*c$/.test(a[1]);
      ev.tool_input = { ...ti, command: wrapped ? a.slice(2).join(' ') : a.join(' ') };
    }
  }
  return ev;
}

// `allowed` names the events this hook answers. A harness may route others here
// (Codex also sends PermissionRequest, PostCompact, Interrupt): those are not
// ours, so the only right answer is nothing at all, exit 0.
export function input(...allowed) {
  let ev = {};
  try {
    const raw = globalThis.__enforcerEvent ? globalThis.__enforcerEvent.input : readFileSync(0, 'utf8');
    ev = raw.trim() ? JSON.parse(raw) : {};
    if (!raw.trim()) Object.defineProperty(ev, 'badStdin', { value: true });
  } catch {
    ev = /** @type {any} */ ({});
    Object.defineProperty(ev, 'badStdin', { value: true });
    return ev;
  }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    ev = /** @type {any} */ ({});
    Object.defineProperty(ev, 'badStdin', { value: true });
    return ev;
  }
  if (allowed.length && ev && typeof ev.hook_event_name === 'string' && !allowed.includes(ev.hook_event_name)) exit0();
  return codexNormalize(ev);
}

// `top` carries the universal fields -- systemMessage above all. They belong
// at the top level of the JSON, not inside hookSpecificOutput; nested there,
// Claude Code never showed them.
export function emit(eventName, out, top = {}) {
  const json = JSON.stringify({ ...top, hookSpecificOutput: { hookEventName: eventName, ...out } });
  if (globalThis.__enforcerEvent) globalThis.__enforcerEvent.out = json;
  else process.stdout.write(json);
  exit0();
}

// No objection: say nothing. A PreToolUse hook that returns no
// permissionDecision hands the call to the user's own permission flow -- their
// /permissions rules, their mode, their prompts -- exactly as if this plugin
// were not installed. That is what failing open, and passing ordinary work,
// have to mean.
//
// Not `allow`: that is an affirmative grant that skips the prompt the user
// would otherwise have seen. And not `defer`, which is what this used to send.
// `defer` is not "no opinion" -- it is Claude Code's pause-and-resume signal
// for `claude -p` hosts. Interactive sessions ignore it with a warning (so it
// looked fine), but a headless run stops at the tool call and exits
// `tool_deferred`, and its reason and updatedInput are discarded everywhere.
export const pass = (event, top = {}) => emit(event, {}, top);

// Events with no hookSpecificOutput schema (SessionEnd, SubagentStop): Claude
// Code rejects any JSON naming them, so the only valid answer is none at all.
export function done() {
  exit0();
}

// What Claude Code's hook JSON MEANS -- the tool map, the match text, the agent
// id, the billing mode -- is in adapters/claude-code/events.mjs. This file is
// only the stdin/stdout contract.

// What a hook does when it cannot decide. failMode (config) is `ask` or `deny`;
// unset, a headless run (no one to ask) denies and a person is asked. Never
// "allow": a hook that throws exits 1, which Claude Code treats as non-blocking.
// Loaded lazily: importing the store hardens the whole governor dir, which the hot path should not pay for.
export async function failDecision() {
  let mode;
  try {
    mode = (await import('../src/store.mjs')).loadConfig().failMode;
  } catch {}
  if (mode === 'ask' || mode === 'deny') return mode;
  return headlessFrom(process.env) ? 'deny' : 'ask';
}

// PreToolUse entry: any throw becomes a deny (headless) or ask, never a pass.
export async function guardPre(event, fn) {
  try {
    await fn();
  } catch (e) {
    rethrowExit(e);
    let msg = '';
    try {
      msg = String(e?.message || e).slice(0, 300);
    } catch {}
    try {
      process.stderr.write(`enforcer-governor: governor_error: ${msg}\n`);
    } catch {}
    const decision = await failDecision();
    emit(event, {
      permissionDecision: decision,
      // An ask is read by a person: plain words. A deny goes to an unattended
      // session, whose parent parses the code on the first line.
      permissionDecisionReason:
        decision === 'ask'
          ? 'Enforcer hit a problem while checking this action, so it asks you to check it yourself. Let it go ahead?'
          : `enforcer-governor:governor_error ${msg}\nThe governor failed while checking this action, so it is not allowed to proceed unchecked.`,
    });
  }
}

// Every other entry: a failure here decides nothing, so report it and exit 0.
export async function guard(fn) {
  try {
    await fn();
  } catch (e) {
    rethrowExit(e);
    try {
      process.stderr.write(`enforcer-governor: hook error: ${String(e?.message || e).slice(0, 300)}\n`);
    } catch {}
    exit0();
  }
}
