// What `enforcer event <name> --harness codex` prints, pinned to Codex 0.164's hook output parser
// (openai/codex rust-v0.164.0, codex-rs/hooks/src/schema.rs + engine/output_parser.rs). Every Codex
// output struct is deny_unknown_fields, and JSON stdout that fails the parse is a Failed hook whose
// whole answer is dropped -- the bug this pins: SessionStart's `hookSpecificOutput.env` failed every
// Codex session start. Recorded Codex stdin is in test/fixtures/codex (session-start.json and friends).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexOutput, CODEX_SCHEMA } from '../src/codex-output.mjs';
import { runEvent } from '../src/event.mjs';
import { writeChecksOn } from '../lib/governor/test/fixtures/checks-on.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fx = (n) => readFileSync(join(root, 'test/fixtures/codex', n), 'utf8');
let n = 0;
const ok = (m) => {
  n++;
  console.log('  ok  ' + m);
};

// The Rust wire structs, field for field (camelCase on the wire). A key not listed is a parse failure.
const UNIVERSAL = { continue: 'boolean', stopReason: 'string', suppressOutput: 'boolean', systemMessage: 'string' };
const WIRE = {
  PreToolUse: {
    top: { decision: ['approve', 'block'], reason: 'string' },
    hso: { permissionDecision: ['allow', 'deny', 'ask'], permissionDecisionReason: 'string', updatedInput: 'any', additionalContext: 'string' },
  },
  PostToolUse: { top: { decision: ['block'], reason: 'string' }, hso: { additionalContext: 'string', updatedMCPToolOutput: 'any' } },
  UserPromptSubmit: { top: { decision: ['block'], reason: 'string' }, hso: { additionalContext: 'string' } },
  SessionStart: { top: {}, hso: { additionalContext: 'string' } },
  SubagentStart: { top: {}, hso: { additionalContext: 'string' } },
  Stop: { top: { decision: ['block'], reason: 'string' }, hso: null },
  SubagentStop: { top: { decision: ['block'], reason: 'string' }, hso: null },
  PreCompact: { top: {}, hso: null },
};
const typeOk = (t, v) => (t === 'any' ? true : Array.isArray(t) ? t.includes(v) : typeof v === t);
/** null when Codex 0.164 parses `out` for `event` and accepts it; else why it marks the hook Failed. */
function codexRejects(event, out) {
  const w = WIRE[event];
  for (const [k, v] of Object.entries(out)) {
    if (k === 'hookSpecificOutput') {
      if (!w.hso) return `${event} has no hookSpecificOutput`;
      if (v.hookEventName !== event) return 'hookEventName must name the event';
      for (const [hk, hv] of Object.entries(v))
        if (hk !== 'hookEventName' && !(w.hso[hk] && typeOk(w.hso[hk], hv))) return `unknown or mistyped hookSpecificOutput.${hk}`;
    } else if (!((UNIVERSAL[k] && typeOk(UNIVERSAL[k], v)) || (w.top[k] && typeOk(w.top[k], v)))) return `unknown or mistyped ${k}`;
  }
  // the semantic rules (output_parser.rs): each one is a Failed run
  const hs = out.hookSpecificOutput || {};
  if (event === 'PreToolUse') {
    if (out.continue === false || out.stopReason || out.suppressOutput) return 'PreToolUse universal field unsupported';
    if (hs.permissionDecision === 'ask') return 'permissionDecision:ask unsupported';
    if (hs.permissionDecision === 'allow' && hs.updatedInput === undefined) return 'permissionDecision:allow without updatedInput';
    if (hs.updatedInput !== undefined && hs.permissionDecision !== 'allow') return 'updatedInput without allow';
  }
  if (event === 'PostToolUse') {
    if (out.suppressOutput) return 'PostToolUse suppressOutput unsupported';
    if (hs.updatedMCPToolOutput !== undefined) return 'updatedMCPToolOutput unsupported';
    if (out.decision !== 'block' && out.continue !== false && out.reason !== undefined) return 'reason without decision';
  }
  if (out.decision === 'block' && !(out.reason || '').trim()) return 'block without reason';
  return null;
}
const accepted = (event, out) => {
  if (out === null) return; // empty stdout: Completed
  assert.equal(codexRejects(event, out), null, `${event}: ${JSON.stringify(out)}`);
};

