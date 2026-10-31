// `node --test test/dispatch/git-guard.test.mjs`: non-Claude landing rules and the destructive-merge post-run guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nonClaudeGitRules, destructiveMerge, checkDestructiveMerge, statedPaths } from '../../src/dispatch/git-guard.mjs';
import { Dispatcher, defaultArgs } from '../../src/dispatch/run.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dispatch');

test('the non-Claude rules name land-pr.sh, forbid gh pr merge and index overrides, and say to fail on a git error', () => {
  const r = nonClaudeGitRules('/p/bin/land-pr.sh');
  assert.match(r, /\/p\/bin\/land-pr\.sh/);
  assert.match(r, /never run `gh pr merge`/);
  assert.match(r, /GIT_INDEX_FILE/);
  assert.match(r, /GIT_OBJECT_DIRECTORY/);
  assert.match(r, /"failed" with the exact git error/);
});

const pr57 = {
  state: 'MERGED',
  additions: 0,
  deletions: 377,
  url: 'https://github.com/o/r/pull/57',
  files: [
    { path: 'calc/a.py', additions: 0, deletions: 200 },
    { path: '.enforcer/checks.json', additions: 0, deletions: 20 },
    { path: 'bench/run.sh', additions: 0, deletions: 157 },
  ],
};

test('a merged PR with zero additions deleting files outside the node paths is a destructive merge', () => {
  const f = destructiveMerge(pr57, { data: {} });
  assert.ok(f);
  assert.match(f.reason, /^destructive_merge: https:\/\/github.com\/o\/r\/pull\/57 deleted 377 line/);
  assert.deepEqual(f.files, ['calc/a.py', '.enforcer/checks.json', 'bench/run.sh']);
});

test('not destructive: deletions inside the stated paths, any additions, or not merged', () => {
  assert.equal(destructiveMerge(pr57, { data: { paths: ['calc/', '.enforcer', 'bench'] } }), null);
  assert.ok(destructiveMerge(pr57, { data: { paths: ['calc'] } }).files.includes('bench/run.sh'));
  assert.equal(destructiveMerge({ ...pr57, additions: 3 }, { data: {} }), null);
  assert.equal(destructiveMerge({ ...pr57, state: 'OPEN' }, { data: {} }), null);
  assert.equal(destructiveMerge(null, {}), null);
  assert.deepEqual(statedPaths({ data: { files: ['./a.js', 7] } }), ['a.js']);
});

test('checkDestructiveMerge reads the branch PR through gh', () => {
  let seen;
  const run = (cmd, argv) => {
    seen = [cmd, ...argv];
    return { status: 0, stdout: JSON.stringify(pr57) };
  };
  assert.ok(checkDestructiveMerge({ node: { data: {} }, branch: 'graph/x', cwd: '/tmp', run }));
  assert.deepEqual(seen.slice(0, 4), ['gh', 'pr', 'view', 'graph/x']);
  assert.equal(checkDestructiveMerge({ node: {}, branch: 'b', cwd: '/tmp', run: () => ({ status: 1, stdout: '' }) }), null);
});

class FakeAPI {
  constructor() {
    this.completed = [];
  }
  async nodes() {
    return [];
  }
  async complete(g, n, r, body) {
    this.completed.push({ n, r, body });
    return {};
  }
  async runs() {
    return [{ run_id: 'r-1', status: 'succeeded', started_at: '2026-10-31T18:00:00Z' }];
  }
  async node() {
    return { status: 'done' };
  }
}

test('reap logs destructive_merge for a non-Claude worker and reports its run failed', async () => {
  const state = mkdtempSync(join(tmpdir(), 'gg-'));
  const lines = [];
  const api = new FakeAPI();
  const d = new Dispatcher(
    api,
    defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), killGrace: 0.2 }),
    (m) => lines.push(m),
  );
  d.gitGuard = ({ node }) => destructiveMerge(pr57, node);
  d.workers.set('k', {
    kind: 'agent',
    node: { id: 'id-k', key: 'k', type: 'task', data: {} },
    key: 'k',
    logPath: join(FX, 'grok-ok.json'),
    proc: { pid: 4242, exited: 0, returncode: 0, start: null, nonce: null },
    started: 0,
    resources: new Set(),
    path: '/tmp/k',
    branch: 'graph/k',
    model: 'grok',
    harness: 'grok',
    turns: 0,
    maxTurns: 80,
    session: 's-k',
  });
  await d.reap();
  assert.ok(
    lines.some((l) => l.includes('destructive_merge k: destructive_merge:')),
    lines.join('\n'),
  );
  const failed = api.completed.find((c) => c.body.status === 'failed' && c.body.data?.destructive_merge);
  assert.ok(failed, JSON.stringify(api.completed));
  assert.equal(failed.r, 'r-1');
  assert.ok(
    lines.some((l) => l.includes('FAILED k ')),
    'counted as a failed attempt',
  );
});
