// A claim card input naming a branch (tests_branch) is the worktree's base, not data.base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { worktreeFor, inputBase } from '../src/dispatch/worktree.mjs';

const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

test('inputBase picks the branch or commit input, ignores unsafe values', () => {
  assert.deepEqual(inputBase({ tests_branch: 'graph/AQN/test-author/e1' }), ['origin/graph/AQN/test-author/e1', 'input tests_branch']);
  assert.deepEqual(inputBase({ base_commit: 'abcdef1234' }), ['abcdef1234', 'input base_commit']);
  assert.equal(inputBase({ tests_branch: 'a b;rm' }), null);
  assert.equal(inputBase({}), null);
  assert.equal(inputBase(null), null);
});

test('worktreeFor builds off tests_branch, not data.base', () => {
  const root = mkdtempSync(join(tmpdir(), 'wib-'));
  const origin = join(root, 'origin.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const src = join(root, 'repo');
  sh(root, 'clone', '-q', origin, src);
  sh(src, 'config', 'user.email', 't@t');
  sh(src, 'config', 'user.name', 't');
  sh(src, 'commit', '-q', '--allow-empty', '-m', 'base');
  sh(src, 'push', '-q', 'origin', 'HEAD:main');
  sh(src, 'checkout', '-q', '-b', 'tb');
  sh(src, 'commit', '-q', '--allow-empty', '-m', 'tests');
  sh(src, 'push', '-q', 'origin', 'tb');
  sh(src, 'checkout', '-q', 'main');
  const tbSha = sh(src, 'rev-parse', 'tb').stdout.trim();
  const logs = [];
  const node = { key: 'impl', data: { repo: 'repo', base: 'main' } };
  const [path, branch] = worktreeFor(node, root, join(root, 'state'), { inputs: { tests_branch: 'tb' }, say: (m) => logs.push(m) });
  assert.ok(existsSync(path));
  assert.equal(sh(path, 'rev-parse', 'HEAD').stdout.trim(), tbSha);
  assert.ok(branch);
  assert.ok(
    logs.some((l) => l.includes('worktree-base: from input tests_branch tb')),
    logs.join('|'),
  );
});
