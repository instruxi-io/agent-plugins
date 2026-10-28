// One decision per Cursor event, however many hooks fire for it.
//
// Under Cursor the same tool call can reach `enforcer event` up to three times: the enforcer
// Cursor plugin's hooks, a hooks.json written by `enforcer harness install cursor` (user or
// repo), and the Claude Code hooks Cursor imports when "third-party plugins" is on. Each would
// meter the call and write its own receipt. The first invocation claims a marker named for the
// event (O_EXCL, so exactly one wins) and records its answer there; any other invocation for the
// same event waits for that answer and prints it, without running the governor again.
import { openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Cursor's camelCase event names, which a Claude Code payload never carries.
const CURSOR_EVENTS = new Set([
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'stop',
]);

/** A payload Cursor sent: its own fields, or the shim's ENFORCER_HARNESS=cursor. */
export function cursorPayload(ev, env = process.env) {
  if (env.ENFORCER_HARNESS === 'cursor') return true;
  if (!ev || typeof ev !== 'object') return false;
  if (typeof ev.cursor_version === 'string' || typeof ev.cursor_event === 'string') return true;
  if (typeof ev.conversation_id === 'string' && typeof ev.generation_id === 'string') return true;
  return CURSOR_EVENTS.has(ev.hook_event_name);
}

// A call with an id is that id (and its content) for a minute; one without is its content for a few
// seconds, so two identical id-less calls a while apart are still two calls.
export const ID_TTL_MS = 60_000;
export const CONTENT_TTL_MS = 10_000;

const h = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

/**
 * The idempotency key for one Cursor event, from the NORMALIZED payload (shim.mjs normalize), or
 * null when there is nothing to key it on. `event` is the Claude Code event name.
 */
export function onceKey(event, ev) {
  const session = ev?.session_id || ev?.conversation_id;
  if (!event || !session) return null;
  const id = ev.tool_use_id || ev.generation_id || '';
  // The content rides along even with an id: an answer is only ever echoed for the same call.
  const content = h([ev.tool_name ?? null, ev.tool_input ?? null, ev.prompt ?? null, ev.source ?? null, ev.loop_count ?? null]);
  return {
    key: h([String(session), ev.agent_id || '', event, String(id), content]).slice(0, 40),
    ttl: id ? ID_TTL_MS : CONTENT_TTL_MS,
  };
}

/** What a user sees when the governor wanted to ask: Cursor has no ask, so the call was refused. */
export function approvalMessage(what, why = '') {
  const r = String(why || '').replace(/[.\s]+$/, '');
  return `Enforcer needs approval for ${what}${r ? `: ${r}` : ''}. Cursor cannot ask for it here, so it was blocked; approve it in the Enforcer console or adjust the policy, then retry.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sweep(d, now) {
  try {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      try {
        if (now - statSync(f).mtimeMs > 10 * ID_TTL_MS) unlinkSync(f);
      } catch {}
    }
  } catch {}
}

/**
 * Run `run` (async () => {out, code}) once per key. A repeat returns the first answer with
 * `repeat: true`. A repeat that cannot get the first answer in `waitMs` runs `run` itself: a
 * second count beats an unanswered gate.
 */
export async function once(k, dir, run, { waitMs = 20_000, now = Date.now } = {}) {
  if (!k || !dir) return { ...(await run()), repeat: false };
  const d = join(dir, 'cursor-once');
  const f = join(d, `${k.key}.json`);
  let fd = null;
  try {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  } catch {}
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try {
      fd = openSync(f, 'wx', 0o600);
    } catch (e) {
      if (e?.code !== 'EEXIST') return { ...(await run()), repeat: false };
      let age = Infinity;
      try {
        age = now() - statSync(f).mtimeMs;
      } catch {
        continue; // removed between the two calls: claim again
      }
      if (age <= k.ttl) break;
      try {
        unlinkSync(f); // an old marker is a different call
      } catch {}
    }
  }
  if (fd !== null) {
    if (Math.random() < 0.05) sweep(d, now());
    let r;
    try {
      r = await run();
    } catch (e) {
      try {
        closeSync(fd);
        unlinkSync(f);
      } catch {}
      throw e;
    }
    try {
      writeSync(fd, JSON.stringify({ done: true, out: r.out ?? null, code: r.code ?? 0 }));
      closeSync(fd);
    } catch {}
    return { ...r, repeat: false };
  }
  const until = now() + waitMs;
  for (;;) {
    try {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      if (m?.done) return { out: m.out ?? null, code: m.code ?? 0, repeat: true };
    } catch {}
    if (now() >= until) return { ...(await run()), repeat: false };
    await sleep(25);
  }
}
