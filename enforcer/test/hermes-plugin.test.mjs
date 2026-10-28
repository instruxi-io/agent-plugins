// The Hermes plugin (harness/hermes) is Python: run its unittest suite from npm test so CI gates it like every
// other harness. Python 3.11+ is what Hermes itself needs; a machine without it skips (Windows runners), Linux fails.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'harness', 'hermes');
const python = ['python3', 'python'].find((p) => {
  const r = spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'], { encoding: 'utf8' });
  return r.status === 0;
});
if (!python) {
  assert.notEqual(process.platform, 'linux', 'python3 >= 3.11 is required to test the Hermes plugin');
  console.log('  skip  no python >= 3.11 on this machine');
  process.exit(0);
}
const r = spawnSync(python, ['-I', '-m', 'unittest', 'discover', '-s', 'test'], { cwd: dir, encoding: 'utf8', timeout: 240_000 });
process.stdout.write(r.stdout + r.stderr);
assert.equal(r.status, 0, 'harness/hermes unittest suite failed');
console.log('  ok  harness/hermes python suite');
