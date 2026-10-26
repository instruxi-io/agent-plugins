// A dispatch started through the Grok/Codex `enforcer` shim hands off to the installed Claude Code plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { handoffRoot, isClaudePlugin, preflight } from '../../src/preflight.mjs';
import { DOT } from '../../hooks/claude/paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'shim-handoff-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// a Grok runtime copy: plugin.json, no Claude Code manifest dir
const runtime = join(tmp, 'grok', '1.3.26');
mkdirSync(runtime, { recursive: true });
writeFileSync(join(runtime, 'plugin.json'), '{"name":"enforcer","version":"1.3.26"}');

// the installed Claude Code plugin, whose bin records how it was called
const cfg = join(tmp, 'claude');
const installed = join(cfg, 'plugins', 'cache', 'instruxi', 'enforcer', '1.3.29');
mkdirSync(join(installed, DOT + '-plugin'), { recursive: true });
mkdirSync(join(installed, 'bin'));
writeFileSync(join(installed, 'plugin.json'), '{"name":"enforcer","version":"1.3.29"}');
writeFileSync(join(installed, DOT + '-plugin', 'plugin.json'), '{"name":"enforcer","version":"1.3.29"}');
writeFileSync(
  join(installed, 'bin', 'enforcer'),
  'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), handoff: process.env.ENFORCER_DISPATCH_HANDOFF }));\n',
);

const env = { CLAUDE_CONFIG_DIR: cfg };

test('a runtime copy hands off to the installed Claude Code plugin', () => {
  assert.equal(isClaudePlugin(runtime), false);
  assert.equal(handoffRoot(runtime, env), installed);
});

test('a Claude Code plugin root does not hand off', () => {
  assert.equal(handoffRoot(installed, env), null);
  assert.equal(handoffRoot(ROOT, env), null);
});

test('CLAUDE_PLUGIN_ROOT pointing at the runtime copy is ignored', () => {
  assert.equal(handoffRoot(runtime, { ...env, CLAUDE_PLUGIN_ROOT: runtime }), installed);
});

test('no installed Claude Code plugin: no handoff', () => {
  assert.equal(handoffRoot(runtime, { CLAUDE_CONFIG_DIR: join(tmp, 'empty') }), null);
});

test('preflight fails worker-plugin for a runtime copy', async () => {
  const res = await preflight({ graph: 'g', env: { PATH: process.env.PATH, HOME: '/nonexistent' }, workerRoot: runtime });
  const l = res.find((r) => r.name === 'worker-plugin');
  assert.equal(l.ok, false);
  assert.match(l.line, /enforcer:graph-worker' not found/);
});

test('enforcer dispatch run from a runtime copy execs the installed plugin', () => {
  const copy = join(tmp, 'codex', '1.3.26');
  for (const d of ['bin', 'src', 'lib', 'hooks', 'plugin.json', 'package.json']) cpSync(join(ROOT, d), join(copy, d), { recursive: true });
  const r = spawnSync(process.execPath, [join(copy, 'bin', 'enforcer'), 'dispatch', 'status', 'g1'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: tmp, CLAUDE_CONFIG_DIR: cfg },
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { argv: ['dispatch', 'status', 'g1'], handoff: '1' });
  assert.match(r.stderr, /dispatching from the Claude Code plugin at .*1\.3\.29/);
});
