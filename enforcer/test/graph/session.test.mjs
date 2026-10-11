import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionStart, openRunGuard, rememberOnCompact, statusLines } from '../../src/graph/hooks/session.mjs';
import { report, lockedTools, unknownTools, MANIFEST_DIR } from '../../src/graph/hooks/version-check.mjs';
import { saveRun } from '../../src/graph/run.mjs';

let n = 0;
function fresh() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'session-'));
  process.env.ENFORCER_STATE_DIR = join(root, 'state');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'cc');
  process.env.ENFORCER_HOME = join(root, 'eh');
  delete process.env.GRAPH_ID;
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.enforcer'), { recursive: true });
  writeFileSync(join(proj, '.enforcer', 'graph.json'), JSON.stringify({ graph_id: 'g1', base_url: 'http://127.0.0.1:9' }));
  process.env.GRAPH_API_KEY = 'k';
  return { root, proj, sid: `s${++n}` };
}
const stub =
  (calls = []) =>
  async (cfg, method, path, body) => {
    calls.push([method, path, body]);
    if (path.endsWith('/frontier')) return { data: [{ key: 'api-contract' }, { key: 'legal' }] };
    if (path.includes('/nodes?'))
      return {
        data: [
          { key: 'a', status: 'running' },
          { key: 'b', status: 'failed' },
          { key: 'c', status: 'done' },
        ],
      };
    return {};
  };

test('session start prints the frontier from a stub', async () => {
  const { proj, sid } = fresh();
  const out = await sessionStart({ session_id: sid, cwd: proj, source: 'startup' }, { post: stub(), health: {} });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /frontier \(runnable now, not claimed\): api-contract, legal/);
  assert.match(ctx, /running: a/);
  assert.match(ctx, /failed.*: b/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('session start is silent with no graph config and on a failed fetch', async () => {
  const { root, proj, sid } = fresh();
  assert.equal(await sessionStart({ session_id: sid, cwd: root }, { post: stub(), health: {} }), null);
  assert.equal(await sessionStart({ session_id: sid, cwd: proj }, { post: async () => null, health: {} }), null);
});

test('version check reads the locked manifest', async () => {
  const known = lockedTools();
  assert.ok(known.has('graph_next_work'), 'the locked manifest names graph_next_work');
  assert.deepEqual(unknownTools({ version: '1', tools: [...known] }, known, '9'), []);
  const lines = unknownTools({ version: '1.2', tools: [...known, 'zeta', 'workspace_a', 'workspace_b'] }, known, '9');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /MCP 1\.2 serves tools this plugin \(9\) does not know: workspace_\*, zeta/);
  const { root } = fresh();
  assert.deepEqual(await report(join(root, 'cc'), 'instruxi', '9', null, 'http://x', null, { tools: [...known] }), []);
});

test('version check reports a stale install once', async () => {
  const { root, proj, sid } = fresh();
  const cc = join(root, 'cc'),
    mk = join(root, 'mkt');
  const md = MANIFEST_DIR;
  mkdirSync(join(cc, 'plugins'), { recursive: true });
  mkdirSync(join(mk, md), { recursive: true });
  mkdirSync(join(mk, 'enforcer', md), { recursive: true });
  writeFileSync(join(mk, md, 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'enforcer', source: './enforcer' }] }));
  writeFileSync(join(mk, 'enforcer', md, 'plugin.json'), JSON.stringify({ version: '9.1.0' }));
  writeFileSync(join(cc, 'plugins', 'known_marketplaces.json'), JSON.stringify({ instruxi: { installLocation: mk } }));
  writeFileSync(join(cc, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'enforcer@instruxi': [{ scope: 'user', version: '0.15.0' }] } }));
  const o = { post: async () => null, health: {} };
  const first = await sessionStart({ session_id: sid, cwd: root }, o);
  assert.match(first.systemMessage, /enforcer 0\.15\.0 installed \(user\) — 9\.1\.0 available: claude plugin update enforcer@instruxi/);
  assert.equal(await sessionStart({ session_id: sid, cwd: root }, o), null);
});

const hold = (sid, extra = {}) => saveRun(sid, { graph_id: 'g', node_id: 'n', key: 'k', run_id: 'run-1', ...extra });

test('open-run guard blocks a quoted graph_report', async () => {
  const { sid } = fresh();
  hold(sid);
  const r = await openRunGuard({ session_id: sid, last_assistant_message: 'I should call graph_report and reported this run' });
  assert.equal(r.decision, 'block');
});

test('open-run guard: marker passes, second stop passes, subagent blocks, no run is silent', async () => {
  const { sid } = fresh();
  hold(sid);
  assert.equal(await openRunGuard({ session_id: sid, last_assistant_message: 'Paused.\nstill running: run-1' }), null);
  assert.equal(await openRunGuard({ session_id: sid, last_assistant_message: 'x', stop_hook_active: true }), null);
  assert.equal(await openRunGuard({ session_id: 'nobody', last_assistant_message: 'x' }), null);
  const { createHash } = await import('node:crypto');
  hold(createHash('sha256').update('agent_id:ag-1').digest('hex').slice(0, 32));
  assert.equal((await openRunGuard({ session_id: sid, agent_id: 'ag-1', last_assistant_message: 'done' })).decision, 'block');
});

test('remember on compact posts one graph-scoped summary observation', async () => {
  const { root, proj, sid } = fresh();
  hold(sid);
  const tp = join(root, 't.jsonl');
  writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two shapes left to pin' }] } }) + '\n');
  const calls = [];
  await rememberOnCompact({ session_id: sid, cwd: proj, transcript_path: tp, trigger: 'auto' }, stub(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/graphs/g/observations');
  assert.equal(calls[0][2].kind, 'summary');
  assert.match(calls[0][2].body, /two shapes left to pin/);
  assert.equal(calls[0][2].source, `claude-code:compact:${sid}`);
  const none = [];
  await rememberOnCompact({ session_id: 'nobody', cwd: proj }, stub(none));
  assert.equal(none.length, 0);
});
