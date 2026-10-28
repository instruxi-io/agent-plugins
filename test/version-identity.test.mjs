import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANIFESTS, bump, readVersions, checkTag, changelogHas } from '../scripts/release.mjs';

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
  for (const m of MANIFESTS) {
    fs.mkdirSync(path.dirname(path.join(d, m.file)), { recursive: true });
    fs.copyFileSync(m.file, path.join(d, m.file));
  }
  fs.copyFileSync('CHANGELOG.md', path.join(d, 'CHANGELOG.md'));
  return d;
}

test('bump script edits all nine manifests', () => {
  assert.equal(MANIFESTS.length, 9);
  const d = fixture();
  bump('9.8.7', d);
  const vs = readVersions(d);
  assert.equal(vs.length, 9);
  for (const v of vs) assert.equal(v.version, '9.8.7', v.file);
  assert.throws(() => bump('nope', d));
});

test('tag equals plugin.json version', () => {
  const d = fixture();
  const v = readVersions(d)[0].version;
  assert.equal(checkTag(`v${v}`, d), v);
  assert.throws(() => checkTag('v0.0.0', d), /!=/);
  bump('9.8.7', d);
  assert.throws(() => checkTag(`v${v}`, d));
});

test('changelog entry or Unreleased satisfies the gate', () => {
  assert.ok(changelogHas('1.0.5'));
  assert.ok(changelogHas('1.0.1'));
});

test('enforcer package is the publishable CLI', () => {
  const p = JSON.parse(fs.readFileSync('enforcer/package.json', 'utf8'));
  assert.equal(p.name, '@instruxi-io/enforcer');
  assert.notEqual(p.private, true);
  assert.equal(p.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.ok(fs.existsSync(path.join('enforcer', p.bin.enforcer)));
  assert.equal(p.version, readVersions('.')[0].version);
});
