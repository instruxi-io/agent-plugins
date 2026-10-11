// Eviction keeps human-set latches, the organisation floor never silently expires, booleans read one way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'enforcer');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'hook-latency', 'golden.json');

const home = mkdtempSync(join(tmpdir(), 'gov-latches-'));
const gdir = join(home, '.config', 'enforcer', 'governor');
mkdirSync(gdir, { recursive: true });
for (const k of Object.keys(process.env)) if (k.startsWith('ENFORCER_') || k.startsWith('GOVERNOR_') || k.startsWith('GRAPH_')) delete process.env[k];
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadState } = await import('../lib/governor/core/store.mjs');
const { peekPendingAsk, peekShipOn } = await import('../lib/governor/core/peek.mjs');
const { readManaged, merge } = await import('../lib/governor/core/managed.mjs');
const { isOff, normalizeBooleans } = await import('../lib/governor/core/bool.mjs');
const STATE = join(gdir, 'state.json');
const CONFIG = join(gdir, 'config.json');
const DAY = 86400000;

test('human-set latches survive idle eviction', () => {
  const old = Date.now() - 10 * DAY;
  const mk = (extra) => ({ id: 'x', status: 'active', lastSeen: old, ...extra });
  writeFileSync(
    STATE,
    JSON.stringify({
      agents: {
        grounded: mk({ status: 'grounded', groundedBy: 'human' }),
        paused: mk({ status: 'paused' }),
        burn: mk({ burnFlagged: true }),
        raised: mk({ budgetRaised: true }),
        ask: mk({ pendingAsk: { q: 1 } }),
        esc: mk({ escalated: true }),
        plain: mk({}),
      },
      unmapped: {},
    }),
  );
  const ids = Object.keys(loadState().agents).sort();
  assert.deepEqual(ids, ['ask', 'burn', 'esc', 'grounded', 'paused', 'raised']);
});

test('a day-old organisation floor still enforces', () => {
  const at = Date.now() - 25 * 3600 * 1000;
  writeFileSync(join(gdir, 'managed-settings.json'), JSON.stringify({ at, cred: 'c', settings: { rulesOn: true, dollars: 5 } }));
  const m = readManaged();
  assert.equal(m.rulesOn, true);
  assert.equal(m.stale, true);
  const eff = merge({ rulesOn: false, dollars: 50 }, m);
  assert.equal(eff.rulesOn, true);
  assert.equal(eff.dollars, 5);
  assert.equal(merge({ soft: null }, { soft: 0.5 }).soft, 0.5);
  assert.equal(merge({ soft: 0.8 }, { soft: null }).soft, 0.8);
});

test('shipOn off is honoured', () => {
  assert.equal(isOff(normalizeBooleans({ shipOn: 'off' }).shipOn), true);
  assert.equal(normalizeBooleans({ adviseModel: 'no' }).adviseModel, false);
  writeFileSync(CONFIG, JSON.stringify({ shipOn: 'off' }));
  writeFileSync(STATE, JSON.stringify({ agents: { a: { pendingAsk: { q: 1 } } }, unmapped: {} }));
  assert.equal(peekShipOn(), false);
  assert.equal(peekPendingAsk('a'), true);
  assert.equal(peekPendingAsk('b'), false);
});

test('the decision and receipt for a fixed payload are unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'gov-latches-golden-'));
  const cwd = join(base, 'golden-project');
  mkdirSync(cwd);
  const env = { ...process.env, HOME: base, USERPROFILE: base, CLAUDE_PLUGIN_DATA: join(base, 'data'), CLAUDE_CONFIG_DIR: join(base, 'cc') };
  delete env.CLAUDE_ENV_FILE;
  delete env.NODE_OPTIONS;
  const dir = join(base, '.config', 'enforcer', 'governor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents: {}, unmapped: {} }));
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
  assert.equal(
    r.stderr.split('\n').find((l) => l.startsWith('enforcer-governor:decision')),
    want.decision,
  );
  const got = readFileSync(join(dir, 'receipts.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const k of ['verdict', 'reason', 'source', 'tool', 'tokens']) assert.equal(got[0][k], want.receipts[0][k], k);
  rmSync(base, { recursive: true, force: true });
});

test.after(() => rmSync(home, { recursive: true, force: true }));
