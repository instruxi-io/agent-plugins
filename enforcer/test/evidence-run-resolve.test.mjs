// `node --test test/evidence-run-resolve.test.mjs`: <n> resolution and escaped literals. No network: the gh lookup is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLine, substitute, clipEvidence } from '../src/evidence-run.mjs';
import { literalIn } from '../src/literal-match.mjs';

const LINE = '`gh pr view <n> -R instruxi-io/claude-plugins --json state,mergeCommit` prints `"state":"MERGED"`';
const base = { cwd: process.cwd(), graph: 'g', nodeKey: 'my-node', nodeId: 'id1', env: { GH_TOKEN: 't' } };

test('n resolves to the pull request of the node branch', () => {
  const calls = [];
  const lookup = (repo, key) => (calls.push([repo, key]), 42);
  const p = prepareLine(LINE, { ...base, lookup });
  assert.equal(p.skip, undefined);
  assert.deepEqual(p.argv.slice(0, 4), ['gh', 'pr', 'view', '42']);
  assert.deepEqual(calls, [['instruxi-io/claude-plugins', 'my-node']]);
  assert.equal(substitute('gh pr view <pr> -R o/r', { nodeKey: 'k', lookup: () => 7, env: {} }).cmd, 'gh pr view 7 -R o/r');
});

test('an explicit pr flag overrides the lookup', () => {
  const lookup = () => assert.fail('must not look up');
  assert.match(prepareLine(LINE, { ...base, lookup, pr: '9' }).cmd, /view 9 /);
  assert.match(prepareLine(LINE, { ...base, lookup, env: { GH_TOKEN: 't', ENFORCER_EVIDENCE_PR: '11' } }).cmd, /view 11 /);
  assert.match(prepareLine(LINE, { ...base, lookup, pr: 'x; rm' }).skip, /invalid pull request number/);
});

test('a missing pull request is skipped with a clear reason', () => {
  const p = prepareLine(LINE, { ...base, lookup: () => null });
  assert.equal(p.skip, 'no pull request for graph/my-node yet');
});

test('the owner and repo come from the line and are validated', () => {
  const lookup = () => assert.fail('must not look up');
  assert.match(prepareLine('`gh pr view <n> --json state` prints `MERGED`', { ...base, lookup }).skip, /-R <owner\/repo>/);
  assert.match(prepareLine('`gh pr view <n> -R a/b/c --json state` prints `MERGED`', { ...base, lookup }).skip, /-R <owner\/repo>/);
});

test('an escaped tab in a quoted literal matches a real tab', () => {
  assert.equal(literalIn('ok\tgithub.com/x 0.1s', 'ok\\tgithub.com/x'), true);
  assert.equal(literalIn('a\\b', 'a\\\\b'), true);
  const big = 'x\n'.repeat(3000) + 'ok\tgithub.com/x\n' + 'y\n'.repeat(3000);
  assert.match(clipEvidence(big, ['ok\\tgithub.com/x']), /\[match\] ok\tgithub\.com\/x/);
});

test('a raw literal still matches first', () => {
  assert.equal(literalIn('path a\\tb here', 'a\\tb'), true);
  assert.equal(literalIn('nothing', 'a\\tb'), false);
});
