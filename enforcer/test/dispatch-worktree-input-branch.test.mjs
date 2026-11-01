// A claim card input naming a branch (tests_branch) is the worktree's base, not data.base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { worktreeFor, inputBase, inputBindings, resolveInputBindings } from '../src/dispatch/worktree.mjs';
import { Dispatcher, defaultArgs } from '../src/dispatch/run.mjs';

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

// Live 2026-10-31: the dispatcher launches from the frontier row, which carries data.inputs BINDINGS
// (`test-author.tests_branch`), never the claim card's resolved values, so the input-branch path never ran.
const upstream = {
  nodes: async () => [
    { key: 'test-author', id: 'ta' },
    { key: 'implement', id: 'im' },
  ],
  runs: async (id) =>
    id === 'ta'
      ? [
          { status: 'failed', started_at: '2026-10-31T20:40:00Z', data: { outputs: { tests_branch: 'graph/X/test-author/e1-a2' } } },
          { status: 'succeeded', started_at: '2026-10-31T20:32:00Z', data: { outputs: { tests_branch: 'graph/X/test-author/e1', tests_sha: 'abc1234' } } },
        ]
      : [],
};
const bound = { key: 'implement', data: { repo: 'r', inputs: { tests_branch: 'test-author.tests_branch', tests_sha: 'test-author.tests_sha' } } };

test('inputBindings reads branch-like bindings from data.inputs', () => {
  assert.deepEqual(inputBindings(bound), [['tests_branch', 'test-author', 'tests_branch']]);
  assert.deepEqual(inputBindings({ key: 'x', data: {} }), []);
});

test('resolveInputBindings takes the latest succeeded upstream run output', async () => {
  assert.deepEqual(await resolveInputBindings(bound, upstream), { values: { tests_branch: 'graph/X/test-author/e1' }, missing: [] });
  const r = await resolveInputBindings({ key: 'i', data: { inputs: { tests_branch: 'nobody.tests_branch' } } }, upstream);
  assert.deepEqual(r, { values: {}, missing: ['tests_branch=nobody.tests_branch'] });
});

test('Dispatcher.launchInputs resolves a frontier row (bindings only) into the card branch', async () => {
  const said = [];
  const api = { nodes: upstream.nodes, runs: (_g, id) => upstream.runs(id) };
  const d = new Dispatcher(api, defaultArgs({ graph: 'g1', stateDir: mkdtempSync(join(tmpdir(), 'li-')) }), () => {});
  d.say = (m) => said.push(m);
  assert.deepEqual(await d.launchInputs(bound), { tests_branch: 'graph/X/test-author/e1' });
  assert.deepEqual(await d.launchInputs({ ...bound, input_values: { tests_branch: 'given' } }), { tests_branch: 'given' });
  assert.equal(await d.launchInputs({ key: 'plain', data: {} }), null);
  assert.equal(await d.launchInputs({ key: 'i', data: { inputs: { tests_branch: 'nobody.tests_branch' } } }), null);
  assert.match(said.join('\n'), /input binding unresolved \(tests_branch=nobody\.tests_branch\)/);
});
