import test from 'node:test';
import assert from 'node:assert/strict';
import { workerEnv, launchCmd, endpointEnv, routeToken, ENDPOINT_DROP, ENDPOINT_MODEL_VARS } from '../../src/dispatch/launch.mjs';
import { scrubSecrets } from '../../src/dispatch/logs.mjs';
import { validateRoutes } from '../../src/dispatch/routes.mjs';
import { routeFor } from '../../src/dispatch/model.mjs';
import { defaultArgs } from '../../src/dispatch/run.mjs';

const TOKEN = 'sk-route-endpoint-0123456789';
const operator = {
  PATH: '/bin',
  HOME: '/h',
  LANG: 'C',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-operator-subscription',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  ANTHROPIC_API_KEY: 'sk-ant-operator-key',
  GPU1_TOKEN: TOKEN,
};
const table = () =>
  validateRoutes(
    JSON.stringify({
      version: 1,
      routes: {
        mechanical: {
          harness: 'claude',
          model: 'Qwen3.8-27B',
          endpoint: { url: 'http://gpu1:8000', api: 'anthropic', token_env: 'GPU1_TOKEN' },
          fallback: 'wait',
        },
        standard: { harness: 'claude', model: 'sonnet' },
      },
    }),
    'test',
    { env: operator },
  );
const node = (tier) => ({ key: `n-${tier}`, data: { tier } });

test('a claude endpoint route drops the OAuth token and sets ANTHROPIC_BASE_URL', () => {
  const route = routeFor(node('mechanical'), table(), defaultArgs());
  assert.equal(route.endpoint.url, 'http://gpu1:8000');
  const e = workerEnv('g1', operator, { route });
  for (const k of ENDPOINT_DROP) assert.equal(e[k], undefined, `${k} must not reach the worker`);
  assert.equal(e.ANTHROPIC_BASE_URL, 'http://gpu1:8000');
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, TOKEN);
  for (const k of ENDPOINT_MODEL_VARS) assert.equal(e[k], 'Qwen3.8-27B', k);
  assert.equal(e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  // token_env names the variable; the variable itself is not passed under its own name
  assert.equal(e.GPU1_TOKEN, undefined);
});

test('the endpoint token never appears in argv', () => {
  const route = routeFor(node('mechanical'), table(), defaultArgs());
  const cmd = launchCmd('PROMPT', route.model, { ...defaultArgs(), harness: 'claude', agentBin: 'claude' }, 'n-mechanical', { harness: route.harness });
  assert.ok(cmd.includes('Qwen3.8-27B'), 'the route model is on the command line');
  assert.ok(!cmd.some((x) => String(x).includes(TOKEN)), 'no argv element carries the token');
  // it reaches the worker only through the environment, and is registered for log redaction
  assert.equal(routeToken(route, operator), TOKEN);
  workerEnv('g1', operator, { route });
  assert.equal(scrubSecrets(`launch n-mechanical token ${TOKEN}`)[0], 'launch n-mechanical token [redacted:secret]');
});

test('a route without an endpoint leaves the env unchanged', () => {
  const before = workerEnv('g1', operator);
  const route = routeFor(node('standard'), table(), defaultArgs());
  assert.equal(route.endpoint, null);
  assert.deepEqual(workerEnv('g1', operator, { route }), before);
  assert.equal(before.CLAUDE_CODE_OAUTH_TOKEN, operator.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(before.ANTHROPIC_BASE_URL, undefined);
  // and with no table at all
  assert.deepEqual(workerEnv('g1', operator, { route: routeFor(node('mechanical'), null, defaultArgs()) }), before);
});

test('an endpoint route without token_env sends the placeholder, never the operator login', () => {
  const e = endpointEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, { harness: 'claude', model: 'm', endpoint: { url: 'http://h:1', api: 'anthropic' } }, {});
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, 'none');
  assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('only claude has an endpoint environment', () => {
  assert.throws(
    () => endpointEnv({}, { harness: 'grok', model: 'grok-4', endpoint: { url: 'http://h:1', api: 'openai' } }, {}),
    /grok cannot use a custom endpoint/,
  );
});
