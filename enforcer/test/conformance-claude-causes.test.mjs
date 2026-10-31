// `node --test test/conformance-claude-causes.test.mjs`: the three causes `enforcer conformance --status` read on claude
// on 2026-10-30 (graph 70f4adf3, plugin 1.9.0): check FAIL (no_runner_record for repo.tests), land FAIL (the worker
// pushed graph/<key>, not the card's graph/<code>/<key>/e<epoch>, and github.pr_merged had no gh auth), heartbeat FAIL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, runCheck } from '../src/repo-checks.mjs';
import { runGithubCheck } from '../src/github-checks.mjs';
import { adoptCardBranch, cardBranch } from '../src/graph/hooks/track-run.mjs';
import { due } from '../src/graph/hooks/heartbeat.mjs';
import { resultsOf } from '../src/conformance.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

test('check: the nested manifest {checks: {name: {argv}}} (enforcer-smoke, conformance) runs and yields a runner record', () => {
  const d = tmp('conf-check-');
  mkdirSync(join(d, '.enforcer'));
  writeFileSync(join(d, 'ok.mjs'), "console.log('ok: smoke');\n");
  writeFileSync(join(d, '.enforcer', 'checks.json'), JSON.stringify({ checks: { tests: { argv: ['node', 'ok.mjs'] } } }));
  assert.deepEqual(loadManifest(d).checks, { tests: ['node', 'ok.mjs'] });
  const r = runCheck('tests', { root: d, timeoutMs: 30000 });
  assert.equal(r.kind, 'check');
  assert.equal(r.source, 'runner');
  assert.equal(r.name, 'tests');
  assert.equal(r.exit, 0);
  assert.match(r.output, /ok: smoke/);
  // the flat form still loads, and a bad nested entry is still refused
  writeFileSync(join(d, '.enforcer', 'checks.json'), JSON.stringify({ tests: ['node', 'ok.mjs'] }));
  assert.deepEqual(loadManifest(d).checks, { tests: ['node', 'ok.mjs'] });
  writeFileSync(join(d, '.enforcer', 'checks.json'), JSON.stringify({ checks: { tests: { argv: 'node ok.mjs' } } }));
  assert.match(loadManifest(d).error, /must be a non-empty array/);
});

test('land: a github check with no GH_TOKEN in env uses the operator gh token, so it does not skip', () => {
  const seen = [];
  const run = (bin, args, opts) => {
    seen.push([bin, args[0], opts?.env?.GH_TOKEN]);
    const out = (s) => ({ status: 0, stdout: s, stderr: '' });
    if (bin === 'git' && args[0] === 'remote') return out('git@github.com:instruxi-io/enforcer-smoke.git\n');
    if (bin === 'git') return out('graph/PF3/conf-claude/e1\n');
    return out(JSON.stringify({ number: 37, state: 'MERGED', headRefName: 'graph/PF3/conf-claude/e1', headRefOid: 'a', mergeCommit: { oid: 'b' }, files: [] }));
  };
  const r = runGithubCheck('github.pr_merged', { cwd: '.', env: { PATH: process.env.PATH }, run, token: () => 'tok' });
  assert.equal(r.skip, undefined);
  assert.equal(r.source, 'runner');
  assert.equal(r.state, 'MERGED');
  assert.ok(
    seen.some(([bin, sub, t]) => bin === 'gh' && sub === 'pr' && t === 'tok'),
    'gh pr view ran with the resolved token',
  );
  // a token already in env wins, and the resolver is not asked
  let asked = false;
  runGithubCheck('github.pr_merged', { cwd: '.', env: { GH_TOKEN: 'env' }, run, token: () => ((asked = true), 'x') });
  assert.equal(asked, false);
});

test("land: the claim card's branch is read and the dispatcher's graph/<key> worktree branch is renamed to it", () => {
  assert.equal(cardBranch({ run: { data: { branch: 'graph/PF3/conf-claude/e1' } } }), 'graph/PF3/conf-claude/e1');
  assert.equal(cardBranch({ branch: 'graph/PF3/k/e2' }), 'graph/PF3/k/e2');
  assert.equal(cardBranch({ run: { branch: 'main' } }), '');
  assert.equal(cardBranch({ run: { branch: 'graph/../x' } }), '');
  const d = tmp('conf-branch-');
  const git = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  git('init', '-q', '-b', 'graph/conf-claude');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const said = adoptCardBranch(d, 'graph/PF3/conf-claude/e1');
  assert.match(said, /renamed/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'graph/PF3/conf-claude/e1');
  assert.match(adoptCardBranch(d, 'graph/PF3/conf-claude/e1'), /is on the claim card's branch/);
  // never renames a branch that is not a graph/ branch
  git('checkout', '-q', '-b', 'main');
  assert.match(adoptCardBranch(d, 'graph/PF3/other/e1'), /this checkout is on main/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main');
});

test('heartbeat: the first tool call after a claim beats, and --status reads the count the report carries', () => {
  const now = Date.parse('2026-10-30T16:14:20Z') / 1000;
  const run = { claimed_at: '2026-10-30T16:14:08Z', lease_expires_at: '2026-10-30T16:19:08Z' };
  assert.equal(due(run, now), true);
  assert.equal(due({ ...run, last_hb: now - 5, heartbeats: 1 }, now), false);
  const r = resultsOf({}, [{ status: 'succeeded', started_at: 'a', data: { report: 'x', heartbeats: 2 } }]);
  assert.equal(r.heartbeat, true);
  assert.equal(resultsOf({}, [{ status: 'succeeded', started_at: 'a', data: { report: 'x' } }]).heartbeat, false);
});
