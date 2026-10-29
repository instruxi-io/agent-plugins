// `enforcer doctor --bundle`: a redacted tar.gz a support engineer can ask for.
// Credential metadata only (base, key id, scopes, expiry); every text is redacted, and any
// literal secret value found in the credential document is scrubbed as well.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir, platform, arch, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stateBase } from './state.mjs';
import { readCredentials, keyId, enforcerKey, SHARED_FILE } from './credentials.mjs';
import { resolveConfig, envBaseUrl, BASE_URL_VAR, VARS } from './config.mjs';
import { redact } from './graph/redact.mjs';
import { runChecks } from './doctor.mjs';
import { verify, RECEIPTS } from '../lib/governor/core/store.mjs';
import { stats as outboxStats, ackedHash } from '../lib/governor/core/outbox.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SECTIONS = [
  'plugin',
  'environment',
  'config',
  'credentials',
  'doctor',
  'hooks-log',
  'dispatcher-logs',
  'processes',
  'receipts',
  'outbox',
  'plugin-list',
  'worker-streams',
];
const TAIL = 200;

const tail = (text, n = TAIL) =>
  text
    .split('\n')
    .slice(-n - 1)
    .join('\n');
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const safe = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { error: e.message };
  }
};

function secretValues(cred) {
  const o = cred?.enforcer?.oauth || {};
  return [
    cred?.enforcer?.api_key,
    o.access_token,
    o.refresh_token,
    o.id_token,
    o.client_secret,
    enforcerKey(),
    process.env.ENFORCER_API_KEY,
    process.env.GRAPH_TOKEN,
  ].filter((v) => typeof v === 'string' && v.length >= 6);
}

export async function collect({ network = false, fetchImpl } = /** @type {any} */ ({})) {
  const cred = readCredentials();
  const secrets = secretValues(cred);
  const clean = (t) => {
    let s = redact(String(t ?? ''))[0];
    for (const v of secrets) s = s.split(v).join('[redacted:value]');
    return s;
  };
  const state = stateBase();
  const files = {};
  const put = (name, v) => {
    files[name] = clean(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  };

  const pj = safe(() => JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')));
  put('plugin.json', { version: pj.version, name: pj.name, installPath: ROOT, node: process.version });
  put('environment.json', {
    platform: platform(),
    arch: arch(),
    release: release(),
    node: process.version,
    harness: process.env.ENFORCER_HARNESS || 'claude',
    claudeCode: process.env.CLAUDE_CODE_VERSION || process.env.CLAUDECODE || null,
    // names of the recognised variables that are set; values only for non-secret ones
    set: Object.fromEntries(
      Object.keys(VARS)
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, /KEY|TOKEN|SECRET|PASSWORD/.test(k) ? '(set)' : process.env[k]]),
    ),
  });
  put(
    'config.json',
    safe(() => {
      const c = resolveConfig({ saved: cred });
      return {
        resolved: c,
        sources: [
          { source: 'flag', value: null, note: 'not applicable to a bundle' },
          { source: BASE_URL_VAR, value: envBaseUrl() || null },
          { source: 'saved credentials', value: cred?.enforcer?.base_url || null, file: SHARED_FILE() },
          { source: 'default', value: 'https://api.instruxi.dev' },
        ],
        winner: c.source,
      };
    }),
  );
  const o = cred?.enforcer?.oauth || {};
  put('credentials.json', {
    present: !!cred,
    file: SHARED_FILE(),
    base: cred?.enforcer?.base_url || null,
    keyId: enforcerKey() ? keyId() : cred?.enforcer?.api_key ? keyId(cred.enforcer.api_key) : null,
    oauth: cred?.enforcer?.oauth
      ? { clientId: o.client_id || null, accountId: o.account_id || null, scopes: o.scope || null, expiresAt: o.expires_at || null }
      : null,
  });
  put('doctor.json', await safe(async () => (await runChecks({ network, fetchImpl })).map(({ name, ok, detail }) => ({ name, ok, detail }))));
  put('hooks-log.txt', tail(read(join(state, 'hooks.log.jsonl')) ?? '(no hook debug log; set ENFORCER_DEBUG=1)'));
  put('dispatcher-logs.txt', ['dispatcher.log', 'dispatcher.jsonl'].map((n) => `== ${n}\n${tail(read(join(state, n)) ?? '(absent)')}`).join('\n'));
  put(
    'processes.json',
    safe(() => {
      const out = {};
      for (const n of readdirSync(state))
        if (/pid|lease|lock/i.test(n) && statSync(join(state, n)).isFile()) out[n] = (read(join(state, n)) || '').slice(0, 2000);
      return { stateDir: state, files: out, self: process.pid };
    }),
  );
  put(
    'receipts.json',
    safe(() => verify(RECEIPTS, { acked: ackedHash() })),
  );
  put(
    'outbox.json',
    safe(() => {
      const s = outboxStats();
      return { lastError: s.lastError, behind: s.behind, shippedAt: s.shippedAt, unshippedBytes: s.unshippedBytes };
    }),
  );
  const pl = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8', timeout: 15000 });
  put('plugin-list.txt', pl.error ? `(claude plugin list unavailable: ${pl.error.message})` : (pl.stdout || '') + (pl.stderr || ''));
  const logs = join(state, 'logs');
  const streams = [];
  if (existsSync(logs))
    for (const n of readdirSync(logs).sort()) {
      const p = join(logs, n);
      if (statSync(p).isFile()) streams.push(`== ${n}\n${tail(read(p) ?? '')}`);
    }
  put('worker-streams.txt', streams.join('\n') || '(no worker streams)');
  return files;
}

/** Write the archive under <state>/bundles and return {path, size, sections}. */
export async function writeBundle(opts = {}) {
  const files = await collect(opts);
  const stage = mkdtempSync(join(tmpdir(), 'enforcer-bundle-'));
  try {
    const dir = join(stage, 'enforcer-bundle');
    mkdirSync(dir);
    for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t + '\n');
    writeFileSync(
      join(dir, 'MANIFEST.json'),
      JSON.stringify({ created: new Date().toISOString(), sections: SECTIONS, files: Object.keys(files) }, null, 2) + '\n',
    );
    const out = join(stateBase(), 'bundles');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const path = join(out, `enforcer-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
    // run in the output dir with a relative archive name: GNU tar reads a `C:\...` archive path as a remote host
    const r = spawnSync('tar', ['-czf', basename(path), '-C', stage, 'enforcer-bundle'], { encoding: 'utf8', cwd: dirname(path) });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr || r.error?.message}`);
    try {
      chmodSync(path, 0o600);
    } catch {}
    return { path, size: statSync(path).size, sections: SECTIONS };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
