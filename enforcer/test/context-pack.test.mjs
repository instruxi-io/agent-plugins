import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'ctxpack-'));
process.env.HOME = tmp;
process.env.ENFORCER_STATE_DIR = join(tmp, 'state');
process.env.ENFORCER_CONFIG_HOME = join(tmp, 'cfg');
process.env.GRAPH_API_KEY = 'k';
process.env.GRAPH_ID = 'g1';
process.env.GRAPH_BASE_URL = 'http://127.0.0.1:1';
delete process.env.ENFORCER_CONTEXT_PACK;
const { sessionStart, rememberOnCompact, touchedFiles } = await import('../src/graph/hooks/session.mjs');
const { workerEnv } = await import('../src/dispatch/launch.mjs');
const { findConfig } = await import('../src/graph/hooks/common.mjs');
const { contextPackText } = await import('../src/graph/context-pack.mjs');
const { parseDispatchArgs } = await import('../src/dispatch/run.mjs');
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const BYTES = '# Decisions\n\nuse node:path\n';
const sha = createHash('sha256').update(BYTES).digest('hex');
const inp = { session_id: 's1', cwd: tmp, source: 'startup' };
const opts = (ctx, fetches = []) => ({
  health: false,
  env: {},
  warn: () => {},
  post: async (_c, _m, path) => (path.endsWith('/context') ? ctx : { data: [] }),
  getPack: async (_c, h, { cached }) => {
    fetches.push(h.slice(0, 4));
    return cached ? { status: 304, bytes: null } : { status: 200, bytes: Buffer.from(BYTES) };
  },
});
const ctxOf = (r) => r?.hookSpecificOutput?.additionalContext ?? '';

test('the session hook injects identical bytes for the same pack hash', async () => {
  const fetches = [];
  const o = opts({ data: { pack: { sha256: sha, file_id: 'f1' } } }, fetches);
  const a = ctxOf(await sessionStart(inp, o));
  const b = ctxOf(await sessionStart(inp, o));
  const head = `enforcer-graph context pack ${sha.slice(0, 12)}\n${BYTES}`;
  assert.ok(a.startsWith(head));
  assert.ok(b.startsWith(head));
  assert.equal(a.slice(0, head.length), b.slice(0, head.length));
  assert.equal(fetches.length, 2, 'second call revalidates');
  if (process.platform !== 'win32') assert.equal(statSync(join(tmp, 'state', 'context', `${sha}.md`)).mode & 0o777, 0o600);
});

test('no pack means no injection', async () => {
  assert.ok(!ctxOf(await sessionStart(inp, opts({ data: { context: { enabled: true } } }))).includes('context pack'));
  assert.ok(!ctxOf(await sessionStart(inp, opts({ data: { pack: {} } }))).includes('context pack'));
});

test('a fetch error injects nothing and says so once on stderr', async () => {
  const warns = [];
  const o = opts({ data: { pack: { sha256: 'a'.repeat(64), file_id: 'f2' } } });
  o.getPack = async () => {
    throw new Error('boom');
  };
  o.warn = (m) => warns.push(m);
  assert.ok(!ctxOf(await sessionStart(inp, o)).includes('context pack'));
  assert.equal(warns.length, 1);
});

test('context off suppresses the injection', async () => {
  const o = opts({ data: { pack: { sha256: sha, file_id: 'f1' } } });
  o.env = { ENFORCER_CONTEXT_PACK: '0' };
  assert.ok(!ctxOf(await sessionStart(inp, o)).includes('context pack'));
  assert.equal(workerEnv('g', {}, { context: 'off' }).ENFORCER_CONTEXT_PACK, '0');
  assert.equal(workerEnv('g', {}).ENFORCER_CONTEXT_PACK, '1');
  assert.equal(parseDispatchArgs(['g', '--context', 'off'], {}).context, 'off');
  assert.equal(parseDispatchArgs(['g'], {}).context, 'on');
  assert.throws(() => parseDispatchArgs(['g', '--context', 'x'], {}));
});

test('compaction writes a graph-scoped summary with the touched files', async () => {
  const { saveRun } = await import('../src/graph/run.mjs');
  const tp = join(tmp, 't.jsonl');
  const rec = (m) => JSON.stringify(m);
  writeFileSync(
    tp,
    [
      rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.mjs' } }] } }),
      rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'did the thing' }] } }),
    ].join('\n'),
  );
  assert.deepEqual(touchedFiles(tp), ['/a/b.mjs']);
  const ev = { session_id: 's9', cwd: tmp, transcript_path: tp, trigger: 'auto' };
  saveRun((await import('../src/graph/state.mjs')).actorKey(ev), { graph_id: 'g1', node_id: 'n1', key: 'k1', run_id: 'r1' });
  const calls = [];
  await rememberOnCompact(ev, async (_c, m, path, body) => (calls.push({ m, path, body }), { success: true }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/graphs/g1/observations');
  assert.equal(calls[0].body.kind, 'summary');
  assert.equal(calls[0].body.scope, 'graph');
  assert.deepEqual(calls[0].body.data.files, ['/a/b.mjs']);
  assert.equal(calls[0].body.data.node_key, 'k1');
  assert.equal(calls[0].body.data.run_id, 'r1');
  // an older service refuses graph scope: the node-scoped write follows
  const c2 = [];
  await rememberOnCompact(ev, async (_c, _m, path) => (c2.push(path), path === '/graphs/g1/observations' ? { ok: false, status: 404 } : { success: true }));
  assert.deepEqual(c2, ['/graphs/g1/observations', '/graphs/g1/nodes/n1/observations']);
});

