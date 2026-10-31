import test from 'node:test';
import assert from 'node:assert/strict';
import { launchCmd, PLUGIN_DIR } from '../../src/dispatch/launch.mjs';
import { preflight } from '../../src/preflight.mjs';

const cmd = () => launchCmd('p', 'sonnet', {}, 'k');

test('launch disables the installed enforcer plugin for the child', () => {
  const i = cmd().indexOf('--settings');
  assert.ok(i > 0);
  assert.equal(JSON.parse(cmd()[i + 1]).enabledPlugins['enforcer@instruxi'], false);
});

test('launch passes --plugin-dir for the checkout', () => {
  const c = cmd();
  const i = c.indexOf('--plugin-dir');
  assert.ok(i > 0);
  assert.equal(c[i + 1], PLUGIN_DIR);
});

test('preflight prints the plugin root and version workers will run', async () => {
  const res = await preflight({ graph: 'g', env: { PATH: process.env.PATH, HOME: '/nonexistent' } });
  const l = res.find((r) => r.name === 'worker-plugin');
  assert.ok(l && l.ok);
  assert.ok(l.line.includes(PLUGIN_DIR.replace(/\/$/, '')) || l.line.includes('workers run'));
  assert.match(l.line, /enforcer \d+\.\d+/);
});

test('codex launch auto-approves only the enforcer MCP server tools, and drops a claude model name', () => {
  const c = launchCmd('p', 'sonnet', {}, 'k', { harness: 'codex' });
  const i = c.findIndex((a) => a.startsWith('mcp_servers.enforcer=')) - 1;
  assert.ok(i > 0 && c[i + 1].startsWith('mcp_servers.enforcer={url='));
  assert.match(c[i + 1], /default_tools_approval_mode="approve"/);
  assert.ok(!c.includes('--model'));
  assert.ok(!c.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(c.at(-1), 'p');
});
