import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { deadHookPaths, grokRuntimeCheck, runChecks } from '../src/doctor.mjs';

const hooksDoc = (cmd) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: cmd }] }] } });
const mkHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'doc-'));
  mkdirSync(join(h, '.grok/hooks'), { recursive: true });
  return h;
};
const snapshot = (d) =>
  readdirSync(d, { recursive: true })
    .sort()
    .map((f) => `${f}:${statSync(join(d, f)).mtimeMs}`)
    .join('|');

test('doctor reports a hook command whose path is missing', () => {
  const h = mkHome();
  const gone = join(h, 'deleted-worktree/hooks/x.mjs');
  writeFileSync(join(h, '.grok/hooks/enforcer.json'), hooksDoc(`node "${gone}"`));
  mkdirSync(join(h, '.' + 'claude'));
  writeFileSync(join(h, '.' + 'claude/settings.json'), hooksDoc('node ~/nope/y.mjs'));
  const dead = deadHookPaths(h);
  assert.deepEqual(dead.map((d) => normalize(d.path)).sort(), [gone, join(h, 'nope/y.mjs')].map(normalize).sort());
  assert.ok(dead.every((d) => d.file.startsWith(h)));
});

test('doctor reports an old Grok runtime copy and names the migration', async () => {
  const h = mkHome();
  mkdirSync(join(h, '.config/enforcer/grok/0.0.1'), { recursive: true });
  writeFileSync(join(h, '.config/enforcer/grok/VERSION'), '0.0.1\n');
  const r = grokRuntimeCheck(h);
  assert.equal(r.ok, false);
  assert.match(r.detail, /old runtime copy at .*: run enforcer harness uninstall grok/);
  const rows = await runChecks({ network: false, home: h });
  assert.ok(rows.some((x) => x.name === 'grok runtime copy' && !x.ok));
});

test('doctor is silent when every hook path exists', async () => {
  const h = mkHome();
  const f = join(h, 'ok.mjs');
  writeFileSync(f, '');
  writeFileSync(join(h, '.grok/hooks/enforcer.json'), hooksDoc(`node "${f}"`));
  assert.deepEqual(deadHookPaths(h), []);
  const rows = await runChecks({ network: false, home: h });
  assert.ok(!rows.some((x) => x.name === 'hook path exists' || x.name === 'grok runtime copy'));
});

test('doctor changes no file', () => {
  const h = mkHome();
  writeFileSync(join(h, '.grok/hooks/enforcer.json'), hooksDoc('node /gone/z.mjs'));
  mkdirSync(join(h, '.config/enforcer/grok'), { recursive: true });
  writeFileSync(join(h, '.config/enforcer/grok/VERSION'), '0.0.1\n');
  const before = snapshot(h);
  deadHookPaths(h);
  grokRuntimeCheck(h);
  assert.equal(snapshot(h), before);
  assert.equal(existsSync(join(h, 'gone')), false);
});
