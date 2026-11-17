// `node --test test/dispatch/codex-usage.test.mjs`: after a codex worker exits, the dispatcher posts its run's token
// usage (POST /graphs/{g}/nodes/{n}/runs/{r}/usage) as the run's claimant. Fake API, fake codex binary: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexRunUsage } from '../../src/dispatch/harness/codex.mjs';
import { ADAPTERS } from '../../src/dispatch/harness/index.mjs';
import { API, APIError, usageRouteMissing } from '../../src/dispatch/api.mjs';
import { summarize } from '../../src/dispatch/summarize.mjs';
import { Dispatcher, defaultArgs } from '../../src/dispatch/run.mjs';

const FIX = (n) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
const RUN = '0f6c2a1e-6b7d-4c3e-9a8b-1d2e3f4a5b6c';
const tmp = () => mkdtempSync(join(tmpdir(), 'cu-'));

/** A codex --json stream that claims RUN through graph_next_work, then reports, over two turns with usage. */
const STREAM = [
  { type: 'thread.started', thread_id: '019a7c2e-4b1d-7f20-9a3e-5c2d8e1f0a11' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'i1',
      type: 'mcp_tool_call',
      server: 'enforcer',
      tool: 'graph_next_work',
      arguments: {},
      result: { content: [{ type: 'text', text: JSON.stringify({ node_id: 'id-k', run_id: RUN }) }] },
      status: 'completed',
    },
  },
  { type: 'turn.completed', usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 300, reasoning_output_tokens: 120 } },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'i2',
      type: 'mcp_tool_call',
      server: 'enforcer',
      tool: 'graph_report',
      arguments: { status: 'succeeded' },
      result: { content: [] },
      status: 'completed',
    },
  },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'done' } },
  { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 200, reasoning_output_tokens: 80 } },
];
const streamFile = (events = STREAM) => {
  const p = join(tmp(), 'k.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
};
const EXPECTED = {
  model: 'qwen3.8-flash-next',
  input_tokens: 3000, // (10000 + 5000) - (8000 + 4000)
  output_tokens: 500, // reasoning is inside output: not added
  cache_read_input_tokens: 12000,
  cache_creation_input_tokens: 0,
  turns: 3,
  source: 'reported',
};

// ---- mapping

test('mapping: codex input includes cached reads; graph input excludes them; reasoning stays inside output; no cost', () => {
  const s = summarize(streamFile(), 'codex');
  assert.deepEqual(codexRunUsage(s, { model: 'qwen3.8-flash-next' }), EXPECTED);
});

test('mapping: the recorded fixtures', () => {
  // codex-exec-route.jsonl: input 18342, cached 12288, output 214 (reasoning 96 inside it), no cache_write
  const route = codexRunUsage(summarize(FIX('codex-exec-route.jsonl'), 'codex'), { model: 'qwen3.8-flash-next' });
  assert.equal(route.input_tokens, 18342 - 12288);
  assert.equal(route.cache_read_input_tokens, 12288);
  assert.equal(route.cache_creation_input_tokens, 0);
  assert.equal(route.output_tokens, 214);
  assert.equal(route.source, 'reported');
  assert.ok(!('cost_usd' in route));
  // codex-exec.jsonl carries cache_write_input_tokens: 0, read through as cache_creation_input_tokens
  const s = summarize(FIX('codex-exec.jsonl'), 'codex');
  assert.equal(s.usage.cache_creation_input_tokens, 0);
  assert.equal(codexRunUsage(s, { model: 'gpt-5' }).input_tokens, 41849 - 35456);
});

test('mapping: cached (and cache writes) above input floor input_tokens at 0; cache writes are subtracted', () => {
  const over = codexRunUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 150, output_tokens: 7 }, turns: 1 }, { model: 'm' });
  assert.equal(over.input_tokens, 0);
  assert.equal(over.cache_read_input_tokens, 150);
  const w = codexRunUsage({ usage: { input_tokens: 1000, cache_read_input_tokens: 600, cache_creation_input_tokens: 300, output_tokens: 1 } }, {});
  assert.equal(w.input_tokens, 100);
  assert.equal(w.cache_creation_input_tokens, 300);
  assert.ok(!('model' in w) && !('turns' in w));
});

test('mapping: a stream with no usage is null (not reported), never zeros', () => {
  const none = [STREAM[0], STREAM[2], { type: 'turn.completed' }];
  assert.equal(codexRunUsage(summarize(streamFile(none), 'codex'), { model: 'm' }), null);
  assert.equal(codexRunUsage({ usage: {} }, { model: 'm' }), null);
  assert.equal(codexRunUsage({}, { model: 'm' }), null);
  assert.equal(codexRunUsage(summarize('/nonexistent/x.jsonl', 'codex'), { model: 'm' }), null);
});