// The validator itself fails on what Codex fails on (the shapes seen Failed under a real codex exec).
assert.match(codexRejects('SessionStart', { hookSpecificOutput: { hookEventName: 'SessionStart', env: { ENFORCER_GOVERNOR: '1' } } }), /env/);
assert.match(codexRejects('Stop', { hookSpecificOutput: { hookEventName: 'Stop' } }), /no hookSpecificOutput/);
assert.match(codexRejects('UserPromptSubmit', { bogus: 1 }), /bogus/);
ok('the wire check rejects what real Codex 0.164 marked Failed (env, Stop hookSpecificOutput, unknown top key)');

// ── SessionStart: the governor announces itself with hookSpecificOutput.env (Claude Code only) ──
const ssClaude = {
  systemMessage: 'Enforcer: decisioning off',
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx', env: { ENFORCER_GOVERNOR: '1' } },
};
const ss = codexOutput('SessionStart', ssClaude);
assert.deepEqual(ss, { systemMessage: 'Enforcer: decisioning off', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });
accepted('SessionStart', ss);
assert.equal(codexOutput('SessionStart', { hookSpecificOutput: { hookEventName: 'SessionStart', env: { A: '1' } } }), null, 'nothing left: print nothing');
ok('SessionStart: env dropped, systemMessage + additionalContext kept');

// ── PreToolUse ──
const pre = (hs, top = {}) => codexOutput('PreToolUse', { ...top, hookSpecificOutput: { hookEventName: 'PreToolUse', ...hs } }, { tool_name: 'Bash' });
assert.equal(pre({}), null, 'pass: no objection, nothing printed');
assert.deepEqual(pre({ permissionDecision: 'deny', permissionDecisionReason: 'no' }), {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
});
const ask = pre({ permissionDecision: 'ask', permissionDecisionReason: 'pushes to main', updatedInput: { x: 1 } });
assert.equal(ask.hookSpecificOutput.permissionDecision, 'deny', 'ask fails closed: Codex would fail the hook and run the call unasked');
assert.match(ask.hookSpecificOutput.permissionDecisionReason, /needs approval for Bash: pushes to main\. Codex cannot ask/);
assert.equal(ask.hookSpecificOutput.updatedInput, undefined);
assert.equal(pre({ permissionDecision: 'allow', permissionDecisionReason: 'fine' }), null, 'bare allow: no objection');
assert.equal(pre({ permissionDecision: 'defer' }), null, 'defer: not a Codex word');
assert.deepEqual(pre({ updatedInput: { a: 1 }, additionalContext: 'note' }).hookSpecificOutput, {
  hookEventName: 'PreToolUse',
  permissionDecision: 'allow',
  updatedInput: { a: 1 },
  additionalContext: 'note',
});
assert.equal(pre({ permissionDecision: 'deny', permissionDecisionReason: 'no', updatedInput: { a: 1 } }).hookSpecificOutput.updatedInput, undefined);
assert.equal(pre({ permissionDecision: 'deny' }).hookSpecificOutput.permissionDecisionReason.length > 0, true, 'a deny always has a reason');
const preTop = pre({}, { systemMessage: 'note', continue: false, stopReason: 'x', suppressOutput: true });
assert.deepEqual(preTop, { systemMessage: 'note' }, 'continue/stopReason/suppressOutput are unsupported on PreToolUse');
for (const o of [ask, preTop, pre({ updatedInput: { a: 1 } }), pre({ permissionDecision: 'deny' })]) accepted('PreToolUse', o);
ok('PreToolUse: ask -> deny, bare allow/defer -> nothing, rewrite -> allow+updatedInput, unsupported universals dropped');

// ── PostToolUse, UserPromptSubmit ──
const post = codexOutput('PostToolUse', {
  systemMessage: 'hb',
  suppressOutput: true,
  reason: 'orphan',
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hb', updatedMCPToolOutput: {}, updatedToolOutput: 'x' },
});
assert.deepEqual(post, { systemMessage: 'hb', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hb' } });
accepted('PostToolUse', post);
assert.equal(codexOutput('PostToolUse', { hookSpecificOutput: { hookEventName: 'PostToolUse' } }), null);
const ups = codexOutput('UserPromptSubmit', { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'brief' }, extra: true });
assert.deepEqual(ups, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'brief' } });
accepted('UserPromptSubmit', ups);
ok('PostToolUse / UserPromptSubmit: only additionalContext in hookSpecificOutput; orphan reason and suppressOutput dropped');

