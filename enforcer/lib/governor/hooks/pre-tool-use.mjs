// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// Claude Code shim: hook JSON -> common event -> core decision -> Claude's
// permission vocabulary. The decision and its wording live in lib/decide.mjs.
// Fails closed: a throw denies (headless) or asks; bad stdin asks.
import { input, emit, pass, guardPre } from './lib.mjs';
import { decide } from '../lib/decide.mjs';
import { headlessFrom } from '../core/worker.mjs';

const EVENT = 'PreToolUse';
await guardPre(EVENT, async () => {
  const ev = input('PreToolUse');
  if (ev.badStdin || typeof ev.tool_name !== 'string')
    emit(EVENT, {
      permissionDecision: 'ask',
      permissionDecisionReason: 'Enforcer could not read what the AI is about to do, so it asks you to check it yourself. Let it go ahead?',
    });
  const r = await decide(ev);
  try {
    process.stderr.write(r.line + '\n');
  } catch {}
  const top = r.notice ? { systemMessage: r.notice } : {};
  if (r.decision) {
    emit(
      EVENT,
      {
        permissionDecision: r.decision,
        // A person reads the reason in the Allow dialog: plain words only. With
        // nobody there, the dispatcher parses the machine line, so it leads.
        permissionDecisionReason: headlessFrom(process.env) ? r.line + '\n' + r.reason : r.reason,
        ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}),
      },
      top,
    );
  }
  pass(EVENT, top);
});
