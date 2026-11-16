// `node --test test/dispatch/routes.test.mjs`: the route table (docs/graph/ROUTES.md items 1-3 and 6): sources,
// validation, routeFor precedence, the /v1/models probe and its cache, the per-route fallback, and the preflight lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dispatcher, defaultArgs, parseDispatchArgs, routeMeta } from '../../src/dispatch/run.mjs';
import { routeFor, modelFor, TIER_MODEL } from '../../src/dispatch/model.mjs';
import { validateRoutes, loadRoutes, probeEndpoint, ProbeCache, resolveRoute, routeNote, routeLines, RouteError } from '../../src/dispatch/routes.mjs';
import { workerRouteText, endpointLines } from '../../src/dispatch-command.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'routes-'));
const mkArgs = (state, o = {}) =>
  defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), killGrace: 0.2, ...o });
const GPU = { url: 'http://gpu1:8000', api: 'anthropic' };
const table = (routes) => validateRoutes({ version: 1, routes }, 'test');
const node = (key, data = {}) => ({ id: 'id-' + key, key, type: 'task', status: 'ready', data });
const down = (reason = 'HTTP 502') => new ProbeCache({ probe: async () => ({ ok: false, reason, ids: null }) });
const serving = (...ids) => new ProbeCache({ probe: async () => ({ ok: true, reason: null, ids }) });
class FakeAPI {
  async nodes() {
    return [];
  }
  async runs() {
    return [];
  }
}

// ---- the four the acceptance names

test('node data.harness overrides the route', () => {
  const t = table({ standard: { harness: 'claude', model: 'Qwen3-Coder', endpoint: GPU } });
  const r = routeFor(node('k', { tier: 'standard', harness: 'grok' }), t, { harness: 'claude' });
  assert.equal(r.harness, 'grok');
  assert.equal(r.source.harness, 'node');
  // the route's endpoint and its model go with it: a vLLM model name means nothing to grok
  assert.equal(r.endpoint, null);
  assert.notEqual(r.model, 'Qwen3-Coder');
  assert.equal(r.route, null);
  // the same harness as the route keeps the route
  const same = routeFor(node('k', { tier: 'standard', harness: 'claude' }), t, { harness: 'claude' });
  assert.equal(same.endpoint?.url, 'http://gpu1:8000');
  assert.equal(same.model, 'Qwen3-Coder');
});

test('a down endpoint with fallback wait holds the node', async () => {
  const lines = [];
  const d = new Dispatcher(new FakeAPI(), mkArgs(tmp()), (m) => lines.push(m));
  d.routes = table({ standard: { harness: 'claude', model: 'Qwen3-Coder', endpoint: GPU, fallback: 'wait' } });
  d.probes = down('unreachable (ECONNREFUSED)');
  const n = node('fix-typo', { tier: 'standard' });
  assert.equal(await d.launch(n), 'held');
  assert.equal(d.workers.size, 0, 'nothing launched');
  assert.equal(d.attempts.get('fix-typo'), undefined, 'no attempt spent');
  d.noteHolds();
  d.noteHolds(); // once per 10 minutes, not once per pass
  const said = lines.filter((l) => l.includes('holding'));
  assert.equal(said.length, 1, lines.join('\n'));
  assert.match(said[0], /route standard: endpoint http:\/\/gpu1:8000 down \(unreachable \(ECONNREFUSED\)\); holding fix-typo/);
  // the default fallback is wait too
  assert.equal(table({ deep: { model: 'm', endpoint: GPU } }).routes.deep.fallback, 'wait');
});

