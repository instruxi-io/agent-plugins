// The hooks/claude shims fed Codex-shaped stdin (same field names plus turn_id,
// model, permission_mode). Fixtures are in test/fixtures/codex (see its README:
// not recorded from a live Codex run).
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeChecksOn } from '../lib/governor/test/fixtures/checks-on.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fx = (n) => readFileSync(join(root, 'test/fixtures/codex', n), 'utf8');
const home = mkdtempSync(join(tmpdir(), 'codex-shim-'));
// Decisioning is off by default; the shims are tested against the checks, so turn them on.
writeChecksOn(join(home, 'g'));
const run = (shim, input) =>
  spawnSync(process.execPath, [join(root, 'hooks/claude', shim)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ENFORCER_HOME: home, GOVERNOR_HOME: join(home, 'g') },
  });
let n = 0;
const ok = (m) => {
  n++;
  console.log('  ok  ' + m);
};

let r = run('governor-pre-tool-use.mjs', fx('pre-tool-use-allow.json'));
assert.equal(r.status, 0, r.stderr);
const allow = JSON.parse(r.stdout);
assert.equal(allow.hookSpecificOutput.hookEventName, 'PreToolUse');
assert.equal(allow.hookSpecificOutput.permissionDecision, undefined);
ok('PreToolUse allow: exit 0, no objection');

r = run('governor-pre-tool-use.mjs', fx('pre-tool-use-deny.json'));
assert.equal(r.status, 0, r.stderr);
const deny = JSON.parse(r.stdout).hookSpecificOutput;
assert.equal(deny.permissionDecision, 'deny');
assert.match(deny.permissionDecisionReason, /pipe_to_shell/);
ok('PreToolUse deny: permissionDecision deny, code pipe_to_shell');

for (const [f, shims] of [
  ['permission-request.json', ['governor-pre-tool-use.mjs', 'governor-post-tool-use.mjs']],
  ['post-compact.json', ['governor-pre-tool-use.mjs', 'governor-session-start.mjs', 'governor-user-prompt-submit.mjs']],
  ['interrupt.json', ['governor-pre-tool-use.mjs', 'governor-post-tool-use.mjs', 'governor-session-end.mjs', 'governor-subagent-stop.mjs']],
]) {
  for (const s of shims) {
    r = run(s, fx(f));
    assert.equal(r.status, 0, `${s} ${f}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${s} ignores ${f} (prints nothing)`);
  }
  ok(`${f.replace('.json', '')} is ignored cleanly (exit 0, no output)`);
}

const plugin = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
assert.equal(plugin.extensions['com.openai'].hooks, './hooks/codex/hooks.json');
assert.ok(plugin.extensions['com.openai'].interface.displayName);
ok('plugin.json carries extensions.com.openai, with its own hooks file');

// Codex's hooks are Claude Code's, event for event, plus the one flag that tells
// the governor it is running under Codex. A hook added to one file and not the
// other fails here.
const claudeHooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'));
const codexHooks = JSON.parse(readFileSync(join(root, 'hooks/codex/hooks.json'), 'utf8'));
for (const groups of Object.values(claudeHooks.hooks)) for (const g of groups) for (const h of g.hooks) h.command += ' --harness codex';
assert.deepEqual(codexHooks, claudeHooks);
ok('hooks/codex/hooks.json is hooks/hooks.json with --harness codex on every command');

// Under that flag the decision record names Codex, not Claude Code. The env is
// cleared of Claude Code's own marker so the suite proves the flag, not its parent.
{
  const { CLAUDECODE: _c, ENFORCER_HARNESS: _e, ...env } = process.env;
  const h = mkdtempSync(join(tmpdir(), 'codex-harness-'));
  writeChecksOn(join(h, 'g'));
  const r = spawnSync(process.execPath, [join(root, 'bin/enforcer'), 'event', 'pre-tool-use', '--harness', 'codex'], {
    input: fx('pre-tool-use-deny.json'),
    encoding: 'utf8',
    env: { ...env, HOME: h, ENFORCER_HOME: h, GOVERNOR_HOME: join(h, 'g') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const recs = readFileSync(join(h, 'g', 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(recs.length > 0, 'a receipt was written');
  assert.deepEqual([...new Set(recs.map((x) => x.harness))], ['codex']);
}
ok('enforcer event --harness codex: the receipt says harness codex');
const mk = JSON.parse(readFileSync(join(root, '../.agents/plugins/marketplace.json'), 'utf8'));
const me = mk.plugins.find((p) => p.name === 'enforcer');
assert.deepEqual(me.source, { source: 'local', path: './enforcer' });
assert.equal(me.version, plugin.version);
assert.ok(me.policy && me.category);
const cm = JSON.parse(readFileSync(join(root, '../.' + 'claude-plugin/marketplace.json'), 'utf8'));
assert.equal(cm.plugins.find((p) => p.name === 'enforcer').version, plugin.version);
ok('marketplace source is {source:local,path} with version equal to plugin.json');

const { codexNormalize } = await import('../lib/governor/hooks/lib.mjs');
let e = codexNormalize({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: /a/b.txt\n@@\n' } });
assert.equal(e.tool_name, 'Edit');
assert.equal(e.tool_input.file_path, '/a/b.txt');
ok('apply_patch maps to Edit');
e = codexNormalize({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'ls -la /tmp'] } });
assert.equal(e.tool_name, 'Bash');
assert.equal(e.tool_input.command, 'ls -la /tmp');
ok('shell maps to Bash');
assert.ok(existsSync(join(root, 'harness/codex/mcp.json')));
ok('harness/codex ships inside the package');
console.log(`\ncodex-shims: ${n} checks passed`);
