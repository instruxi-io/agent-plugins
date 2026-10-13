import test from 'node:test';
import { join, delimiter } from 'node:path';
import assert from 'node:assert/strict';
import { PLUGIN_DIR, workerEnv, mintWorkerToken, ENV_ALLOW, ENV_ALLOW_PREFIX, WORKER_SCOPES } from '../../src/dispatch/launch.mjs';

const dirty = {
  PATH: '/bin',
  HOME: '/h',
  LANG: 'C',
  ENFORCER_API_KEY: 'ek_secret',
  GRAPH_API_KEY: 'op',
  AWS_SECRET_ACCESS_KEY: 'x',
  GH_TOKEN: 'gho',
  GITHUB_TOKEN: 'g',
  CLAUDE_BIN: 'claude',
  LC_ALL: 'C',
};

test('worker env contains no key not on the allowlist', () => {
  const e = workerEnv('g1', dirty);
  for (const k of Object.keys(e)) assert.ok(ENV_ALLOW.includes(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p)), k);
  for (const k of ['AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GRAPH_API_KEY']) assert.equal(e[k], undefined);
  assert.equal(e.GRAPH_ID, 'g1');
  assert.equal(e.PATH, [join(PLUGIN_DIR, 'bin'), '/bin'].join(delimiter), "the operator's PATH passes, behind this plugin's own bin");
});

test("ENFORCER_API_KEY is never the operator's: absent without a worker token, the worker token with one", () => {
  assert.equal(workerEnv('g', dirty).ENFORCER_API_KEY, undefined);
  // the MCP credential helper reads ENFORCER_API_KEY, so the worker token must be there too or claims fall back to the operator's sign-in
  assert.equal(workerEnv('g', dirty, { token: 'ag_x' }).ENFORCER_API_KEY, 'ag_x');
  assert.equal(workerEnv('g', dirty, { token: 'ag_x' }).GRAPH_API_KEY, 'ag_x');
});

test('GH_TOKEN comes only from the operator-provided worker token', () => {
  assert.equal(workerEnv('g', { ...dirty, ENFORCER_WORKER_GH_TOKEN: 'ghw' }).GH_TOKEN, 'ghw');
});

test('worker token has only graph scopes', async () => {
  let call;
  const api = {
    call: async (m, p, b) => {
      call = { m, p, b };
      return { data: { secret: 'ag_s' } };
    },
  };
  assert.equal(await mintWorkerToken(api, { ENFORCER_WORKER_AGENT_ID: 'a1' }), 'ag_s');
  assert.equal(call.p, '/agents/a1/credentials');
  assert.ok(call.b.scopes.length && call.b.scopes.every((s) => s.startsWith('graph:')));
  assert.deepEqual(call.b.scopes, WORKER_SCOPES);
  assert.equal(await mintWorkerToken(api, {}), null);
});