test('only codex opts in to usageAfterExit; claude reports through its hooks', () => {
  assert.equal(typeof ADAPTERS.codex.usageAfterExit, 'function');
  for (const h of ['claude', 'gemini', 'grok']) assert.equal(ADAPTERS[h].usageAfterExit, undefined, h);
});

test('usageRouteMissing: 405, or a 404 that is not graph/node/run_not_found', () => {
  assert.ok(usageRouteMissing(new APIError(405, '')));
  assert.ok(usageRouteMissing(new APIError(404, 'Cannot POST /graphs/g/nodes/n/runs/r/usage')));
  assert.ok(usageRouteMissing(new APIError(404, '{"error":"not_found"}')));
  assert.ok(!usageRouteMissing(new APIError(404, '{"error":{"code":"run_not_found","detail":"no such run"}}')));
  assert.ok(!usageRouteMissing(new APIError(404, '{"error":"graph_not_found"}')));
  assert.ok(!usageRouteMissing(new APIError(409, '')));
  assert.ok(!usageRouteMissing(new Error('x')));
});

// ---- Dispatcher.recordUsage

/** A fake graph client: records usage posts and completes; `fail` makes recordUsage throw it. */
class FakeAPI {
  constructor(fail = null) {
    this.fail = fail;
    this.posts = [];
    this.completed = [];
  }
  async recordUsage(g, n, r, body) {
    this.posts.push({ g, n, r, body });
    if (this.fail) throw this.fail;
    return {};
  }
  async complete(g, n, r, body) {
    this.completed.push({ n, r, body });
    return {};
  }
}

function dispatcher(api, lines) {
  const state = tmp();
  const d = new Dispatcher(api, defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none') }), () => {});
  d.say = (m) => lines.push(m);
  return d;
}
const worker = (over = {}) => ({
  kind: 'agent',
  key: 'k',
  node: { id: 'id-k', key: 'k', type: 'task', data: {} },
  logPath: streamFile(),
  harness: 'codex',
  model: 'qwen3.8-flash-next',
  endpoint: { url: 'http://spark:8000' },
  ...over,
});

test('recordUsage: posts the run usage once, on the run from the stream, with the mapped body, and logs one line', async () => {
  const api = new FakeAPI();
  const lines = [];
  const d = dispatcher(api, lines);
  const body = await d.recordUsage(worker(), api);
  assert.deepEqual(api.posts, [{ g: 'g', n: 'id-k', r: RUN, body: EXPECTED }]);
  assert.deepEqual(body, EXPECTED);
  assert.deepEqual(lines, [`usage k: recorded run=${RUN} input=3000 cache_read=12000 cache_creation=0 output=500 turns=3`]);
  assert.equal(api.completed.length, 0);
});

test('recordUsage: the real client posts to /graphs/{g}/nodes/{n}/runs/{r}/usage as the worker credential', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return new Response('{"data":{}}', { status: 200 });
  };
  const op = new API('http://graph.test/api/v1/graph', { headers: async () => ({ Authorization: 'Bearer operator' }), fetchImpl, retries: 0 });
  const lines = [];
  const d = dispatcher(op, lines);
  await d.recordUsage(worker(), d.claimantApi('wk_minted_token'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, `http://graph.test/api/v1/graph/graphs/g/nodes/id-k/runs/${RUN}/usage`);
  assert.equal(seen[0].headers['X-API-Key'], 'wk_minted_token');
  assert.ok(!('Authorization' in seen[0].headers), 'not the dispatcher identity');
  assert.deepEqual(seen[0].body, EXPECTED);
  // no worker credential: the worker spoke as the dispatcher's own sign-in, and so does the post
  assert.equal(d.claimantApi(null), op);
});

test('recordUsage: no usage in the stream or no run id is skipped with one line and no post', async () => {
  const api = new FakeAPI();
  const lines = [];
  const d = dispatcher(api, lines);
  await d.recordUsage(worker({ logPath: streamFile([STREAM[0], STREAM[2], { type: 'turn.completed' }]) }), api);
  await d.recordUsage(worker({ logPath: streamFile([STREAM[0], STREAM[3]]) }), api);
  assert.equal(api.posts.length, 0);
  assert.deepEqual(lines, [`usage k: skipped: the stream reported no usage (run ${RUN})`, 'usage k: skipped: no run id in the stream']);
});