test('a down endpoint with a fallback route reroutes', async () => {
  const t = table({
    mechanical: { harness: 'claude', model: 'Qwen3-Coder', endpoint: GPU, fallback: 'route:deep' },
    deep: { harness: 'claude', model: 'opus' },
    standard: { harness: 'claude', model: 'Qwen3-Coder', endpoint: GPU, fallback: 'route:claude' },
  });
  const pick = await resolveRoute(node('k', { tier: 'mechanical' }), t, { harness: 'claude' }, down());
  assert.equal(pick.hold, false);
  assert.equal(pick.route.harness, 'claude');
  assert.equal(pick.route.model, 'opus');
  assert.equal(pick.route.endpoint, null);
  assert.equal(pick.fallbackFrom.route, 'mechanical');
  assert.equal(routeNote(pick.route, pick.fallbackFrom), 'route=mechanical->fallback:deep (endpoint down: HTTP 502)');
  // route:<harness>: that harness on its provider, the tier's model (or --model)
  const h = await resolveRoute(node('k', { tier: 'standard' }), t, { harness: 'claude' }, down());
  assert.deepEqual([h.route.harness, h.route.model, h.route.endpoint], ['claude', 'sonnet', null]);
  assert.equal(routeNote(h.route, h.fallbackFrom), 'route=standard->fallback:claude (endpoint down: HTTP 502)');
  const capped = await resolveRoute(node('k', { tier: 'standard' }), t, { harness: 'claude', model: 'haiku' }, down());
  assert.equal(capped.route.model, 'haiku');
  // up: the endpoint route itself
  const up = await resolveRoute(node('k', { tier: 'mechanical' }), t, { harness: 'claude' }, serving('Qwen3-Coder'));
  assert.equal(up.route.endpoint.url, 'http://gpu1:8000');
  assert.equal(up.fallbackFrom, null);
  // and the worker records it (pids.json meta)
  assert.deepEqual(routeMeta({ harness: 'claude', model: 'opus', tier: 'mechanical', route: 'deep', fallbackFrom: pick.fallbackFrom }), {
    harness: 'claude',
    model: 'opus',
    tier: 'mechanical',
    route: 'deep',
    fallback_from: 'mechanical',
    fallback_reason: 'HTTP 502',
  });
});

test('a route naming an experimental harness without the flag fails startup', async () => {
  const state = tmp();
  const file = join(state, 'routes.json');
  writeFileSync(file, JSON.stringify({ version: 1, routes: { mechanical: { harness: 'codex' } } }));
  const lines = [];
  // FakeAPI has no lease methods: reaching the lease would throw, so exit 5 proves nothing was claimed
  const d = new Dispatcher(new FakeAPI(), mkArgs(state, { routesFile: file }), (m) => lines.push(m));
  assert.equal(await d.run(), 5);
  assert.match(lines.join('\n'), /routes\.mechanical\.harness: --harness codex is experimental/);
  // experimental grok needs --experimental, per route as for the flag
  assert.throws(() => table({ deep: { harness: 'grok' } }), /routes\.deep\.harness: --harness grok is experimental/);
  assert.throws(() => table({ deep: { harness: 'gemini' } }), /routes\.deep\.harness: --harness gemini is experimental/);
  assert.throws(() => table({ deep: { harness: 'nope' } }), /routes\.deep\.harness: must be one of claude, codex, grok, gemini/);
});

// ---- validation

