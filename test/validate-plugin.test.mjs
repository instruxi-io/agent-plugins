import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readVersions } from '../scripts/release.mjs';

const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
const plugin = path.resolve('enforcer');

test('seven manifests agree', () => {
  const vs = readVersions();
  assert.equal(vs.length, 7);
  const set = new Set(vs.map((v) => v.version));
  assert.equal(set.size, 1, JSON.stringify(vs));
});

test('claude plugin validate accepts the plugin', { skip: !hasClaude && 'claude CLI not installed' }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', 'enforcer'], { encoding: 'utf8' });
  console.log(r.stdout);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /valid|passed/i);
});

test('hooks.json loads in a real session', { skip: !hasClaude && 'claude CLI not installed' }, () => {
  const events = Object.keys(JSON.parse(fs.readFileSync('enforcer/hooks/hooks.json', 'utf8')).hooks);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-'));
  const log = path.join(cwd, 'debug.log');
  // The session may stop at sign-in in CI; plugin and hook loading happens before that.
  spawnSync('claude', ['-p', 'hi', '--plugin-dir', plugin, '--debug-file', log], { cwd, input: '', encoding: 'utf8', timeout: 90000 });
  const dbg = fs.readFileSync(log, 'utf8');
  assert.match(dbg, /Loading hooks from plugin: enforcer/);
  const bad = dbg.split('\n').filter((l) => /hooks\.json|invalid hook|unknown hook/i.test(l) && /(invalid|unknown|failed|schema)/i.test(l));
  assert.deepEqual(bad, [], 'hook schema rejected:\n' + bad.join('\n'));
  const m = dbg.match(/Registered (\d+) hooks/);
  assert.ok(m && Number(m[1]) >= events.length, `registered ${m && m[1]} hooks, hooks.json declares ${events.length} events`);
});

test('login command passes arguments via stdin', () => {
  const md = fs.readFileSync('enforcer/commands/login.md', 'utf8');
  assert.match(md, /--args-stdin/);
  assert.doesNotMatch(md, /ENFORCER_ARGS='/);
  const r = spawnSync(process.execPath, ['enforcer/bin/login.mjs', '--args-stdin'], {
    input: 'status',
    encoding: 'utf8',
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'lg-')) },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('agent frontmatter uses supported fields', () => {
  const fm = fs.readFileSync('enforcer/agents/graph-worker.md', 'utf8').split('---')[1];
  const keys = [...fm.matchAll(/^([a-zA-Z]+):/gm)].map((m) => m[1]);
  for (const k of keys) assert.ok(['name', 'description', 'model', 'maxTurns', 'tools'].includes(k), 'unexpected agent field ' + k);
  assert.match(fm, /tools:.*\bSkill\b/);
});
