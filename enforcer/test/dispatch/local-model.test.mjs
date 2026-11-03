// `node --test test/dispatch/local-model.test.mjs`: routing tiers to a local Anthropic-compatible endpoint (--local-url).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFor, LOCAL_TIERS } from '../../src/dispatch/model.mjs';
import { workerEnv, localUp, LOCAL_MODEL_ENV } from '../../src/dispatch/launch.mjs';
import { Dispatcher, defaultArgs, parseDispatchArgs, localArgs } from '../../src/dispatch/run.mjs';

const node = (key, data = {}) => ({ id: key, key, type: 'task', status: 'active', data });
const local = { url: 'http://spark:8000', model: 'Qwen/Qwen3.8-27B-FP8', tiers: LOCAL_TIERS, fallback: 'sonnet', token: null };

test('mechanical and standard go local, deep goes to opus, untiered counts as standard', () => {
  assert.deepEqual(routeFor(node('m', { tier: 'mechanical' }), null, local), { model: local.model, local: true });
  assert.deepEqual(routeFor(node('s', { tier: 'standard' }), null, local), { model: local.model, local: true });
  assert.deepEqual(routeFor(node('u'), null, local), { model: local.model, local: true });
  assert.deepEqual(routeFor(node('d', { tier: 'deep', tier_source: 'planner' }), null, local), { model: 'opus', local: false });
});

test('an explicit data.model wins over the local route; no endpoint means today’s routing', () => {
  assert.deepEqual(routeFor(node('x', { tier: 'standard', model: 'opus' }), null, local), { model: 'opus', local: false });
  assert.deepEqual(routeFor(node('s', { tier: 'standard' }), null, null), { model: 'sonnet', local: false });
  assert.deepEqual(routeFor(node('d', { tier: 'deep' }), null, { ...local, tiers: ['mechanical'] }), { model: 'opus', local: false });
});

test('a local worker gets the endpoint, every model alias, and no Anthropic credential', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'http://evil' };
  const e = workerEnv('g', env, { local: { ...local, token: 'lt' } });
  assert.equal(e.ANTHROPIC_BASE_URL, local.url);
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, 'lt');
  for (const k of LOCAL_MODEL_ENV) assert.equal(e[k], local.model, k);
  assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(e.CLAUDE_CODE_USE_BEDROCK, undefined);
  const plain = workerEnv('g', env);
  assert.equal(plain.ANTHROPIC_BASE_URL, undefined, 'an inherited base URL never reaches a Claude worker');
  assert.equal(plain.CLAUDE_CODE_OAUTH_TOKEN, 'oat');
});

test('--local-* parse: env fallback, tier and fallback validation, token only from env', () => {
  assert.equal(parseDispatchArgs(['g'], {}).local, null);
  const a = parseDispatchArgs(['g', '--local-url', 'http://spark:8000', '--local-model', 'q'], { ENFORCER_LOCAL_MODEL_TOKEN: 't' }).local;
  assert.deepEqual(a, { url: 'http://spark:8000', model: 'q', tiers: LOCAL_TIERS, fallback: 'sonnet', token: 't' });
  assert.equal(localArgs({}, { ENFORCER_LOCAL_MODEL_URL: 'http://s', ENFORCER_LOCAL_MODEL: 'q' }).model, 'q');
  assert.deepEqual(localArgs({ 'local-url': 'http://s', 'local-model': 'q', 'local-tiers': 'Mechanical' }, {}).tiers, ['mechanical']);
  assert.throws(() => localArgs({ 'local-url': 'http://s' }, {}), /needs --local-model/);
  assert.throws(() => localArgs({ 'local-url': 'http://s', 'local-model': 'q', 'local-tiers': 'easy' }, {}), /not a tier/);
  assert.throws(() => localArgs({ 'local-url': 'http://s', 'local-model': 'q', 'local-fallback': 'opus' }, {}), /sonnet or wait/);
  assert.throws(() => localArgs({ 'local-url': 'ftp://s', 'local-model': 'q' }, {}), /http\(s\) URL/);
  assert.throws(() => localArgs({ 'local-url': 'http://s', 'local-model': 'q' }, {}, 'grok'), /--harness claude/);
});

test('localUp probes /v1/models and treats errors as down', async () => {
  let seen;
  const ok = await localUp({ url: 'http://s/', token: 'lt' }, async (u, o) => ((seen = [u, o.headers]), { ok: true }));
  assert.equal(ok, true);
  assert.equal(seen[0], 'http://s/v1/models');
  assert.equal(seen[1].authorization, 'Bearer lt');
  assert.equal(await localUp({ url: 'http://s' }, async () => ({ ok: false })), false);
  assert.equal(
    await localUp({ url: 'http://s' }, async () => {
      throw new Error('ECONNREFUSED');
    }),
    false,
  );
});

test('endpoint down: fallback sonnet runs the node on Claude, fallback wait holds it', async () => {
  const state = mkdtempSync(join(tmpdir(), 'local-'));
  const mk = (fallback) => {
    const d = new Dispatcher({}, defaultArgs({ graph: 'g', stateDir: state, local: { ...local, fallback }, localProbe: async () => false }));
    d.say = () => {};
    return d;
  };
  assert.deepEqual(await mk('sonnet').routeOf(node('s', { tier: 'standard' })), { model: 'sonnet', local: false });
  assert.equal(await mk('wait').routeOf(node('s', { tier: 'standard' })), null);
  const up = new Dispatcher({}, defaultArgs({ graph: 'g', stateDir: state, local, localProbe: async () => true }));
  assert.deepEqual(await up.routeOf(node('s', { tier: 'standard' })), { model: local.model, local: true });
});