test('the table is validated with the field named', () => {
  const env = { GPU_TOKEN: 'secret-value' };
  const v = (routes, o = {}) => validateRoutes({ version: 1, routes }, 'f.json', { env, ...o });
  assert.throws(() => validateRoutes('{', 'f.json'), /routes: f\.json: not valid JSON/);
  assert.throws(() => validateRoutes({ version: 2, routes: {} }, 'f.json'), /version must be 1/);
  assert.throws(() => v({ Bad: {} }), /routes\.Bad: unknown route name/);
  assert.throws(() => v({ claude: { model: 'sonnet' } }), /route name claude is a harness/);
  assert.throws(() => v({ deep: { modle: 'opus' } }), /routes\.deep\.modle: unknown field/);
  assert.throws(() => v({ deep: { harness: 'grok', model: 'opus' } }, { experimental: true }), /routes\.deep\.model: opus is not a grok model/);
  assert.throws(() => v({ deep: { model: 'm', endpoint: { url: 'gpu1:8000', api: 'anthropic' } } }), /routes\.deep\.endpoint\.url/);
  assert.throws(() => v({ deep: { model: 'm', endpoint: { url: 'http://h/v1', api: 'anthropic' } } }), /routes\.deep\.endpoint\.url/);
  assert.throws(() => v({ deep: { model: 'm', endpoint: { url: 'http://h', api: 'grpc' } } }), /endpoint\.api: must be anthropic or openai/);
  assert.throws(() => v({ deep: { model: 'm', endpoint: { url: 'http://h', api: 'openai' } } }), /endpoint\.api: claude cannot speak openai/);
  assert.throws(
    () => v({ deep: { harness: 'grok', model: 'grok', endpoint: { url: 'http://h', api: 'openai' } } }, { experimental: true }),
    /grok cannot use a custom endpoint/,
  );
  assert.throws(() => v({ deep: { model: 'm', endpoint: { ...GPU, token_env: 'MISSING_TOKEN' } } }), /token_env: MISSING_TOKEN is not set/);
  assert.throws(() => v({ deep: { model: 'm', endpoint: { ...GPU, token_env: 'sk-abc123' } } }), /token_env: must be a variable name, not a token/);
  assert.throws(() => v({ deep: { fallback: 'retry' } }), /routes\.deep\.fallback: must be wait or route:<route\|harness>/);
  assert.throws(() => v({ deep: { fallback: 'route:missing' } }), /routes\.deep\.fallback: must be wait or route:<route\|harness>/);
  assert.throws(() => v({ deep: { fallback: 'route:codex' } }), /routes\.deep\.fallback: --harness codex is experimental/);
  assert.throws(
    () => v({ mechanical: { model: 'm', endpoint: GPU, fallback: 'route:standard' }, standard: { model: 'm', endpoint: GPU, fallback: 'route:mechanical' } }),
    /forms a cycle \(mechanical -> standard -> mechanical\)/,
  );
  const ok = v({ mechanical: { model: 'Qwen', endpoint: { url: 'http://gpu1:8000/', api: 'anthropic', token_env: 'GPU_TOKEN' }, fallback: 'route:claude' } });
  assert.deepEqual(ok.routes.mechanical.endpoint, { url: 'http://gpu1:8000', api: 'anthropic', token_env: 'GPU_TOKEN' });
  // a RouteError is a usage error: exit 5
  try {
    v({ huge: {} });
  } catch (e) {
    assert.ok(e instanceof RouteError);
    assert.equal(e.exitCode, 5);
  }
});

test('the first source found is the whole table', () => {
  const home = tmp();
  mkdirSync(join(home, 'dispatch'), { recursive: true });
  const cfg = join(home, 'dispatch', 'routes.json');
  writeFileSync(cfg, JSON.stringify({ version: 1, routes: { deep: { model: 'opus' } } }));
  const flagFile = join(home, 'flag.json');
  writeFileSync(flagFile, JSON.stringify({ version: 1, routes: { mechanical: { model: 'haiku' } } }));
  const envFile = join(home, 'env.json');
  writeFileSync(envFile, JSON.stringify({ version: 1, routes: { standard: { model: 'sonnet' } } }));
  const base = { ENFORCER_CONFIG_HOME: home };
  assert.equal(loadRoutes({ file: flagFile, env: { ...base, ENFORCER_ROUTES: envFile } }).source, flagFile);
  assert.equal(loadRoutes({ env: { ...base, ENFORCER_ROUTES: envFile } }).source, envFile);
  const g = loadRoutes({ env: base, graphRoutes: { untiered: { model: 'sonnet' } } });
  assert.equal(g.source, 'graph node_defaults.routes');
  assert.deepEqual(Object.keys(g.table.routes), ['untiered']);
  assert.equal(loadRoutes({ env: base }).source, cfg);
  assert.deepEqual(loadRoutes({ env: { ENFORCER_CONFIG_HOME: tmp() } }), { table: null, source: null });
  assert.equal(loadRoutes({ noRoutes: true, file: flagFile, env: base }).table, null);
  assert.throws(() => loadRoutes({ file: join(home, 'nope.json'), env: base }), /cannot read: ENOENT/);
});

