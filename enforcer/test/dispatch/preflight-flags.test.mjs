// `node --test test/dispatch/preflight-flags.test.mjs`: `enforcer dispatch <graph>` judges preflight with the
// identity flags it was given. Before, --agent and --allow-browser-signin never reached preflight, so every
// plan estimated over 2 h failed the identity check whatever was passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphArg, preflightOptions, DEFAULTS } from '../../src/dispatch-command.mjs';
import { identityCheck } from '../../src/dispatch/agent.mjs';

const G = 'e0f4a616-f6c5-4210-aaba-8587c6cda6f5';

test('--allow-browser-signin reaches preflight', () => {
  const o = preflightOptions([G, '--allow-browser-signin']);
  assert.equal(o.allowBrowserSignin, true);
  assert.equal(o.agent, undefined);
});

test('--agent reaches preflight and its value is not taken for the graph', () => {
  const argv = ['--agent', 'release-bot', G];
  assert.equal(graphArg(argv), G);
  assert.equal(preflightOptions(argv).agent, 'release-bot');
});

test('--workers reaches preflight, defaulting as the runner does', () => {
  assert.equal(preflightOptions([G, '--workers', '5']).workers, 5);
  assert.equal(preflightOptions([G]).workers, DEFAULTS.workers);
  assert.equal(preflightOptions([G, '--workers', 'x']).workers, DEFAULTS.workers);
});

test('--worker-rules and --repo-root still reach preflight', () => {
  const o = preflightOptions([G, '--worker-rules', 'on', '--repo-root', '/tmp/r']);
  assert.equal(o.workerRules, 'on');
  assert.equal(o.repoRoot, '/tmp/r');
});

test('a long plan passes identity only when the flag is given', () => {
  // 40 nodes of the default estimate run well past the 2 h threshold on 3 workers.
  const nodes = Array.from({ length: 40 }, (_, i) => ({ key: `n${i}`, type: 'task', status: 'ready' }));
  assert.equal(identityCheck({ nodes, ...preflightOptions([G]) }).ok, false);
  assert.equal(identityCheck({ nodes, ...preflightOptions([G, '--allow-browser-signin']) }).ok, true);
});
