// The governor's state file stays small however many sessions have run (temp HOME, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'enforcer');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'hook-latency', 'golden.json');
const DAY = 86400000;

const home = mkdtempSync(join(tmpdir(), 'gov-bounded-'));
const gdir = join(home, '.config', 'enforcer', 'governor');
mkdirSync(gdir, { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith('ENFORCER_') || k.startsWith('GOVERNOR_') || k.startsWith('GRAPH_')) delete process.env[k];
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadState, saveState } = await import('../lib/governor/core/store.mjs');
const { decide, DEFAULTS } = await import('../lib/governor/core/policy.mjs');
const STATE = join(gdir, 'state.json');
const cfg = { ...DEFAULTS };

const big = (i, extra = {}) => ({
  id: `a${i}`,
  tokens: i,
  recent: Array.from({ length: 8 }, () => 'Bash:' + 'x'.repeat(3700)),
  escalated: false,
  status: 'active',
  budget: 1000,
  soft: 0.8,
  cost: 0,
  lastSeen: Date.now(),
  ...extra,
});
const write = (agents, extra = {}) => writeFileSync(STATE, JSON.stringify({ agents, unmapped: {}, ...extra }));

test('a state with 700 oversized agents shrinks below 200 KB after one decision', () => {
  const agents = {};
  for (let i = 0; i < 700; i++) agents[`a${i}`] = big(i);
  write(agents);
  assert.ok(statSync(STATE).size > 2_000_000);
  const s = loadState();
  decide(s, { agent: 'a1', tool: 'Bash', action: 'Bash:ls' }, cfg);
  saveState(s);
  assert.ok(statSync(STATE).size < 200_000, `size ${statSync(STATE).size}`);
});

test('an agent last seen 30 days ago is dropped and one touched today survives', () => {
  write({ old: big(1, { id: 'old', lastSeen: Date.now() - 30 * DAY }), fresh: big(2, { id: 'fresh' }) });
  const s = loadState();
  assert.equal(s.agents.old, undefined);
  assert.ok(s.agents.fresh);
});

test('an escalated old agent is kept', () => {
  write({
    esc: big(1, { id: 'esc', escalated: true, lastSeen: Date.now() - 30 * DAY }),
    ask: big(2, { id: 'ask', pendingAsk: { reason: 'x', day: '2026-01-01' }, lastSeen: Date.now() - 30 * DAY }),
  });
  const s = loadState();
  assert.ok(s.agents.esc);
  assert.ok(s.agents.ask);
});

test('an entry without lastSeen is kept and stamped', () => {
  const a = big(1, { id: 'legacy' });
  delete a.lastSeen;
  write({ legacy: a });
  const before = Date.now();
  const s = loadState();
  assert.ok(s.agents.legacy);
  assert.ok(s.agents.legacy.lastSeen >= before);
});

test('unmapped keeps its 100 most recent', () => {
  const unmapped = {};
  for (let i = 0; i < 350; i++) unmapped[`/p/${i}`] = `p${i}`;
  write({}, { unmapped });
  const s = loadState();
  assert.equal(Object.keys(s.unmapped).length, 100);
  assert.ok(s.unmapped['/p/349'] && !s.unmapped['/p/0']);
});

test('the decision and receipt for a fixed payload are unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'gov-bounded-golden-'));
  const cwd = join(base, 'golden-project');
  mkdirSync(cwd);
  const env = { ...process.env, HOME: base, USERPROFILE: base, CLAUDE_PLUGIN_DATA: join(base, 'data'), CLAUDE_CONFIG_DIR: join(base, 'cc') };
  delete env.CLAUDE_ENV_FILE;
  delete env.NODE_OPTIONS;
  const dir = join(base, '.config', 'enforcer', 'governor');
  mkdirSync(dir, { recursive: true });
  const agents = {};
  for (let i = 0; i < 50; i++) agents[`x${i}`] = big(i);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, unmapped: {} }));
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'hook-latency-1',
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'ls -la', description: 'List files' },
  });
  const r = spawnSync(process.execPath, [CLI, 'event', 'pre-tool-use'], { input, env, cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(readFileSync(GOLDEN, 'utf8')).plain;
  assert.equal(r.stdout, want.stdout);
  const line = r.stderr.split('\n').find((l) => l.startsWith('enforcer-governor:decision'));
  assert.equal(line, want.decision);
  const got = readFileSync(join(dir, 'receipts.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(got.length, want.receipts.length);
  for (const k of ['verdict', 'reason', 'source', 'tool', 'tokens']) assert.equal(got[0][k], want.receipts[0][k], k);
  assert.ok(statSync(join(dir, 'state.json')).size < 200_000);
  rmSync(base, { recursive: true, force: true });
});

test.after(() => rmSync(home, { recursive: true, force: true }));