test('the runner takes --routes, --no-routes and --route-probe-ttl', () => {
  const a = parseDispatchArgs(['g', '--routes', '/r.json', '--route-probe-ttl', '30'], {});
  assert.deepEqual([a.routesFile, a.noRoutes, a.routeProbeTtl], ['/r.json', false, 30]);
  assert.equal(parseDispatchArgs(['g', '--no-routes'], {}).noRoutes, true);
  assert.equal(parseDispatchArgs(['g'], {}).routeProbeTtl, 60);
  assert.throws(() => parseDispatchArgs(['g', '--route-probe-ttl', 'x'], {}), /--route-probe-ttl/);
  assert.throws(() => parseDispatchArgs(['g', '--routes', 'r', '--no-routes'], {}), /cannot be used together/);
});

// ---- precedence

test('with no table every field resolves as before', () => {
  for (const data of [{}, { tier: 'mechanical' }, { tier: 'deep' }, { tier: 'deep', tier_source: 'user' }, { model: 'opus' }])
    for (const model of [null, 'haiku']) {
      const r = routeFor(node('k', data), null, { harness: 'claude', model });
      assert.equal(r.model, modelFor(node('k', data), model));
      assert.equal(r.harness, 'claude');
      assert.equal(r.endpoint, null);
    }
  assert.equal(routeFor(node('k'), null, { harness: 'grok' }).harness, 'grok');
});

test('--model caps route models without an endpoint, never data.model or an endpoint model', () => {
  const t = table({ deep: { model: 'opus' }, standard: { model: 'Qwen', endpoint: GPU }, mechanical: { model: 'haiku' } });
  const args = { harness: 'claude', model: 'sonnet' };
  assert.equal(routeFor(node('k', { tier: 'deep' }), t, args).model, 'sonnet');
  assert.equal(routeFor(node('k', { tier: 'deep', tier_source: 'user' }), t, args).model, 'opus');
  assert.equal(routeFor(node('k', { tier: 'deep', model: 'opus' }), t, args).model, 'opus');
  assert.equal(routeFor(node('k', { tier: 'standard' }), t, args).model, 'Qwen');
  assert.equal(routeFor(node('k', { tier: 'mechanical' }), t, args).model, 'haiku');
  // a node with no known tier takes the untiered route
  const u = table({ untiered: { model: 'haiku' } });
  assert.equal(routeFor(node('k', { tier: 'enormous' }), u, { harness: 'claude' }).model, 'haiku');
  assert.equal(routeFor(node('k', { tier: 'enormous' }), u, { harness: 'claude' }).tier, 'untiered');
});

// ---- the probe

test('the probe reads /v1/models and names why an endpoint is down', async () => {
  const calls = [];
  const res = (status, body) => async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(body, { status });
  };
  const ep = { url: 'http://gpu1:8000', api: 'anthropic', token_env: 'GPU_TOKEN' };
  const env = { GPU_TOKEN: 'tok-1' };
  const up = await probeEndpoint(ep, { env, fetchImpl: res(200, JSON.stringify({ data: [{ id: 'Qwen' }] })) });
  assert.deepEqual(up, { ok: true, reason: null, ids: ['Qwen'] });
  assert.equal(calls[0].url, 'http://gpu1:8000/v1/models');
  assert.equal(calls[0].headers['x-api-key'], 'tok-1');
  assert.equal(calls[0].headers.authorization, 'Bearer tok-1');
  assert.equal((await probeEndpoint(ep, { env, fetchImpl: res(503, 'busy') })).reason, 'HTTP 503');
  assert.equal((await probeEndpoint(ep, { env, fetchImpl: res(200, '<html>') })).reason, 'not JSON');
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const r = await probeEndpoint(ep, {
    env,
    fetchImpl: async () => {
      throw refused;
    },
  });
  assert.equal(r.reason, 'unreachable (ECONNREFUSED)');
  const c = serving('Llama');
  assert.deepEqual(await c.check(ep, 'Qwen'), { up: false, reason: 'model Qwen not served (serves: Llama)' });
});

