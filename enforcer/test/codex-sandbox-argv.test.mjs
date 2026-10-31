import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCmd, gitCommonDir } from '../src/dispatch/launch.mjs';

test('codex workers get a workspace-write sandbox with network, not read-only or full access', () => {
  const cmd = launchCmd('do it', 'gpt-5', { harness: 'codex' }, 'k', { gitDir: null });
  const i = cmd.indexOf('--sandbox');
  assert.ok(i > 0 && cmd[i + 1] === 'workspace-write');
  assert.ok(cmd.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!cmd.includes('--add-dir'), 'no git dir, no extra writable root');
  assert.equal(cmd[cmd.length - 1], 'do it');
});

test('codex gets the git common dir as an --add-dir writable root', () => {
  const cmd = launchCmd('do it', 'gpt-5', { harness: 'codex' }, 'k', { gitDir: '/repo/.git' });
  const i = cmd.indexOf('--add-dir');
  assert.ok(i > 0 && cmd[i + 1] === '/repo/.git');
  assert.ok(i > cmd.indexOf('exec'));
  assert.equal(cmd[cmd.length - 1], 'do it');
});

test("a linked worktree's common dir is the main checkout's .git, and launchCmd adds it from cwd", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gcd-')));
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  execFileSync('git', ['init', '-q', main]);
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'w', wt);
  assert.equal(gitCommonDir(wt), join(main, '.git'));
  const cmd = launchCmd('p', 'gpt-5', { harness: 'codex' }, 'k', { cwd: wt });
  assert.equal(cmd[cmd.indexOf('--add-dir') + 1], join(main, '.git'));
  assert.equal(gitCommonDir(root), null, 'not a checkout');
});

test('only codex gets --add-dir', () => {
  for (const harness of ['claude', 'gemini', 'grok']) {
    assert.ok(!launchCmd('p', 'sonnet', { harness }, 'k', { gitDir: '/repo/.git' }).includes('--add-dir'), harness);
  }
});
