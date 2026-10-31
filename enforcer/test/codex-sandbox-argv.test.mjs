import test from 'node:test';
import assert from 'node:assert/strict';
import { launchCmd } from '../src/dispatch/launch.mjs';

test('codex workers get a workspace-write sandbox with network, not read-only or full access', () => {
  const cmd = launchCmd('do it', 'gpt-5', { harness: 'codex' }, 'k');
  const i = cmd.indexOf('--sandbox');
  assert.ok(i > 0 && cmd[i + 1] === 'workspace-write');
  assert.ok(cmd.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(cmd[cmd.length - 1], 'do it');
});