for (const [status, body] of [
  [404, 'Cannot POST /graphs/g/nodes/id-k/runs/x/usage'],
  [405, ''],
]) {
  test(`recordUsage: a ${status} (server without the route) is skipped and said once per dispatcher`, async () => {
    const api = new FakeAPI(new APIError(status, body));
    const lines = [];
    const d = dispatcher(api, lines);
    assert.equal(await d.recordUsage(worker(), api), null);
    assert.equal(await d.recordUsage(worker({ key: 'k2' }), api), null);
    assert.equal(api.posts.length, 2);
    assert.deepEqual(lines, [`usage k: skipped: this graph server has no run usage route (HTTP ${status}); said once`]);
    assert.equal(api.completed.length, 0, 'the node is not failed');
  });
}

test('recordUsage: any other error is logged each time and never fails the node or throws', async () => {
  for (const err of [
    new APIError(403, '{"error":{"code":"not_run_claimant"}}'),
    new APIError(404, '{"error":"run_not_found"}'),
    new APIError('network', 'down'),
  ]) {
    const api = new FakeAPI(err);
    const lines = [];
    const d = dispatcher(api, lines);
    assert.equal(await d.recordUsage(worker(), api), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^usage k: could not record on run ${RUN}: HTTP `));
    assert.equal(api.completed.length, 0);
  }
});

test('recordUsage: a claude worker is untouched (no post, no line)', async () => {
  const api = new FakeAPI();
  const lines = [];
  const d = dispatcher(api, lines);
  assert.equal(await d.recordUsage(worker({ harness: 'claude', logPath: FIX('dispatch/grok-ok.json') }), api), null);
  assert.equal(await d.recordUsage(worker({ harness: undefined }), api), null);
  assert.equal(api.posts.length, 0);
  assert.deepEqual(lines, []);
});

// ---- launch: posted after exit, on the minted worker credential, before that credential is revoked

test('launch: a codex worker that exits has its usage posted as its minted credential, before the revoke', async () => {
  const state = tmp();
  const fake = join(state, 'fake-codex.mjs');
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(STREAM.map((e) => JSON.stringify(e)).join('\n') + '\n')});\n`);
  chmodSync(fake, 0o755);
  const order = [];
  const graph = {
    graph: async () => ({}),
    call: async () => ({}),
  };
  const v3 = {
    call: async (m, p) => {
      order.push(`${m} ${p}`);
      return m === 'POST' ? { data: { secret: 'wk_minted_0123456789', credential: { id: 'cred-1' } } } : {};
    },
  };
  const lines = [];
  const args = defaultArgs({
    graph: 'g',
    stateDir: state,
    stopFile: join(state, 'STOP'),
    repoRoot: join(state, 'none'),
    harness: 'codex',
    experimental: true,
    codex: fake,
    model: 'gpt-5',
    agentKey: 'ag_DISPATCHER0123456789',
  });
  const d = new Dispatcher(graph, args, () => {}, v3);
  mkdirSync(d.logs, { recursive: true });
  d.say = (m) => lines.push(m);
  d.drainLane = async () => {};
  d.workerApi = (token) => ({
    recordUsage: async (g, n, r, body) => {
      order.push(`usage as ${token} ${n} ${r} input=${body.input_tokens}`);
      return {};
    },
  });
  const keep = process.env.ENFORCER_WORKER_AGENT_ID;
  process.env.ENFORCER_WORKER_AGENT_ID = 'agent-w';
  try {
    await d.launch({ key: 'k', id: 'id-k', type: 'task', title: 't', data: {} }, {});
  } finally {
    if (keep === undefined) delete process.env.ENFORCER_WORKER_AGENT_ID;
    else process.env.ENFORCER_WORKER_AGENT_ID = keep;
  }
  const w = d.workers.get('k');
  assert.ok(w, lines.join('\n'));
  // the worker is unref'd: a pending timer keeps the loop alive while it runs and the done chain posts and revokes
  for (let i = 0; i < 500 && !order.some((o) => o.startsWith('DELETE')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    order,
    ['POST /agents/agent-w/credentials', `usage as wk_minted_0123456789 id-k ${RUN} input=3000`, 'DELETE /agents/agent-w/credentials/cred-1'],
    lines.join('\n'),
  );
  assert.ok(
    lines.some((l) => l.startsWith(`usage k: recorded run=${RUN} `)),
    lines.join('\n'),
  );
});