test('the probe is cached per endpoint for the ttl', async () => {
  let t = 1000;
  let probes = 0;
  const c = new ProbeCache({
    ttl: 60,
    clock: () => t,
    probe: async () => {
      probes++;
      return { ok: true, reason: null, ids: ['Qwen', 'Llama'] };
    },
  });
  await c.check(GPU, 'Qwen');
  await c.check(GPU, 'Llama');
  t += 59;
  await c.check(GPU, 'Qwen');
  assert.equal(probes, 1);
  t += 1;
  await c.check(GPU, 'Qwen');
  assert.equal(probes, 2);
  c.clear(GPU.url);
  await c.check(GPU, 'Qwen');
  assert.equal(probes, 3);
  assert.equal(c.snapshot()[GPU.url].up, true);
});

// ---- preflight and status

test('preflight prints the source, one line per route and what --harness no longer decides', async () => {
  const t = table({ mechanical: { harness: 'claude', model: 'Qwen', endpoint: GPU, fallback: 'route:standard' }, deep: { model: 'opus' } });
  const L = await routeLines(
    { table: t, source: '/r.json' },
    { harness: 'claude', model: 'sonnet' },
    { probes: down(), nodes: [node('a', { tier: 'mechanical' }), node('b')] },
  );
  assert.equal(L[0], 'routes      from /r.json');
  assert.match(L.join('\n'), /^route       mechanical  claude Qwen .*anthropic http:\/\/gpu1:8000 .*DOWN: HTTP 502 .*fallback route:standard/m);
  assert.match(L.join('\n'), /^route       deep .*opus .*--model sonnet caps opus/m);
  assert.match(L.join('\n'), /^route-plan  2 nodes: mechanical 1, untiered 1$/m);
  const g = await routeLines({ table: table({ deep: { harness: 'claude' } }), source: 's' }, { harness: 'grok' });
  assert.match(g.join('\n'), /^route-note  --harness grok is overridden by routes for deep$/m);
  assert.deepEqual(await routeLines({ table: null, source: null }, { harness: 'claude' }), [
    "routes      none (today's behaviour: --harness claude, TIER_MODEL)",
  ]);
});

test('status shows the route a worker runs on and each endpoint', () => {
  assert.equal(workerRouteText(undefined, node('b', { tier: 'mechanical' })), 'script-or-haiku');
  assert.equal(workerRouteText(undefined, node('b', { tier: 'deep' })), 'opus');
  assert.equal(
    workerRouteText({ harness: 'claude', model: 'Qwen', route: 'mechanical', endpoint: 'http://gpu1:8000' }, node('b')),
    'claude Qwen @gpu1:8000 (mechanical)',
  );
  assert.equal(
    workerRouteText({ harness: 'claude', model: 'opus', route: 'deep', fallback_from: 'mechanical' }, node('b')),
    'claude opus (mechanical->fallback:deep, endpoint down)',
  );
  assert.deepEqual(endpointLines({ 'http://gpu1:8000': { up: false, reason: 'HTTP 502', since: 0, holding: ['a', 'b'] }, 'http://h': { up: true } }), [
    'endpoint http://gpu1:8000 DOWN since 00:00Z (HTTP 502); holding 2 nodes: a, b',
    'endpoint http://h up',
  ]);
});

// ---- named routes, private fail-closed, and the server tier map

const SPARK = { url: 'http://spark-dd15:8000', api: 'anthropic' };
const localTable = () =>
  table({
    local: { harness: 'claude', model: 'qwen3.8-flash-next', endpoint: SPARK, fallback: 'route:claude' },
    deep: { harness: 'claude', model: 'opus' },
  });
const hostedModel = (m) => /^claude-/i.test(String(m || '')) || ['haiku', 'sonnet', 'opus', 'script-or-haiku'].includes(String(m || ''));

