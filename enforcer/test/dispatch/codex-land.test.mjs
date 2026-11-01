// `node --test test/dispatch/codex-land.test.mjs`: the dispatcher commits, pushes and lands for codex workers.
// Fake git, fake gh, fake land-pr and a fake API: no network, no real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landForCodex, diffRefusal, parseNumstat, codexGitRules, commitMessage } from '../../src/dispatch/codex-land.mjs';
import { Dispatcher, defaultArgs } from '../../src/dispatch/run.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dispatch');
const NODE = { id: 'id-k', key: 'k', title: 'Add the thing', type: 'task', data: { paths: ['src/'] } };

/** A fake git + gh: `numstat` is what `git diff --cached --numstat HEAD` prints. Records every call. */
function fakeShell({ numstat = '3\t1\tsrc/a.js\n', prList = '', failOn = null } = {}) {
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    const line = cmd.join(' ');
    if (failOn && line.startsWith(failOn)) return [1, `fatal: ${failOn} refused`];
    if (line.startsWith('git diff --cached --numstat')) return [0, numstat];
    if (line.startsWith('gh pr list')) return [0, prList];
    if (line.startsWith('gh pr create')) return [0, 'https://github.com/o/r/pull/9'];
    return [0, ''];
  };
  return { run, calls };
}

class FakeAPI {
  constructor(status = 'succeeded') {
    this.status = status;
    this.completed = [];
    this.evidence = [];
  }
  async nodes() {
    return [];
  }
  async node() {
    return { status: 'done' };
  }
  async runs() {
    return [{ run_id: 'r-1', status: this.status, started_at: '2026-10-31T18:00:00Z' }];
  }
  async complete(g, n, r, body) {
    this.completed.push({ n, r, body });
    return {};
  }
  async addEvidence(g, n, r, body) {
    this.evidence.push({ n, r, body });
    return {};
  }
}

const record = (name) => ({ kind: 'check', source: 'runner', name, pr: 'o/r#9', exit: 0, state: 'MERGED' });
const opts = (over) => ({
  graph: 'g',
  node: NODE,
  runId: 'r-1',
  cwd: '/tmp/wt',
  branch: 'graph/k',
  base: 'main',
  landPr: '/p/bin/land-pr.sh',
  check: (name) => record(name),
  ...over,
});

test('the codex prompt rules forbid git writes and say to report succeeded with evidence', () => {
  const r = codexGitRules();
  assert.match(r, /Never run git add, git commit, git push, git merge/);
  assert.match(r, /gh pr merge/);
  assert.match(r, /"succeeded" with your evidence/);
  assert.match(r, /land-pr\.sh/);
  assert.match(commitMessage(NODE, 'r-1'), /Node: k \(id-k\)[\s\S]*Enforcer-Run: r-1$/);
});

test('normal landing: commit naming node and run, push the card branch, open the PR, land-pr, post github records', async () => {
  const api = new FakeAPI();
  const sh = fakeShell();
  let landed;
  const res = await landForCodex(
    opts({
      api,
      run: sh.run,
      land: async ({ cmd }) => {
        landed = cmd;
        return { rc: 0, out: 'merged' };
      },
    }),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.url, 'https://github.com/o/r/pull/9');
  const lines = sh.calls.map((c) => c.join(' '));
  const commit = sh.calls.find((c) => c[1] === 'commit');
  assert.match(commit[commit.length - 1], /Node: k[\s\S]*Enforcer-Run: r-1/);
  assert.ok(lines.includes('git push -u origin HEAD:refs/heads/graph/k'), lines.join('\n'));
  const create = sh.calls.find((c) => c[0] === 'gh' && c[2] === 'create');
  assert.match(create[create.length - 1], /Enforcer-Run: r-1$/);
  assert.deepEqual(landed, ['/p/bin/land-pr.sh', 'https://github.com/o/r/pull/9', '--timeout', '1800']);
  assert.equal(api.evidence.length, 1);
  assert.equal(api.evidence[0].r, 'r-1');
  assert.deepEqual(
    api.evidence[0].body.evidence.map((e) => e.name),
    ['github.pr_merged', 'github.checks_green', 'github.pr_untouched'],
  );
});

test('an open PR for the branch is reused, not opened twice', async () => {
  const sh = fakeShell({ prList: 'https://github.com/o/r/pull/4\n' });
  const res = await landForCodex(opts({ api: new FakeAPI(), run: sh.run, land: async () => ({ rc: 0 }) }));
  assert.equal(res.url, 'https://github.com/o/r/pull/4');
  assert.ok(!sh.calls.some((c) => c[0] === 'gh' && c[2] === 'create'));
});

