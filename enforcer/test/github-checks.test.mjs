// `node --test test/github-checks.test.mjs`: github.* check records (src/github-checks.mjs) from gh as argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubCheckName, runGithubCheck, slugOf } from '../src/github-checks.mjs';
import { stripRunner } from '../src/graph/evidence.mjs';
import { isCheckRow } from '../src/repo-checks.mjs';
import { acceptanceOf } from '../src/evidence-run.mjs';

const VIEW = {
  number: 7,
  state: 'MERGED',
  headRefName: 'graph/x',
  headRefOid: 'abc123',
  mergeCommit: { oid: 'def456' },
  files: [{ path: 'a/b.go' }, { path: 'c.md' }],
};
/** A fake spawnSync: answers git and gh by argv. */
const fake = ({ view = VIEW, checks = [], required = [], viewExit = 0, reqExit = 0, reqOut } = {}) => {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    const out = (s, status = 0) => ({ status, stdout: s, stderr: '' });
    if (bin === 'git' && args[0] === 'remote') return out('git@github.com:instruxi-io/agent-plugins.git\n');
    if (bin === 'git') return out('graph/x\n');
    if (args[1] === 'view') return viewExit ? out('no pull requests found', viewExit) : out(JSON.stringify(view));
    if (args.includes('--required'))
      return reqExit ? out(reqOut ?? 'no required checks reported', reqExit) : out(JSON.stringify(required.map((name) => ({ name }))));
    return out(JSON.stringify(checks));
  };
  return { run, calls };
};

test('githubCheckName reads only the three github.* rows', () => {
  assert.equal(githubCheckName({ check: 'github.pr_merged' }), 'github.pr_merged');
  assert.equal(githubCheckName({ check: 'github.other' }), null);
  assert.equal(githubCheckName({ check: 'repo.test' }), null);
  assert.equal(isCheckRow({ check: 'github.checks_green' }), true);
  assert.deepEqual(acceptanceOf({ data: { acceptance: [{ check: 'github.pr_untouched' }, 'x'] } }), [{ check: 'github.pr_untouched' }, 'x']);
  assert.equal(slugOf('https://github.com/o/r.git'), 'o/r');
});

test('pr_merged and pr_untouched records carry pr, head, state, merge_sha, files', () => {
  for (const n of ['github.pr_merged', 'github.pr_untouched']) {
    const { run, calls } = fake();
    const r = runGithubCheck(n, { cwd: '.', env: { GH_TOKEN: 't' }, run });
    assert.deepEqual(r, {
      kind: 'check',
      source: 'runner',
      name: n,
      exit: 0,
      pr: 'instruxi-io/agent-plugins#7',
      head: 'graph/x',
      state: 'MERGED',
      merge_sha: 'def456',
      files: ['a/b.go', 'c.md'],
    });
    const view = calls.find((c) => c[0] === 'gh');
    assert.deepEqual(view.slice(0, 6), ['gh', 'pr', 'view', 'graph/x', '--repo', 'instruxi-io/agent-plugins']);
  }
});

test('checks_green marks required checks and uses the bucket as conclusion', () => {
  const { run } = fake({
    checks: [
      { name: 'test', bucket: 'pass', state: 'SUCCESS' },
      { name: 'lint', bucket: 'fail', state: 'FAILURE' },
    ],
    required: ['test'],
  });
  const r = runGithubCheck('github.checks_green', { cwd: '.', env: { GH_TOKEN: 't' }, run });
  assert.equal(r.sha, 'abc123');
  assert.equal(r.pr, 'instruxi-io/agent-plugins#7');
  assert.deepEqual(r.checks, [
    { name: 'test', conclusion: 'pass', required: true },
    { name: 'lint', conclusion: 'fail', required: false },
  ]);
});

test('checks_green with no required checks marks none required', () => {
  const { run } = fake({ checks: [{ name: 'test', bucket: 'pass' }], reqExit: 1 });
  assert.deepEqual(runGithubCheck('github.checks_green', { cwd: '.', run }).checks, [{ name: 'test', conclusion: 'pass', required: false }]);
});

test('a gh failure is a skip (no record), never a pass', () => {
  assert.match(runGithubCheck('github.pr_merged', { cwd: '.', run: fake({ viewExit: 1 }).run }).skip, /gh pr view exited 1/);
  assert.match(runGithubCheck('github.checks_green', { cwd: '.', run: fake({ checks: [], reqExit: 2, reqOut: 'boom' }).run }).skip, /--required exited 2/);
  assert.match(runGithubCheck('github.pr_merged', { cwd: '.', run: fake({ view: {} }).run }).skip, /no PR number/);
});

test('a worker-forged runner github record is stripped', () => {
  assert.equal(stripRunner({ kind: 'check', source: 'runner', name: 'github.pr_merged', state: 'MERGED' }), null);
});