test('data.route selects a named route', () => {
  const t = localTable();
  const r = routeFor(node('k', { tier: 'deep', route: 'Local' }), t, { harness: 'claude' });
  assert.equal(r.route, 'local');
  assert.equal(r.tier, 'deep');
  assert.equal(r.model, 'qwen3.8-flash-next');
  assert.equal(r.endpoint.url, 'http://spark-dd15:8000');
  assert.equal(r.source.model, 'route:local');
  assert.equal(r.unknown, false);
  // no data.route: the tier's route, as before
  const d = routeFor(node('k', { tier: 'deep' }), t, { harness: 'claude' });
  assert.equal(d.route, 'deep');
  assert.equal(d.model, 'opus');
});

test('an unknown route is refused and is not the tier route', async () => {
  const t = localTable();
  const pick = await resolveRoute(node('k', { tier: 'deep', route: 'spark' }), t, { harness: 'claude' }, down());
  assert.equal(pick.refuse, true);
  assert.equal(pick.hold, false);
  assert.equal(pick.fallbackFrom, null);
  assert.match(pick.reason, /unknown route spark/);
  const lines = [];
  const d = new Dispatcher(new FakeAPI(), mkArgs(tmp()), (m) => lines.push(m));
  d.routes = t;
  d.probes = down();
  assert.equal(await d.launch(node('k', { tier: 'deep', route: 'spark' })), 'refused');
  assert.equal(d.workers.size, 0);
  assert.equal(d.attempts.get('k'), undefined);
  assert.match(lines.join('\n'), /REFUSE k: unknown route spark/);
  assert.equal(
    lines.some((l) => /model=|claude-/.test(l)),
    false,
  );
});

test('a private node with its endpoint down waits and never uses a hosted model', async () => {
  const t = localTable();
  const n = node('k', { tier: 'mechanical', route: 'local', private: true });
  const pick = await resolveRoute(n, t, { harness: 'claude', model: 'sonnet' }, down('unreachable (ECONNREFUSED)'));
  assert.equal(pick.hold, true);
  assert.notEqual(pick.refuse, true);
  assert.equal(pick.fallbackFrom, null);
  assert.equal(pick.route.endpoint.url, 'http://spark-dd15:8000');
  assert.equal(pick.route.model, 'qwen3.8-flash-next');
  assert.equal(pick.route.harness, 'claude');
  assert.equal(hostedModel(pick.route.model), false);
  const lines = [];
  const d = new Dispatcher(new FakeAPI(), mkArgs(tmp()), (m) => lines.push(m));
  d.routes = t;
  d.probes = down('unreachable (ECONNREFUSED)');
  assert.equal(await d.launch(n), 'held');
  assert.equal(d.workers.size, 0);
  assert.equal(d.attempts.get('k'), undefined);
  d.noteHolds();
  const said = lines.join('\n');
  assert.match(said, /route local: endpoint http:\/\/spark-dd15:8000 down \(unreachable \(ECONNREFUSED\)\); holding k/);
  assert.equal(/fallback:claude|model=sonnet|model=opus|model=haiku|claude-/.test(said), false);
  // up: the endpoint route itself, still not a hosted model
  const up = await resolveRoute(n, t, { harness: 'claude' }, serving('qwen3.8-flash-next'));
  assert.equal(up.hold, false);
  assert.equal(up.refuse, false);
  assert.equal(up.route.model, 'qwen3.8-flash-next');
  assert.equal(up.fallbackFrom, null);
});

