// `enforcer doctor`: one line per check, `ok`/`fail`, exit non-zero on any fail.
import { defaultFetch } from '../lib/api/client.mjs';
import { existsSync, readFileSync, statSync, mkdirSync, chmodSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import { stateBase } from './state.mjs';
import { readCredentials, enforcerKey } from './credentials.mjs';
import { resolveConfig, validateEnv } from './config.mjs';
import { codexHookTrustCheck } from './codex-hook-trust.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function hookCommandsCheck(root = ROOT) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  } catch (e) {
    return { ok: false, detail: `hooks.json unreadable: ${e.message}` };
  }
  const missing = [];
  let n = 0;
  for (const groups of Object.values(doc.hooks || {}))
    for (const g of groups)
      for (const h of g.hooks || []) {
        for (const m of String(h.command || '').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
          n++;
          if (!existsSync(join(root, m[1]))) missing.push(m[1]);
        }
      }
  return missing.length
    ? { ok: false, detail: `missing under the plugin root: ${[...new Set(missing)].join(', ')}` }
    : { ok: true, detail: `${n} script paths resolve` };
}

// Hook commands in every harness config we know. A harness (Grok) ignores a failing hook, so a command that points at a
// deleted path is dead without a sound: report each one, naming the config file and the missing path. Read-only.
const SCRIPT_RE = /(?:~|\$HOME|\$\{HOME\}|[A-Za-z]:)?[\\/][^\s"'`;&|<>]*\.(?:mjs|cjs|js|sh|py|ts)\b/g;
function commandStrings(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => commandStrings(n, out));
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) k === 'command' && typeof v === 'string' ? out.push(v) : commandStrings(v, out);
  return out;
}
export function scriptPaths(cmd, home) {
  const found = [];
  for (const m of String(cmd).matchAll(SCRIPT_RE)) {
    let p = m[0];
    p = p.replace(/^(~|\$HOME|\$\{HOME\})/, () => home);
    if (p.includes('$')) continue; // an unresolved variable (${CLAUDE_PLUGIN_ROOT}) is checked elsewhere
    if (/^[\\/]/.test(p) && m.index > 0 && /[\w.}]/.test(String(cmd)[m.index - 1])) continue; // part of a relative path
    found.push(normalize(p)); // `~/x` expands to the native home plus a `/` tail: normalise so Windows gets one separator style
  }
  return found;
}
function hookConfigFiles(home) {
  const files = [];
  const grokDir = join(home, '.grok', 'hooks');
  try {
    for (const f of readdirSync(grokDir)) if (f.endsWith('.json')) files.push(join(grokDir, f));
  } catch {
    /* none */
  }
  for (const f of [join(home, '.codex', 'hooks.json'), join(home, '.codex', 'config.toml'), join(home, '.' + 'claude', 'settings.json')])
    if (existsSync(f)) files.push(f);
  return files;
}
export function deadHookPaths(home = homedir()) {
  const dead = [];
  for (const file of hookConfigFiles(home)) {
    let cmds = [];
    try {
      const text = readFileSync(file, 'utf8');
      cmds = file.endsWith('.toml')
        ? [...text.matchAll(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/gm)].map((m) => (m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].slice(1, -1)))
        : commandStrings(JSON.parse(text));
    } catch {
      continue;
    }
    for (const c of cmds) for (const p of scriptPaths(c, home)) if (!existsSync(p)) dead.push({ file, path: p });
  }
  return dead;
}
export function staleProjectInstalls(home = homedir()) {
  let reg;
  try {
    reg = JSON.parse(readFileSync(join(home, '.' + 'claude', 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const [key, list] of Object.entries(reg?.plugins || {})) {
    if (!/^enforcer@/.test(key) || !Array.isArray(list)) continue;
    for (const i of list)
      if (i?.scope === 'project' && i.projectPath && !existsSync(i.projectPath))
        out.push({ plugin: key, version: i.version || 'unknown', path: i.projectPath });
  }
  return out;
}
const vparts = (v) =>
  String(v)
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
export function versionLt(a, b) {
  const x = vparts(a),
    y = vparts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}
// The old `harness install grok` copied the plugin to ~/.config/enforcer/grok/<version>. Grok installs it natively
// now, so any copy left there is stale by definition: point at the migration that removes it.
export function grokRuntimeCheck(home = homedir()) {
  const base = join(home, '.config', 'enforcer', 'grok');
  if (!existsSync(base)) return null;
  return { ok: false, detail: `old runtime copy at ${base}: run enforcer harness uninstall grok` };
}

export const WINDOWS_STATEMENT =
  'Windows: MCP, files and the governor are supported; graph hooks are supported after the Node port; enforcer dispatch is POSIX only (no bash, chmod is a no-op so credential file protection is advisory, no process groups): use WSL for dispatch';

export async function runChecks({ fetchImpl = defaultFetch, network = true, platform = process.platform, home = homedir() } = {}) {
  const rows = [];
  const add = (name, c) => rows.push({ name, ...c });
  const major = Number(process.versions.node.split('.')[0]);
  add('node version', { ok: major >= 18, detail: process.versions.node });
  if (platform === 'win32') add('windows support', { ok: true, detail: WINDOWS_STATEMENT });
  add('dispatch platform', {
    ok: true,
    detail:
      platform === 'win32'
        ? 'enforcer dispatch is not supported on Windows (process groups and POSIX signals): use WSL'
        : `${process.platform}: enforcer dispatch supported`,
  });
  try {
    const d = stateBase();
    const fresh = !existsSync(d);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    if (fresh) chmodSync(d, 0o700);
    accessSync(d, constants.W_OK);
    const mode = statSync(d).mode & 0o777;
    add('state dir writable, 0700', { ok: process.platform === 'win32' || mode === 0o700, detail: `${d} mode ${mode.toString(8)}` });
  } catch (e) {
    add('state dir writable, 0700', { ok: false, detail: e.message });
  }
  const envErrors = validateEnv();
  add('environment variables valid', { ok: !envErrors.length, detail: envErrors.length ? envErrors.map((e) => e.message).join('; ') : 'ok' });
  const cred = readCredentials();
  add('credentials present', {
    ok: !!(enforcerKey() || cred?.enforcer?.oauth?.access_token),
    detail: enforcerKey() ? 'API key in environment' : cred?.enforcer?.oauth?.access_token ? 'browser sign-in' : 'none; run /enforcer:login',
  });
  if (network) {
    const base = resolveConfig({ saved: cred }).baseUrl;
    try {
      const r = await fetchImpl(`${base}/mcp`, { method: 'GET', signal: AbortSignal.timeout(5000) });
      add('MCP reachable', { ok: true, detail: `${base}/mcp answered HTTP ${r.status}` });
    } catch (e) {
      add('MCP reachable', { ok: false, detail: `${base}/mcp: ${e.cause?.code || e.message}` });
    }
  }
  add('hooks.json commands resolve', hookCommandsCheck());
  for (const d of deadHookPaths(home)) add('hook path exists', { ok: false, detail: `${d.file}: missing ${d.path}` });
  const stale = staleProjectInstalls(home);
  for (const x of stale) add('stale project install', { ok: false, detail: `${x.plugin} ${x.version} for ${x.path} (directory gone)` });
  if (stale.length)
    add('stale project installs', {
      ok: false,
      detail: `${stale.length} found. Report only, nothing was changed. To remove one, recreate its directory and run: claude plugin uninstall enforcer@instruxi --scope project (from that directory)`,
    });
  const grok = grokRuntimeCheck(home);
  if (grok) add('grok runtime copy', grok);
  const codexTrust = codexHookTrustCheck(home, home === homedir() ? undefined : { codexHome: join(home, '.codex') });
  if (codexTrust) add('codex hook approval', codexTrust);
  return rows;
}

export async function doctor(opts) {
  const rows = await runChecks(opts);
  for (const r of rows) process.stdout.write(`${r.ok ? 'ok  ' : 'fail'}  ${r.name}: ${r.detail}\n`);
  const bad = rows.filter((r) => !r.ok).length;
  process.stdout.write(bad ? `${bad} check(s) failed\n` : 'all checks passed\n');
  return bad ? 1 : 0;
}