test('empty diff: no commit, destructive_or_empty_diff', async () => {
  const api = new FakeAPI();
  const sh = fakeShell({ numstat: '' });
  let landedCalled = false;
  const res = await landForCodex(
    opts({
      api,
      run: sh.run,
      land: async () => {
        landedCalled = true;
        return { rc: 0 };
      },
    }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'destructive_or_empty_diff');
  assert.match(res.error, /^destructive_or_empty_diff: the worker left no changes/);
  assert.ok(!sh.calls.some((c) => c[1] === 'commit' || c[1] === 'push'));
  assert.equal(landedCalled, false);
  assert.equal(api.evidence.length, 0);
});

test('destructive diff: deletions only, outside the node paths, is refused before any commit', async () => {
  const sh = fakeShell({ numstat: '0\t200\tcalc/a.py\n0\t20\t.enforcer/checks.json\n0\t3\tsrc/x.js\n' });
  const res = await landForCodex(opts({ api: new FakeAPI(), run: sh.run, land: async () => ({ rc: 0 }) }));
  assert.equal(res.code, 'destructive_or_empty_diff');
  assert.deepEqual(res.files, ['calc/a.py', '.enforcer/checks.json']);
  assert.match(res.error, /deletes 223 line\(s\) and adds none/);
  assert.ok(!sh.calls.some((c) => c[1] === 'commit'));
  assert.ok(
    sh.calls.some((c) => c.join(' ') === 'git reset -q'),
    'the staged deletions are unstaged',
  );
});

test('diffRefusal: deletions inside the stated paths, or any additions, may be committed', () => {
  assert.equal(diffRefusal(parseNumstat('0\t5\tsrc/old.js\n'), NODE), null);
  assert.equal(diffRefusal(parseNumstat('1\t50\tcalc/a.py\n'), NODE), null);
  assert.equal(parseNumstat('-\t-\tbin/x.png\n').additions, 1, 'a binary file counts as a change');
});

test('red CI: land-pr exits 2, the run fails with its output as evidence and no github records are posted', async () => {
  const api = new FakeAPI();
  const res = await landForCodex(opts({ api, run: fakeShell().run, land: async () => ({ rc: 2, out: 'check test: FAILURE\nCI failed' }) }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'ci_failed');
  assert.match(res.error, /land-pr\.sh exit 2 for https:\/\/github.com\/o\/r\/pull\/9: check test: FAILURE/);
  assert.equal(res.evidence[0].exit, 2);
  assert.match(res.evidence[0].output, /CI failed/);
  assert.equal(api.evidence.length, 0);
});

test('a git error (push refused) fails without landing', async () => {
  const res = await landForCodex(opts({ api: new FakeAPI(), run: fakeShell({ failOn: 'git push' }).run, land: async () => assert.fail('landed') }));
  assert.equal(res.code, 'git_failed');
  assert.match(res.error, /git push failed/);
});

function dispatcher(api, lines) {
  const state = mkdtempSync(join(tmpdir(), 'cl-'));
  return new Dispatcher(api, defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), killGrace: 0.2 }), (m) =>
    lines.push(m),
  );
}

const codexWorker = () => ({
  kind: 'agent',
  node: { ...NODE, data: { ...NODE.data, base: 'main' } },
  key: 'k',
  logPath: join(FX, 'grok-ok.json'),
  proc: { pid: 4243, exited: 0, returncode: 0, start: null, nonce: null },
  started: 0,
  resources: new Set(),
  path: '/tmp/k',
  branch: 'graph/k',
  model: 'gpt-5',
  harness: 'codex',
  turns: 0,
  maxTurns: 80,
  session: 's-k',
});

test('reap: a codex worker that reported succeeded is landed by the dispatcher on its card branch', async () => {
  const api = new FakeAPI();
  const lines = [];
  const d = dispatcher(api, lines);
  d.gitGuard = () => null;
  let seen;
  d.codexLander = async (o) => {
    seen = o;
    return { ok: true, url: 'https://github.com/o/r/pull/9', records: [] };
  };
  d.workers.set('k', codexWorker());
  await d.reap();
  assert.equal(seen.runId, 'r-1');
  assert.equal(seen.branch, 'graph/k');
  assert.equal(seen.cwd, '/tmp/k');
  assert.equal(seen.base, 'main');
  assert.match(seen.landPr, /land-pr\.sh$/);
  assert.ok(
    lines.some((l) => l.includes('codex land k: merged https://github.com/o/r/pull/9')),
    lines.join('\n'),
  );
  assert.ok(!api.completed.some((c) => c.body.data?.codex_land), 'a landed run is not failed');
});

test('reap: a codex landing refusal fails the run with the reason and the land-pr evidence', async () => {
  const api = new FakeAPI();
  const lines = [];
  const d = dispatcher(api, lines);
  d.gitGuard = () => null;
  d.codexLander = async () => ({
    ok: false,
    code: 'ci_failed',
    error: 'land-pr.sh exit 2 for https://github.com/o/r/pull/9: CI failed',
    url: 'https://github.com/o/r/pull/9',
    evidence: [{ kind: 'command', cmd: 'land-pr.sh', exit: 2, output: 'CI failed' }],
  });
  d.workers.set('k', codexWorker());
  await d.reap();
  const failed = api.completed.find((c) => c.body.data?.codex_land);
  assert.ok(failed, JSON.stringify(api.completed));
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.data.codex_land.code, 'ci_failed');
  assert.equal(failed.body.evidence[0].exit, 2);
  assert.ok(
    lines.some((l) => l.includes('FAILED k ')),
    lines.join('\n'),
  );
});

test('reap: a codex worker whose run did not succeed is not landed', async () => {
  const api = new FakeAPI('failed');
  const d = dispatcher(api, []);
  d.gitGuard = () => null;
  d.codexLander = async () => assert.fail('landed a failed run');
  d.workers.set('k', codexWorker());
  await d.reap();
});