test('a private node with no endpoint route is refused', async () => {
  const hosted = table({ deep: { harness: 'claude', model: 'opus', fallback: 'route:claude' } });
  const pick = await resolveRoute(node('k', { tier: 'deep', private: true }), hosted, { harness: 'claude' }, down());
  assert.equal(pick.refuse, true);
  assert.equal(pick.hold, false);
  assert.match(pick.reason, /private node has no endpoint route/);
  const named = table({ local: { harness: 'claude', model: 'opus' } });
  const via = await resolveRoute(node('k', { route: 'local', private: true }), named, { harness: 'claude' }, down());
  assert.equal(via.refuse, true);
  assert.match(via.reason, /private node route local has no endpoint/);
  const none = await resolveRoute(node('k', { private: true, tier: 'standard' }), null, { harness: 'claude' }, null);
  assert.equal(none.refuse, true);
  assert.match(none.reason, /no endpoint route/);
  const banned = table({ local: { harness: 'claude', model: 'claude-haiku-4-5', endpoint: GPU, fallback: 'wait' } });
  const bad = await resolveRoute(node('k', { route: 'local', private: true }), banned, { harness: 'claude' }, serving('claude-haiku-4-5'));
  assert.equal(bad.refuse, true);
  assert.match(bad.reason, /hosted model \(claude-haiku-4-5\)/);
  const lines = [];
  const d = new Dispatcher(new FakeAPI(), mkArgs(tmp()), (m) => lines.push(m));
  d.routes = hosted;
  d.probes = down();
  assert.equal(await d.launch(node('k', { tier: 'deep', private: true })), 'refused');
  assert.equal(d.workers.size, 0);
  assert.equal(d.attempts.get('k'), undefined);
  assert.match(lines.join('\n'), /REFUSE k: private node has no endpoint route/);
  assert.equal(
    lines.some((l) => /^launch k/.test(l)),
    false,
  );
});

test('a non-private node keeps the tier route and the hosted fallback', async () => {
  const t = localTable();
  const open = await resolveRoute(node('k', { tier: 'mechanical', route: 'local' }), t, { harness: 'claude' }, down());
  assert.equal(open.hold, false);
  assert.notEqual(open.refuse, true);
  assert.equal(open.route.endpoint, null);
  assert.equal(open.route.harness, 'claude');
  assert.equal(open.route.model, 'script-or-haiku');
  assert.equal(open.fallbackFrom.target, 'claude');
  // no data.route and not private: the tier, and a down endpoint still falls through
  const tiered = table({ mechanical: { harness: 'claude', model: 'Qwen', endpoint: GPU, fallback: 'route:deep' }, deep: { model: 'opus' } });
  const fell = await resolveRoute(node('k', { tier: 'mechanical', private: false }), tiered, { harness: 'claude' }, down());
  assert.equal(fell.hold, false);
  assert.equal(fell.route.model, 'opus');
  assert.equal(fell.route.endpoint, null);
  const plain = await resolveRoute(node('k', { tier: 'standard' }), null, { harness: 'claude' }, null);
  assert.equal(plain.refuse, false);
  assert.equal(plain.hold, false);
  assert.equal(plain.route.model, 'sonnet');
  assert.equal(plain.route.endpoint, null);
});

test('the tier map matches enforcer-graph: mechanical is script-or-haiku', () => {
  assert.equal(TIER_MODEL.mechanical, 'script-or-haiku');
  assert.equal(TIER_MODEL.standard, 'sonnet');
  assert.equal(TIER_MODEL.deep, 'opus');
  assert.equal(modelFor(node('k', { tier: 'mechanical' })), 'script-or-haiku');
  assert.equal(modelFor(node('k', { tier: 'standard' })), 'sonnet');
  assert.equal(modelFor(node('k', { tier: 'deep' })), 'opus');
  assert.equal(routeFor(node('k', { tier: 'mechanical' }), null, { harness: 'claude' }).model, 'script-or-haiku');
});

test('the local Qwen example is a named endpoint route for spark-dd15', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../docs/graph/routes.local.example.json');
  const ex = validateRoutes(readFileSync(path, 'utf8'), 'routes.local.example.json', { experimental: true });
  assert.equal(ex.routes.local.harness, 'codex');
  assert.equal(ex.routes.local.model, 'qwen3.8-flash-next');
  assert.deepEqual(ex.routes.local.endpoint, { url: 'http://spark-dd15:8000', api: 'openai' });
  assert.equal(ex.routes.local.fallback, 'wait');
  assert.equal(ex.routes.local.endpoint.token_env, undefined);
});
