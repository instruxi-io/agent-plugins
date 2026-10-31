import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerEnv } from '../src/dispatch/launch.mjs';

// Grok expands other plugins' hook commands (jev-hooks) with ${CLAUDE_PLUGIN_ROOT} from the environment; ours made their
// UserPromptSubmit gate fail and cancel the worker at 0 turns.
test('a grok worker does not inherit CLAUDE_PLUGIN_ROOT, a claude worker keeps it', () => {
  const env = { PATH: '/bin', CLAUDE_PLUGIN_ROOT: '/somewhere/enforcer/1.9.2' };
  const grok = workerEnv('g', env, { harness: 'grok' });
  assert.equal(grok.CLAUDE_PLUGIN_ROOT, undefined);
  assert.ok(grok.ENFORCER_PLUGIN_ROOT);
  const claude = workerEnv('g', env);
  assert.ok(claude.CLAUDE_PLUGIN_ROOT);
  assert.equal(claude.CLAUDE_PLUGIN_ROOT, claude.ENFORCER_PLUGIN_ROOT);
});