test('workerEnv carries the base url', () => {
  assert.equal(workerEnv('g', { ENFORCER_BASE_URL: 'https://x.example' }).ENFORCER_BASE_URL, 'https://x.example');
  assert.equal(workerEnv('g', {}, { baseUrl: 'https://y.example' }).ENFORCER_BASE_URL, 'https://y.example');
  assert.match(workerEnv('g', {}).ENFORCER_BASE_URL, /^https?:\/\/[^/]+$/, 'the resolved host root, with no api path');
});

test('findConfig falls back to the default host when only GRAPH_ID is set', () => {
  const saved = process.env.GRAPH_BASE_URL;
  delete process.env.GRAPH_BASE_URL;
  try {
    const cfg = findConfig(tmp);
    assert.equal(cfg.base_url, 'https://api.instruxi.dev');
    assert.equal(cfg.graph_id, 'g1');
  } finally {
    process.env.GRAPH_BASE_URL = saved;
  }
});

const serve = async (handler) => {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, inm: req.headers['if-none-match'], key: req.headers['x-api-key'] });
    handler(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
};

test('the pack is fetched from the graph route and injected byte-identical', async () => {
  const ctx = JSON.stringify({ data: { pack: { sha256: sha } } });
  const fx = await serve((req, res) => {
    if (req.url.endsWith('/context/pack')) {
      if (req.headers['if-none-match'] === `"${sha}"`) return res.writeHead(304, { ETag: `"${sha}"` }).end();
      return res.writeHead(200, { ETag: `"${sha}"`, 'Content-Type': 'text/markdown' }).end(BYTES);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(ctx);
  });
  try {
    rmSync(join(tmp, 'state', 'context'), { recursive: true, force: true });
    const cfg = { graph_id: 'g1', base_url: fx.base, api_key: 'worker-key' };
    const head = `enforcer-graph context pack ${sha.slice(0, 12)}\n${BYTES}`;
    const warns = [];
    assert.equal(await contextPackText(cfg, { env: {}, warn: (m) => warns.push(m) }), head);
    const packCalls = () => fx.seen.filter((c) => c.url === '/api/v1/graph/graphs/g1/context/pack');
    assert.equal(packCalls().length, 1);
    assert.equal(packCalls()[0].inm, undefined);
    assert.equal(packCalls()[0].key, 'worker-key');
    // 304: the cached copy is kept
    assert.equal(await contextPackText(cfg, { env: {}, warn: (m) => warns.push(m) }), head);
    assert.equal(packCalls().length, 2);
    assert.equal(packCalls()[1].inm, `"${sha}"`);
    assert.deepEqual(warns, []);
    assert.equal(readFileSync(join(tmp, 'state', 'context', `${sha}.md`), 'utf8'), BYTES);
  } finally {
    fx.close();
  }
});

test('every skip reason prints one stderr line', async () => {
  const reasons = async (cfg, o) => {
    const w = [];
    const r = await contextPackText(cfg, { env: { GRAPH_ID: 'g1' }, warn: (m) => w.push(m), ...o });
    assert.equal(r, null);
    assert.equal(w.length, 1, JSON.stringify(w));
    assert.match(w[0], /^enforcer-graph: context pack not injected \(.+\)$/);
    return w[0];
  };
  const cfg = { graph_id: 'g1', base_url: 'http://x', api_key: 'k' };
  const withPack = async () => ({ data: { pack: { sha256: 'b'.repeat(64) } } });
  assert.match(await reasons(null, {}), /no base url/);
  assert.match(await reasons(cfg, { env: { GRAPH_ID: 'g1', ENFORCER_CONTEXT_PACK: '0' } }), /switched off/);
  assert.match(await reasons(cfg, { post: async () => ({ data: {} }) }), /no pack on the graph/);
  assert.match(await reasons(cfg, { post: withPack, getPack: async () => ({ status: 404, bytes: null }) }), /no pack on the graph/);
  assert.match(await reasons(cfg, { post: withPack, getPack: async () => ({ status: 403, bytes: null }) }), /HTTP 403/);
  assert.match(await reasons(cfg, { post: withPack, getPack: async () => ({ status: 200, bytes: Buffer.from('other') }) }), /sha mismatch/);
});
