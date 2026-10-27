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

test('bump script edits all seven manifests', () => {
  assert.equal(MANIFESTS.length, 7);
  const d = fixture();
  bump('9.8.7', d);
  const vs = readVersions(d);
  assert.equal(vs.length, 7);
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
