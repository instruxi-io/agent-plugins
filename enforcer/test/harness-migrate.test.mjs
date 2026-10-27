// `node --test test/harness-migrate.test.mjs`: `enforcer harness install|uninstall <grok|codex>` is one manifest-driven
// cleanup of the old runtime copy and PATH shim, which then prints the native install command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, NATIVE, removeMcp } from '../src/harness-migrate.mjs';
import * as grok from '../src/grok-install.mjs';
import * as codex from '../src/codex-install.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SNIPPET = '[mcp_servers.enforcer]\nurl = "https://api.instruxi.dev/mcp"\n';
const capture = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(s) };
};
const listAll = (d) =>
  existsSync(d)
    ? readdirSync(d, { recursive: true, withFileTypes: true })
        .map((e) => join(e.parentPath ?? e.path, e.name))
        .sort()
    : [];

// What the old `enforcer harness install grok` left behind, with the manifest it wrote.
function oldGrokInstall(home, extra = {}) {
  const base = join(home, '.config', 'enforcer', 'grok'),
    g = join(home, '.grok'),
    runtime = join(base, '1.3.26'),
    shim = join(home, '.local', 'bin', 'enforcer');
  for (const d of [join(runtime, 'bin'), join(g, 'hooks'), join(g, 'agents'), join(home, '.local', 'bin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(runtime, 'bin', 'enforcer'), '//');
  writeFileSync(join(base, 'VERSION'), '1.3.26\n');
  writeFileSync(join(g, 'hooks', 'enforcer.json'), '{}');
  writeFileSync(join(g, 'agents', 'graph-worker.md'), '---\nname: graph-worker\n---\n');
  writeFileSync(shim, '#!/bin/sh\n');
  writeFileSync(join(g, 'config.toml'), 'model = "grok-4"\n\n' + SNIPPET);
  const man = {
    schema_version: 1,
    version: '1.3.26',
    runtime,
    versionFile: join(base, 'VERSION'),
    files: [join(g, 'hooks', 'enforcer.json'), join(g, 'agents', 'graph-worker.md'), shim],
    config: join(g, 'config.toml'),
    configSectionAdded: true,
    options: {},
    skills: [],
    ...extra,
  };
  writeFileSync(join(base, 'manifest.json'), JSON.stringify(man));
  return { base, g, runtime, shim, man };
}

test('install with a manifest removes the runtime copy, hooks file and shim and prints the native command', () => {
  const home = mkdtempSync(join(tmpdir(), 'mig-'));
  const { base, g, runtime, shim } = oldGrokInstall(home);
  const { lines, out } = capture();
  const r = grok.install({ home, out });
  assert.equal(r.ok, true);
  for (const p of [runtime, join(base, 'VERSION'), join(g, 'hooks', 'enforcer.json'), join(g, 'agents', 'graph-worker.md'), shim, join(base, 'manifest.json')])
    assert.ok(!existsSync(p), `${p} should be gone`);
  assert.ok(!existsSync(base), 'the emptied runtime base is removed');
  const toml = readFileSync(join(g, 'config.toml'), 'utf8');
  assert.ok(!toml.includes('[mcp_servers.enforcer]') && toml.includes('model = "grok-4"'), toml);
  assert.ok(lines.join('\n').includes(NATIVE.grok), lines.join('\n'));
});

test('install with no manifest writes nothing and prints the native command', () => {
  for (const h of ['grok', 'codex']) {
    const home = mkdtempSync(join(tmpdir(), 'mig-'));
    const { lines, out } = capture();
    const r = (h === 'grok' ? grok : codex).install({ home, out });
    assert.equal(r.ok, true);
    assert.deepEqual(listAll(home), [], `${h}: nothing written`);
    assert.ok(lines.join('\n').includes(NATIVE[h]), lines.join('\n'));
  }
  // and through the CLI: exit 0, native command on stdout
  const home = mkdtempSync(join(tmpdir(), 'mig-cli-'));
  const r = spawnSync(process.execPath, [join(root, 'bin/enforcer'), 'harness', 'install', 'codex'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(NATIVE.codex), r.stdout);
  assert.deepEqual(listAll(home), []);
});

test('uninstall restores the recorded config.toml backup', () => {
  const home = mkdtempSync(join(tmpdir(), 'mig-'));
  const cfg = join(home, '.grok', 'config.toml');
  const bak = `${cfg}.enforcer-bak-20261020-101010`;
  const { base } = oldGrokInstall(home, { backups: { [cfg]: bak } });
  writeFileSync(bak, 'model = "grok-4"\n# the user\'s own config before the old install\n');
  const r = grok.uninstall({ home, out: () => {} });
  assert.deepEqual(r.restored, [cfg]);
  assert.equal(readFileSync(cfg, 'utf8'), 'model = "grok-4"\n# the user\'s own config before the old install\n');
  assert.ok(!existsSync(bak), 'the backup is moved back, not copied');
  assert.ok(!existsSync(join(base, 'manifest.json')));
});

test('--dry-run lists what would go and removes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'mig-'));
  const before = listAll(home).length;
  oldGrokInstall(home);
  const after = listAll(home);
  const { lines, out } = capture();
  migrate('grok', { home, dryRun: true, out });
  assert.deepEqual(listAll(home), after);
  assert.ok(after.length > before);
  assert.ok(lines.some((l) => l.startsWith('would remove') && l.includes('.local')));
  assert.ok(lines.join('\n').includes(NATIVE.grok));
});

test('the shim stays while the other harness manifest still lists it', () => {
  const home = mkdtempSync(join(tmpdir(), 'mig-'));
  const { shim } = oldGrokInstall(home);
  const cbase = join(home, '.config', 'enforcer', 'codex');
  mkdirSync(cbase, { recursive: true });
  writeFileSync(join(cbase, 'manifest.json'), JSON.stringify({ schema_version: 1, runtime: join(cbase, '1.3.26'), files: [], shim }));
  migrate('grok', { home, out: () => {} });
  assert.ok(existsSync(shim), 'codex still owns it');
  migrate('codex', { home, out: () => {} });
  assert.ok(!existsSync(shim), 'gone once the last owner migrates');
});

test('removeMcp cuts only the enforcer section', () => {
  assert.equal(removeMcp('a = 1\n\n' + SNIPPET + '\n[other]\nb = 2\n'), 'a = 1\n\n[other]\nb = 2\n');
  assert.equal(removeMcp('a = 1\n'), 'a = 1\n');
});
