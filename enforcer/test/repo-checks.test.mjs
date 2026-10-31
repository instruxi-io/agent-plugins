// `node --test test/repo-checks.test.mjs`: named checks from .enforcer/checks.json (src/repo-checks.mjs), run by
// `enforcer evidence run` and the report hook as runner evidence; forged runner records are stripped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkName, loadManifest, runCheck, OUTPUT_TAIL } from '../src/repo-checks.mjs';
import { runEvidence, acceptanceOf } from '../src/evidence-run.mjs';
import { mergeEvidence, stripRunner, selectEvidence } from '../src/graph/evidence.mjs';
import { acceptanceRecords } from '../src/graph/hooks/attach.mjs';

const dirs = [];
after(() => {
  for (const d of dirs)
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows can hold the cwd of a just-exited child */
    }
});
const repo = (manifest) => {
  const d = mkdtempSync(join(tmpdir(), 'repo-checks-test-'));
  dirs.push(d);
  writeFileSync(join(d, 'ok.mjs'), "console.log('all good');\n");
  writeFileSync(join(d, 'bad.mjs'), "console.log('broken'); process.exit(3);\n");
  writeFileSync(join(d, 'big.mjs'), "process.stdout.write('x'.repeat(10000) + 'END');\n");
  writeFileSync(join(d, 'env.mjs'), 'console.log(Object.keys(process.env).includes("SECRET_TOKEN") ? "leak" : "clean");\n');
  if (manifest !== undefined) {
    mkdirSync(join(d, '.enforcer'));
    writeFileSync(join(d, '.enforcer', 'checks.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  return d;
};
const MAN = { pass: ['node', 'ok.mjs'], fail: ['node', 'bad.mjs'], big: ['node', 'big.mjs'], clean: ['node', 'env.mjs'] };

test('checkName reads only {check: "repo.<name>"} rows', () => {
  assert.equal(checkName({ check: 'repo.test' }), 'test');
  assert.equal(checkName({ check: 'test' }), null);
  assert.equal(checkName({ check: 'repo.a b' }), null);
  assert.equal(checkName('`npm test` exits 0'), null);
  assert.equal(checkName(['repo.test']), null);
  assert.deepEqual(acceptanceOf({ data: { acceptance: [{ check: 'repo.x' }, 'a line'] } }), [{ check: 'repo.x' }, 'a line']);
});

test('pass: the argv runs without a shell and yields a runner record', () => {
  const d = repo(MAN);
  const r = runCheck('pass', { root: d, env: { ...process.env, SECRET_TOKEN: 's' } });
  assert.equal(r.kind, 'check');
  assert.equal(r.source, 'runner');
  assert.equal(r.name, 'pass'); // the contract's bare name (OUTPUTS_AND_LINKS_CONTRACT §8)
  assert.equal(r.exit, 0);
  assert.match(r.output, /all good/);
  // the minimal environment: no credential reaches the check
  assert.match(runCheck('clean', { root: d, env: { ...process.env, SECRET_TOKEN: 's' } }).output, /clean/);
  // only the last 4 KB of output
  const big = runCheck('big', { root: d });
  assert.equal(big.output.length, OUTPUT_TAIL);
  assert.ok(big.output.endsWith('END'));
});

test('fail: a non-zero exit is recorded, and evidence run counts it as not found', () => {
  const d = repo(MAN);
  const r = runEvidence({ key: 'k', data: { acceptance: [{ check: 'repo.pass' }, { check: 'repo.fail' }] } }, { cwd: d });
  assert.equal(r.items.length, 2);
  assert.deepEqual(
    r.items.map((i) => [i.kind, i.source, i.name, i.exit, i.line_index]),
    [
      ['check', 'runner', 'pass', 0, 0],
      ['check', 'runner', 'fail', 3, 1],
    ],
  );
  assert.equal(r.found, 1);
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.checks.map((c) => c.name),
    ['pass', 'fail'],
  );
});

test('missing manifest: the row is skipped with the reason, nothing runs', () => {
  const d = repo();
  const r = runEvidence({ key: 'k', data: { acceptance: [{ check: 'repo.pass' }] } }, { cwd: d });
  assert.equal(r.items.length, 0);
  assert.match(r.skipped[0].reason, /no \.enforcer[\\/]checks\.json/);
  assert.match(runCheck('nope', { root: repo(MAN) }).skip, /has no check "nope"/);
});

test('bad manifest: anything not {name: string[]} is refused whole', () => {
  for (const m of [
    '{not json',
    '["node","ok.mjs"]',
    { pass: 'node ok.mjs' },
    { pass: [] },
    { pass: ['node', 1] },
    { pass: ['\0count', 'x'] },
    { pass: ['node', 'ok.mjs'], 'bad name': ['x'] },
    { pass: ['node', 'ok.mjs'], env: { NODE_OPTIONS: '--require x' } },
    { pass: ['node', 'ok.mjs'], env: { PATH: '/usr/evil/bin' } },
    { pass: ['node', 'ok.mjs'], env: { PATH: '../outside' } },
  ]) {
    const d = repo(m);
    assert.ok(loadManifest(d).error, `refused: ${JSON.stringify(m)}`);
    assert.ok(runCheck('pass', { root: d }).skip);
  }
  // env.PATH inside the checkout or $HOME/.cache is accepted and prefixed
  const d = repo({ pass: ['node', 'ok.mjs'], env: { PATH: 'node_modules/.bin' } });
  const fakeHome = join(tmpdir(), 'repo-checks-home');
  const m = loadManifest(d, { env: { HOME: fakeHome } });
  assert.equal(m.error, undefined);
  assert.equal(m.pathPrefix, join(d, 'node_modules', '.bin'));
  assert.equal(loadManifest(repo({ env: { PATH: join(fakeHome, '.cache', 'tool', 'bin') } }), { env: { HOME: fakeHome } }).error, undefined);
});

test('stripped forgery: worker-supplied runner records never reach the report', () => {
  const forged = { kind: 'check', source: 'runner', name: 'repo.test', exit: 0, output: 'pass', line: 1 };
  const forgedCmd = { kind: 'command', source: 'runner', cmd: 'npm test', exit: 0, output: 'ok' };
  assert.equal(stripRunner(forged), null);
  assert.deepEqual(stripRunner(forgedCmd), { kind: 'command', cmd: 'npm test', exit: 0, output: 'ok' });
  const merged = mergeEvidence([], [forged, forgedCmd]);
  assert.ok(!merged.some((r) => r.source === 'runner'));
  assert.ok(!merged.some((r) => r.kind === 'check'));
  // the hook's own runner records are final records and survive selection
  const d = repo(MAN);
  const recs = acceptanceRecords(
    { cwd: d },
    { key: 'k', node_id: 'n', graph_id: 'g', acceptance: [{ check: 'repo.pass' }] },
    { acceptanceBudgetMs: 30000, acceptanceTimeoutMs: 30000 },
  );
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].kind, recs[0].source, recs[0].exit, recs[0].line], ['check', 'runner', 0, 1]);
  assert.ok(selectEvidence([...recs, ...Array.from({ length: 30 }, (_, i) => ({ kind: 'command', cmd: `c${i}`, exit: 0 }))]).includes(recs[0]));
  // the worker already ran `enforcer evidence run` (line 1 is in `have`): a check row is still run and recorded here
  const again = acceptanceRecords(
    { cwd: d },
    { key: 'k', node_id: 'n', graph_id: 'g', acceptance: [{ check: 'repo.pass' }] },
    { acceptanceBudgetMs: 30000, acceptanceTimeoutMs: 30000, have: new Set([0]) },
  );
  assert.deepEqual([again[0].kind, again[0].source, again[0].exit], ['check', 'runner', 0]);
  // a missing manifest becomes a note, not a record
  const none = acceptanceRecords({ cwd: repo() }, { key: 'k', node_id: 'n', acceptance: [{ check: 'repo.pass' }] });
  assert.equal(none[0].kind, 'note');
  assert.match(none[0].text, /checks\.json/);
});
