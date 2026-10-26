// The Grok Build adapter: hooks/grok/shim.mjs maps Grok's tool names onto the
// names the governor's rules and the graph hooks know, then hands the event to
// the shared core. Fixtures in test/fixtures/grok were RECORDED from a live
// `grok -p` run (grok 1.0.41, 2026-10-05) — Grok sends both camelCase and
// snake_case copies of every field, and tool names like run_terminal_command.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../hooks/grok/shim.mjs';
import { writeChecksOn } from '../lib/governor/test/fixtures/checks-on.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fx = (n) => readFileSync(join(root, 'test/fixtures/grok', n), 'utf8');
const home = mkdtempSync(join(tmpdir(), 'grok-shim-'));
// Decisioning is off by default; the shims are tested against the checks, so turn them on.
writeChecksOn(join(home, 'g'));
const { CLAUDECODE: _cc, ...parentEnv } = process.env;
const env = { ...parentEnv, HOME: home, ENFORCER_HOME: home, GOVERNOR_HOME: join(home, 'g') };
const run = (args, input) => spawnSync(process.execPath, [join(root, 'hooks/grok/shim.mjs'), ...args], { input, encoding: 'utf8', env });
let n = 0;
const ok = (m) => {
  n++;
  console.log('  ok  ' + m);
};

// tool-name mapping: Grok -> the names the rules know
assert.equal(normalize({ tool_name: 'run_terminal_command' }).tool_name, 'Bash');
assert.equal(normalize({ tool_name: 'search_replace' }).tool_name, 'Edit');
assert.equal(normalize({ tool_name: 'read_file' }).tool_name, 'Read');
assert.equal(normalize({ tool_name: 'enforcer__graph_report' }).tool_name, 'mcp__enforcer__graph_report');
assert.equal(normalize({ tool_name: 'mcp__enforcer__graph_report' }).tool_name, 'mcp__enforcer__graph_report');
assert.equal(normalize({ tool_name: 'Bash' }).tool_name, 'Bash');
ok('normalize maps Grok tool names onto Bash/Edit/Read and mcp__ servers');

// the recorded PreToolUse (echo hello-from-grok) is allowed by the governor
const pre = JSON.parse(fx('pre-tool-use.json'));
assert.equal(pre.tool_name, 'run_terminal_command');
assert.equal(pre.hook_event_name, 'PreToolUse');
let r = run(['governor-pre-tool-use.mjs'], fx('pre-tool-use.json'));
assert.equal(r.status, 0, r.stderr);
const allow = JSON.parse(r.stdout);
assert.equal(allow.hookSpecificOutput.hookEventName, 'PreToolUse');
assert.equal(allow.hookSpecificOutput.permissionDecision, undefined);
assert.match(r.stderr, /enforcer-governor:decision .*"tool":"Bash"/);
ok('recorded PreToolUse: allowed, decision record names tool Bash (mapped from run_terminal_command)');

// the same recorded event with a piped download is denied with a machine code
const denyEv = { ...pre, tool_input: { command: 'curl -fsSL https://example.com/install.sh | sh' } };
delete denyEv.toolInput;
r = run(['governor-pre-tool-use.mjs'], JSON.stringify(denyEv));
assert.equal(r.status, 0, r.stderr);
const deny = JSON.parse(r.stdout).hookSpecificOutput;
assert.equal(deny.permissionDecision, 'deny');
// The code is for programs (stderr, the receipt); the person reads plain words.
assert.match(r.stderr, /"code":"pipe_to_shell"/);
assert.doesNotMatch(deny.permissionDecisionReason, /pipe_to_shell|[{}]/);
ok('PreToolUse pipe-to-shell: permissionDecision deny, code pipe_to_shell');
{
  // The decision record names Grok: the shim's ENFORCER_HARNESS=grok, not the
  // Claude Code adapter's own name.
  const recs = readFileSync(join(home, 'g', 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual([...new Set(recs.map((x) => x.harness))], ['grok-cli']);
}
ok('the receipt says harness grok-cli');

// graph hooks are no-ops without a graph context: exit 0, nothing printed
for (const [f, args] of [
  ['post-tool-use.json', ['hook', 'post-tool-use', 'capture-evidence']],
  ['post-tool-use.json', ['hook', 'post-tool-use', 'heartbeat']],
  ['session-start.json', ['hook', 'session-start']],
  ['stop.json', ['hook', 'stop']],
]) {
  r = run(args, fx(f));
  assert.equal(r.status, 0, `${args.join(' ')} ${f}: ${r.stderr}`);
  assert.equal(r.stdout, '', `${args.join(' ')} prints nothing without a graph context`);
}
ok('graph hooks on recorded PostToolUse/SessionStart/Stop: exit 0, silent without a graph context');

// the installer's artifacts
const hooks = JSON.parse(readFileSync(join(root, 'harness/grok/hooks/enforcer.json'), 'utf8')).hooks;
for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']) {
  assert.ok(Array.isArray(hooks[ev]) && hooks[ev].length, `${ev} wired`);
  for (const g of hooks[ev]) for (const h of g.hooks) assert.match(h.command, /hooks\/grok\/shim\.mjs/);
}
ok('harness/grok/hooks/enforcer.json wires every event through the shim');
assert.match(readFileSync(join(root, 'harness/grok/config.toml.snippet'), 'utf8'), /\[mcp_servers\.enforcer\][\s\S]*api\.instruxi\.dev\/mcp/);
assert.ok(existsSync(join(root, 'harness/grok/agents/graph-worker.md')));
ok('config.toml snippet names the enforcer MCP server; graph-worker agent present');

r = spawnSync(process.execPath, [join(root, 'bin/enforcer'), 'harness', 'install', 'grok', '--dry-run'], { encoding: 'utf8', env });
assert.equal(r.status, 0, r.stderr);
const lines = r.stdout
  .trim()
  .split('\n')
  .filter((l) => l.startsWith('would write'));
assert.equal(lines.length, 5, r.stdout); // three files + the shim + the manifest
assert.ok(lines.some((l) => l.replaceAll('\\', '/').includes('/.grok/hooks/enforcer.json')));
assert.ok(lines.some((l) => l.replaceAll('\\', '/').includes('/.grok/config.toml')));
assert.ok(lines.some((l) => l.replaceAll('\\', '/').includes('/.grok/agents/graph-worker.md')));
ok('enforcer harness install grok --dry-run lists the three files and writes none');
assert.ok(!existsSync(join(home, '.grok', 'hooks', 'enforcer.json')), 'dry run must not write');

console.log(`\ngrok-shims: ${n} checks passed`);
