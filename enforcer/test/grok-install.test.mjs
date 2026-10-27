// `enforcer harness install grok` (nightly's 'Grok install and shim' step runs this file): the old copier is gone;
// install migrates off the runtime copy and prints the native command. The full cases are in harness-migrate.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, uninstall } from '../src/grok-install.mjs';
import { NATIVE } from '../src/harness-migrate.mjs';

const ok = (m) => console.log('  ok  ' + m);

let home = mkdtempSync(join(tmpdir(), 'grok-inst-'));
let lines = [];
assert.equal(install({ home, out: (s) => lines.push(s) }).ok, true);
assert.deepEqual(readdirSync(home), [], 'no manifest: nothing written');
assert.ok(lines.join('\n').includes(NATIVE.grok));
ok('install with no old copy writes nothing and prints the native command');

home = mkdtempSync(join(tmpdir(), 'grok-inst-'));
const base = join(home, '.config', 'enforcer', 'grok'),
  runtime = join(base, '1.3.26'),
  hooks = join(home, '.grok', 'hooks', 'enforcer.json'),
  shim = join(home, '.local', 'bin', 'enforcer');
for (const d of [runtime, join(home, '.grok', 'hooks'), join(home, '.local', 'bin')]) mkdirSync(d, { recursive: true });
for (const f of [hooks, shim]) writeFileSync(f, '');
writeFileSync(join(base, 'manifest.json'), JSON.stringify({ schema_version: 1, runtime, files: [hooks, shim] }));
lines = [];
assert.equal(uninstall({ home, out: (s) => lines.push(s) }).ok, true);
for (const p of [runtime, hooks, shim, base]) assert.ok(!existsSync(p), p);
assert.ok(lines.join('\n').includes(NATIVE.grok));
ok('uninstall removes the runtime copy, hooks file and shim the manifest lists');
console.log('\n  fail 0');
