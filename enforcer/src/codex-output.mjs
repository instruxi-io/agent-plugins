// Codex's hook output contract (codex-cli 0.164.0, openai/codex tag rust-v0.164.0, codex-rs/hooks).
//
// Codex parses a hook's stdout into one wire struct per event, every one `#[serde(deny_unknown_fields)]`
// (codex-rs/hooks/src/schema.rs). A key it does not know anywhere in the object -- Claude Code's
// `hookSpecificOutput.env`, a `hookSpecificOutput` on Stop -- fails the parse, and JSON-looking stdout that
// fails the parse marks the run Failed and drops everything in it (events/session_start.rs:288,
// events/pre_tool_use.rs:254, the same in every event). Empty stdout is a clean Completed.
//
// So under `--harness codex` the one merged answer is cut down to what Codex accepts for that event:
//   every event   continue, stopReason, suppressOutput, systemMessage           (HookUniversalOutputWire)
//   PreToolUse    + decision, reason, hookSpecificOutput{permissionDecision, permissionDecisionReason,
//                   updatedInput, additionalContext}
//   PostToolUse   + decision, reason, hookSpecificOutput{additionalContext}
//   UserPromptSubmit + decision, reason, hookSpecificOutput{additionalContext}
//   SessionStart, SubagentStart + hookSpecificOutput{additionalContext}
//   Stop, SubagentStop + decision, reason          (no hookSpecificOutput at all)
//   PreCompact    universal only
//   SessionEnd    stdout is not read (events/session_end.rs) -- nothing is printed
// and hookSpecificOutput always carries the event's own hookEventName (a required field).
//
// PreToolUse has semantic rules on top (engine/output_parser.rs, unsupported_pre_tool_use_*), each a
// Failed run that lets the tool go ahead:
//   - permissionDecision "ask" is unsupported. The governor's ask becomes a deny that says approval is
//     what is missing (as under Cursor): failing it would run the call unasked.
//   - permissionDecision "allow" is accepted only WITH updatedInput, and updatedInput only WITH "allow".
//     In Codex "allow" + updatedInput means "run it with this input" -- the call still goes through
//     Codex's own approval (core/src/tools/registry.rs:727). So a bare allow says nothing (no objection),
//     and a rewrite the graph hooks make (updatedInput, no decision) is sent as allow + updatedInput.
//   - "defer" is not in Codex's vocabulary: no objection.
//   - continue:false, stopReason and suppressOutput are unsupported on PreToolUse; suppressOutput on PostToolUse.
//   - reason without decision is rejected on PostToolUse.
import { approvalMessage } from './cursor-once.mjs';

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const str = (x) => typeof x === 'string';

const UNIVERSAL = ['continue', 'stopReason', 'suppressOutput', 'systemMessage'];
// event -> [top-level keys beyond the universal ones, hookSpecificOutput keys (null: no hookSpecificOutput)]
export const CODEX_SCHEMA = {
  PreToolUse: [
    ['decision', 'reason'],
    ['permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'],
  ],
  PostToolUse: [['decision', 'reason'], ['additionalContext']],
  UserPromptSubmit: [['decision', 'reason'], ['additionalContext']],
  SessionStart: [[], ['additionalContext']],
  SubagentStart: [[], ['additionalContext']],
  Stop: [['decision', 'reason'], null],
  SubagentStop: [['decision', 'reason'], null],
  PreCompact: [[], null],
};
const TYPES = {
  continue: 'boolean',
  suppressOutput: 'boolean',
  stopReason: 'string',
  systemMessage: 'string',
  reason: 'string',
  permissionDecisionReason: 'string',
  additionalContext: 'string',
};

function pick(src, keys) {
  const out = {};
  for (const k of keys) {
    if (src[k] === undefined || src[k] === null) continue;
    if (TYPES[k] && typeof src[k] !== TYPES[k]) continue;
    out[k] = src[k];
  }
  return out;
}

/** The answer Codex 0.164 accepts for `event`, cut from Enforcer's merged hook answer; null = print nothing. */
export function codexOutput(event, out, ev = {}) {
  const schema = CODEX_SCHEMA[event];
  if (!schema || !isObj(out)) return null;
  const [topKeys, hsoKeys] = schema;
  const res = pick(out, [...UNIVERSAL, ...topKeys]);
  // Codex's only block value is "block"; "approve" (PreToolUse's legacy allow) is no objection.
  if (res.decision !== 'block') {
    delete res.decision;
    if (res.continue !== false) delete res.reason;
  } else if (!str(res.reason) || !res.reason.trim()) {
    delete res.decision;
    delete res.reason;
  }
  const hs = isObj(out.hookSpecificOutput) ? out.hookSpecificOutput : {};
  let h = hsoKeys ? pick(hs, hsoKeys) : {};
  if (event === 'PreToolUse') {
    delete res.continue;
    delete res.stopReason;
    delete res.suppressOutput;
    h = preToolUse(h, ev);
    // a hookSpecificOutput decision wins over the legacy top-level one in Codex; never send both
    if (h.permissionDecision) {
      delete res.decision;
      delete res.reason;
    }
  }
  if (event === 'PostToolUse') delete res.suppressOutput;
  if (res.continue === true) delete res.continue;
  if (res.suppressOutput === false) delete res.suppressOutput;
  if (Object.keys(h).length) res.hookSpecificOutput = { hookEventName: event, ...h };
  return Object.keys(res).length ? res : null;
}

function preToolUse(h, ev) {
  const d = h.permissionDecision;
  const out = { ...h };
  if (d === 'deny') {
    delete out.updatedInput;
    if (!str(out.permissionDecisionReason) || !out.permissionDecisionReason.trim()) out.permissionDecisionReason = 'Enforcer denied this tool call.';
  } else if (d === 'ask') {
    const what = (str(ev.tool_name) && ev.tool_name) || 'this tool call';
    delete out.updatedInput;
    out.permissionDecision = 'deny';
    out.permissionDecisionReason = approvalMessage(what, h.permissionDecisionReason, 'Codex');
  } else if (out.updatedInput !== undefined && (d === 'allow' || d === undefined)) {
    out.permissionDecision = 'allow';
    delete out.permissionDecisionReason;
  } else {
    // allow without a rewrite, defer, anything else: no objection
    delete out.permissionDecision;
    delete out.permissionDecisionReason;
    delete out.updatedInput;
  }
  return out;
}
