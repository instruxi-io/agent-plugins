import test from 'node:test';
import assert from 'node:assert/strict';
import { join, delimiter } from 'node:path';
import { workerEnv, PLUGIN_DIR } from '../src/dispatch/launch.mjs';

test("a worker's PATH starts with this plugin's bin, so `enforcer` is the dispatcher's own version", () => {
  const env = workerEnv('g', { PATH: '/usr/local/bin:/usr/bin' });
  assert.equal(env.PATH, [join(PLUGIN_DIR, 'bin'), '/usr/local/bin:/usr/bin'].join(delimiter));
  assert.equal(workerEnv('g', {}).PATH, join(PLUGIN_DIR, 'bin'), 'no inherited PATH still names the bin');
});