// ── Stop, SubagentStop, PreCompact, SessionEnd ──
const guard = { decision: 'block', reason: 'report node n1 first' };
assert.deepEqual(codexOutput('Stop', { ...guard, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x' } }), guard);
accepted('Stop', codexOutput('Stop', guard));
assert.deepEqual(codexOutput('SubagentStop', guard), guard);
assert.equal(codexOutput('Stop', { decision: 'block', reason: '  ' }), null, 'block without a reason is invalid: dropped');
assert.equal(codexOutput('PreCompact', { hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: 'x' } }), null);
assert.equal(codexOutput('SessionEnd', { systemMessage: 'x' }), null, 'Codex does not read SessionEnd stdout');
assert.equal(codexOutput('PostToolUseFailure', { systemMessage: 'x' }), null, 'not a Codex event');
ok('Stop/SubagentStop keep decision+reason only; PreCompact universal only; SessionEnd prints nothing');

// Every event Codex runs from hooks/codex/hooks.json has a schema here (PostToolUseFailure is not a Codex event:
// codex-rs/config/src/hook_config.rs HookEventsToml has no such key, so Codex never runs it).
const codexHooks = JSON.parse(readFileSync(join(root, 'hooks/codex/hooks.json'), 'utf8'));
for (const ev of Object.keys(codexHooks.hooks)) if (!['SessionEnd', 'PostToolUseFailure'].includes(ev)) assert.ok(CODEX_SCHEMA[ev], ev);
ok('every hooked Codex event has an output schema');

// ── runEvent: the merged answer is cut under codex only; Claude Code keeps env ──
{
  const sessionGov = async () => ssClaude;
  const nativeNone = async () => ({ out: null, code: 0 });
  const capture = async (harness) => {
    let printed = '';
    await runEvent('session-start', {
      input: fx('session-start.json'),
      harness,
      notCursor: true,
      governorFn: sessionGov,
      nativeFn: nativeNone,
      write: (t) => (printed += t),
    });
    return printed ? JSON.parse(printed) : null;
  };
  const prev = process.env.ENFORCER_HARNESS;
  delete process.env.ENFORCER_HARNESS;
  assert.deepEqual(await capture('codex'), ss);
  assert.deepEqual(await capture(undefined), ssClaude, 'Claude Code path unchanged');
  if (prev !== undefined) process.env.ENFORCER_HARNESS = prev;
}
ok('runEvent: --harness codex prints the Codex shape, the Claude Code path is unchanged');

// ── the real binary, recorded Codex stdin, every event: stdout is empty or one object Codex accepts ──
{
  const { CLAUDECODE: _c, ENFORCER_HARNESS: _e, CLAUDE_ENV_FILE: _f, ...env } = process.env;
  const h = mkdtempSync(join(tmpdir(), 'codex-out-'));
  writeChecksOn(join(h, 'g')); // decisioning on, so the deny fixture is really denied
  const ev = (name, file) => {
    const r = spawnSync(process.execPath, [join(root, 'bin/enforcer'), 'event', name, '--harness', 'codex'], {
      input: fx(file),
      encoding: 'utf8',
      // signed out, offline: nothing here reaches a server
      env: { ...env, HOME: h, ENFORCER_HOME: h, ENFORCER_CONFIG_HOME: join(h, 'cfg'), GOVERNOR_HOME: join(h, 'g'), ENFORCER_BASE_URL: 'http://127.0.0.1:9' },
    });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    const out = r.stdout.trim();
    if (!out) return null;
    assert.equal(out.split('\n').length, 1, `${name}: one JSON line`);
    return JSON.parse(out);
  };
  const start = ev('session-start', 'session-start.json');
  accepted('SessionStart', start);
  assert.equal(start?.hookSpecificOutput?.env, undefined);
  accepted('UserPromptSubmit', ev('user-prompt-submit', 'user-prompt-submit.json'));
  accepted('PreToolUse', ev('pre-tool-use', 'pre-tool-use-allow.json'));
  const deny = ev('pre-tool-use', 'pre-tool-use-deny.json');
  accepted('PreToolUse', deny);
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  accepted('PostToolUse', ev('post-tool-use', 'post-tool-use.json'));
  accepted('Stop', ev('stop', 'stop.json'));
  assert.equal(ev('session-end', 'session-end.json'), null);
}
ok('bin/enforcer --harness codex on recorded Codex stdin: every answer is one Codex 0.164 accepts');

console.log(`\ncodex-hook-output: ${n} checks passed`);
