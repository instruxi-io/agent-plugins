// The agent id names the harness running the hooks: 'claude:<8>', 'grok:<8>',
// 'codex:<8>'. The status line reads the session's state under the same id the
// hooks wrote it under, whichever harness that is. `node test/agent-id.test.mjs`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const { agentPrefix } = await import('../adapters/claude-code/harness.mjs');
const SPEND = fileURLToPath(new URL('../statusline/spend.mjs', import.meta.url));
const SID = '0f3c9a1b-2222-4333-8444-555566667777';
// Neither Claude Code's marker nor a harness flag leaks in from the process
// running the suite: each case sets exactly the one it is about.
const { CLAUDECODE: _c, ENFORCER_HARNESS: _e, ...base } = process.env;

let pass = 0;
const ok = (label, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + label);
};

ok('the prefix follows the running harness', () => {
  assert.equal(agentPrefix({ CLAUDECODE: '1' }), 'claude');
  assert.equal(agentPrefix({ ENFORCER_HARNESS: 'grok' }), 'grok');
  assert.equal(agentPrefix({ ENFORCER_HARNESS: 'codex', CLAUDECODE: '1' }), 'codex');
  assert.equal(agentPrefix({}), 'claude');
});

// One state file holding a session under each id; the status line must find
// the one its harness's hooks would have written, and only that one.
const statusFor = (env) => {
  const home = mkdtempSync(join(tmpdir(), 'gov-agent-id-'));
  const agents = {
    'claude:0f3c9a1b': { model: 'claude-sonnet-5', tokens: 0, status: 'active' },
    'grok:0f3c9a1b': { model: 'grok-4.7', tokens: 0, status: 'grounded' },
    'codex:0f3c9a1b': { model: 'gpt-5-codex', tokens: 0, status: 'active', escalated: true },
  };
  writeFileSync(join(home, 'state.json'), JSON.stringify({ agents }));
  const r = spawnSync(process.execPath, [SPEND], {
    input: JSON.stringify({ session_id: SID, cost: { total_cost_usd: 1.25 } }),
    encoding: 'utf8',
    env: { ...base, ...env, HOME: home, ENFORCER_HOME: home, GOVERNOR_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

ok('the status line reads the session under its harness id', () => {
  assert.match(statusFor({ CLAUDECODE: '1' }), /\x1b\[2m·.*\$1\.25/, 'claude: an ordinary active session');
  assert.match(statusFor({ ENFORCER_HARNESS: 'grok' }), /\x1b\[31m■.*\$1\.25/, 'grok: the grounded one');
  assert.match(statusFor({ ENFORCER_HARNESS: 'codex' }), /\x1b\[33m■.*\$1\.25/, 'codex: the escalated one');
});

console.log(`agent-id: ${pass} passed`);
