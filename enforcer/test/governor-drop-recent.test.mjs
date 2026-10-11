// The governor no longer records raw tool-call history (`recent`) (temp HOME, no network).
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

const home = mkdtempSync(join(tmpdir(), 'gov-droprecent-'));
const gdir = join(home, '.config', 'enforcer', 'governor');
mkdirSync(gdir, { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith('ENFORCER_') || k.startsWith('GOVERNOR_') || k.startsWith('GRAPH_')) delete process.env[k];
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadState, saveState } = await import('../lib/governor/core/store.mjs');
const { decide, DEFAULTS } = await import('../lib/governor/core/policy.mjs');
const STATE = join(gdir, 'state.json');
const cfg = { ...DEFAULTS };

const big = (i) => ({
  id: `a${i}`,
  tokens: i,
  recent: Array.from({ length: 8 }, () => 'Bash:' + 'x'.repeat(3700)),
  escalated: false,
  status: 'active',
  budget: 1000,
  soft: 0.8,
  cost: 0,
  lastSeen: Date.now(),
});
const write = (agents) => writeFileSync(STATE, JSON.stringify({ agents, unmapped: {} }));

test('an agent entry has no recent key after 100 tool calls', () => {
  write({});
  const s = loadState();
  for (let i = 0; i < 100; i++) decide(s, { agent: 'busy', tool: 'Bash', action: 'Bash:echo ' + i }, cfg);
  assert.ok(s.agents.busy);
  assert.equal('recent' in s.agents.busy, false);
  saveState(s);
  assert.equal('recent' in JSON.parse(readFileSync(STATE, 'utf8')).agents.busy, false);
});

test('loading a state file with recent strips it and the saved file is smaller', () => {
  const agents = {};
  for (let i = 0; i < 20; i++) agents[`a${i}`] = big(i);
  write(agents);
  const before = statSync(STATE).size;
  const s = loadState();
  for (const a of Object.values(s.agents)) assert.equal('recent' in a, false);
  saveState(s);
  assert.ok(statSync(STATE).size < before / 10, `${before} -> ${statSync(STATE).size}`);
});

test('the decision and receipt for a fixed payload are unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'gov-droprecent-golden-'));
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
  rmSync(base, { recursive: true, force: true });
});

test('the real-shaped 700-agent fixture saves under 120 KB', () => {
  const agents = {};
  for (let i = 0; i < 700; i++) agents[`a${i}`] = big(i);
  write(agents);
  assert.ok(statSync(STATE).size > 2_000_000);
  const s = loadState();
  decide(s, { agent: 'a1', tool: 'Bash', action: 'Bash:ls' }, cfg);
  saveState(s);
  assert.ok(statSync(STATE).size < 120_000, `size ${statSync(STATE).size}`);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
