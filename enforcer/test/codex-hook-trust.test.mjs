// `enforcer doctor` names why Codex reports every Enforcer hook Failed: its per-run plugin trust check
// (openai/codex rust-v0.164.0 codex-rs/hooks/src/engine/plugin_trust.rs) refuses before the hook starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexPluginContentHash, codexHookTrustCheck, enforcerHookStates } from '../src/codex-hook-trust.mjs';
import { runChecks } from '../src/doctor.mjs';

const KEY = (ev) => `enforcer@instruxi:hooks/codex/hooks.json:${ev}:0:0`;
function setup(states) {
  const h = mkdtempSync(join(tmpdir(), 'codex-trust-'));
  const root = join(h, '.codex/plugins/cache/instruxi/enforcer/1.7.0');
  mkdirSync(join(root, 'hooks/codex'), { recursive: true });
  mkdirSync(join(root, '__pycache__'), { recursive: true });
  writeFileSync(join(root, 'hooks/codex/hooks.json'), '{"hooks":{}}\n');
  writeFileSync(join(root, 'plugin.json'), '{"name":"enforcer"}\n');
  writeFileSync(join(root, '__pycache__/x.pyc'), 'ignored');
  mkdirSync(join(h, '.codex/plugins/cache/instruxi/enforcer/1.6.0'), { recursive: true });
  const body = (typeof states === 'function' ? states(codexPluginContentHash(root)) : states) || '';
  writeFileSync(
    join(h, '.codex/config.toml'),
    `model = "gpt-5"\n\n[plugins."enforcer@instruxi"]\nenabled = true\n\n${body}\n[projects."/tmp/cx"]\ntrust_level = "trusted"\n`,
  );
  return { h, root };
}
const codexHome = (h) => ({ codexHome: join(h, '.codex') });

test('the content hash is Codex plugin_fingerprint.rs: a fixed vector, pycache ignored, any byte changes it', () => {
  const { root } = setup('');
  // The algorithm was checked against codex-cli 0.164.0's own hooks/list currentHash on two real enforcer
  // 1.7.0 trees (sha256:484c46f9..., sha256:3aea8fc8...); this vector is that algorithm on this small tree,
  // also reproduced by an independent Python port. The 1.6.0 sibling directory is not part of 1.7.0's root.
  const a = codexPluginContentHash(root);
  assert.equal(a, 'sha256:2a09f7d032d7b6fd163fc02e4da1652d1a81d001a30e353de7abe4ffded88ffb');
  writeFileSync(join(root, '__pycache__/y.pyc'), 'still ignored');
  assert.equal(codexPluginContentHash(root), a);
  writeFileSync(join(root, 'plugin.json'), '{"name":"enforcer2"}\n');
  assert.notEqual(codexPluginContentHash(root), a);
});

test('a combined "<declaration>/<content>" trusted_hash is named: Codex 0.164 never matches it', async () => {
  const { h } = setup((c) => `[hooks.state."${KEY('session_start')}"]\ntrusted_hash = "sha256:decl/${c}"\n`);
  const r = codexHookTrustCheck(h, codexHome(h));
  assert.equal(r.ok, false);
  assert.match(r.detail, /<declaration>\/<content>.*\/hooks/);
  const rows = await runChecks({ network: false, home: h });
  assert.ok(rows.some((x) => x.name === 'codex hook approval' && !x.ok));
});

test('approval for other plugin contents (a plugin update) is named', () => {
  const { h } = setup(`[hooks.state."${KEY('stop')}"]\ntrusted_hash = "sha256:decl"\ntrusted_content_hash = "sha256:old"\n`);
  const r = codexHookTrustCheck(h, codexHome(h));
  assert.equal(r.ok, false);
  assert.match(r.detail, /enforcer 1\.7\.0 changed since its hooks were approved/);
});

test('no approval at all is named; an approval matching the installed plugin passes', () => {
  let { h } = setup('');
  assert.match(codexHookTrustCheck(h, codexHome(h)).detail, /has not approved/);
  ({ h } = setup((c) => `[hooks.state."${KEY('stop')}"]\ntrusted_hash = "sha256:decl"\ntrusted_content_hash = "${c}"\n`));
  assert.deepEqual(codexHookTrustCheck(h, codexHome(h)), { ok: true, detail: 'enforcer 1.7.0: 1 hook approval(s) match the installed plugin' });
});

test('no Codex, or Enforcer not a Codex plugin: no row', async () => {
  const h = mkdtempSync(join(tmpdir(), 'codex-none-'));
  assert.equal(codexHookTrustCheck(h, codexHome(h)), null);
  mkdirSync(join(h, '.codex'));
  writeFileSync(join(h, '.codex/config.toml'), 'model = "o3"\n');
  assert.equal(codexHookTrustCheck(h, codexHome(h)), null);
  const rows = await runChecks({ network: false, home: h });
  assert.ok(!rows.some((x) => x.name === 'codex hook approval'));
});

test('only enforcer@instruxi hook states are read, other tables end them', () => {
  const s = enforcerHookStates(
    `[hooks.state."other@x:hooks.json:stop:0:0"]\ntrusted_hash = "a"\n[hooks.state."${KEY('stop')}"]\ntrusted_hash = "b"\nenabled = false\n[otel]\ntrusted_hash = "c"\n`,
  );
  assert.deepEqual(s, { [KEY('stop')]: { trusted_hash: 'b', enabled: false } });
});
