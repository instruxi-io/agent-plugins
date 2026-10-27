// `node --test test/uninstall.test.mjs`: uninstall, --purge, the schema_version downgrade guard, codex manifest.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'uninst-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ENFORCER_HOME = join(home, '.enforcer');
process.env.ENFORCER_CONFIG_HOME = join(home, '.config', 'enforcer');
process.env.CLAUDE_SETTINGS_PATH = join(home, 'cc-dir', 'settings.json');
delete process.env.ENFORCER_API_KEY;

const { uninstall } = await import('../src/uninstall.mjs');
const { saveCredentials, readCredentials, SHARED_FILE } = await import('../src/credentials.mjs');
const { assertSchema, SchemaError, SCHEMA_VERSION } = await import('../src/schema.mjs');
const codex = await import('../src/codex-install.mjs');

let pass = 0;
const ok = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};
const quiet = { out: () => {} };

await ok('uninstall removes the OTEL settings entries', async () => {
  mkdirSync(join(home, 'cc-dir'), { recursive: true });
  mkdirSync(process.env.ENFORCER_HOME, { recursive: true });
  writeFileSync(
    process.env.CLAUDE_SETTINGS_PATH,
    JSON.stringify({
      theme: 'dark',
      otelHeadersHelper: 'node "/x/otel-headers.mjs"',
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x', KEEP: '1' },
    }),
  );
  writeFileSync(join(process.env.ENFORCER_HOME, 'otel-headers.mjs'), '//');
  writeFileSync(join(process.env.ENFORCER_HOME, 'plugin-root'), '/p\n');
  saveCredentials({ enforcer: { api_key: 'k' } });
  const r = await uninstall({ home, ...quiet });
  const s = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));
  assert.equal(s.otelHeadersHelper, undefined);
  assert.deepEqual(s.env, { KEEP: '1' });
  assert.equal(s.theme, 'dark');
  assert.ok(!existsSync(join(process.env.ENFORCER_HOME, 'otel-headers.mjs')));
  assert.ok(!existsSync(join(process.env.ENFORCER_HOME, 'plugin-root')));
  assert.ok(existsSync(SHARED_FILE()), 'credentials stay without --purge');
  assert.ok(r.left.some((l) => l.includes('credentials.json')));
});

await ok('--purge removes credentials after confirmation', async () => {
  let r = await uninstall({ home, purge: true, confirm: async () => false, ...quiet });
  assert.ok(existsSync(SHARED_FILE()), 'declined: kept');
  assert.ok(r.left.some((l) => l.includes('purge declined')));
  let asked = '';
  r = await uninstall({
    home,
    purge: true,
    confirm: async (q) => {
      asked = q;
      return true;
    },
    ...quiet,
  });
  assert.match(asked, /signed out/);
  assert.ok(!existsSync(SHARED_FILE()));
});

await ok('older schema reader refuses newer state', async () => {
  mkdirSync(process.env.ENFORCER_HOME, { recursive: true });
  writeFileSync(SHARED_FILE(), JSON.stringify({ schema_version: SCHEMA_VERSION + 1, enforcer: { api_key: 'k' } }));
  assert.throws(
    () => assertSchema({ schema_version: SCHEMA_VERSION + 1 }, 'f'),
    (e) => e instanceof SchemaError && /newer enforcer/.test(e.message),
  );
  assert.equal(readCredentials(), null);
  assert.throws(() => saveCredentials({ enforcer: { api_key: 'x' } }), SchemaError);
  assert.equal(JSON.parse(readFileSync(SHARED_FILE(), 'utf8')).schema_version, SCHEMA_VERSION + 1, 'newer file untouched');
});

await ok('codex uninstall removes the old runtime copy its manifest lists, and only that', async () => {
  const h = mkdtempSync(join(tmpdir(), 'codex-'));
  const base = join(h, '.config', 'enforcer', 'codex');
  const runtime = join(base, '1.3.26');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'enforcer'), '//');
  writeFileSync(join(base, 'VERSION'), '1.3.26\n');
  writeFileSync(
    join(base, 'manifest.json'),
    JSON.stringify({ schema_version: SCHEMA_VERSION, version: '1.3.26', runtime, files: [join(base, 'VERSION')], shim: null }),
  );
  writeFileSync(join(base, 'mine.txt'), 'not ours');
  const r = codex.uninstall({ home: h, ...quiet });
  assert.ok(r.removed.includes(runtime));
  assert.ok(!existsSync(runtime) && !existsSync(join(base, 'manifest.json')) && !existsSync(join(base, 'VERSION')));
  assert.ok(existsSync(join(base, 'mine.txt')), 'a file the manifest does not list survives');
});

console.log(`\n  ${pass} passed, 0 failed\n  fail 0`);
