// Why Codex shows "hook: SessionStart Failed" for every Enforcer hook: Codex 0.164 runs a plugin's hook only
// after re-checking, at every run, that the user approved THIS plugin's contents (openai/codex rust-v0.164.0,
// codex-rs/hooks/src/engine/command_runner.rs:221 -> plugin_trust.rs:28). The approval lives in
// ~/.codex/config.toml as [hooks.state."enforcer@instruxi:hooks/codex/hooks.json:<event>:0:0"]:
//   trusted_hash          the hook declaration's hash
//   trusted_content_hash  a sha256 over the whole plugin directory (plugin_fingerprint.rs)
// The check fails, and the hook is reported Failed without ever being started, when:
//   - trusted_hash still holds the combined "<declaration>/<content>" value that hooks/list returns: Codex's
//     own writer splits it on save (app-server/src/config_manager_service.rs:364), and plugin_trust.rs:52
//     compares trusted_hash to the declaration hash alone, so a hand-copied combined value never matches;
//   - the plugin directory changed after approval -- every plugin update does (plugin_trust.rs:40).
// Nothing in Enforcer can approve hooks for the user, and should not: the remedy is Codex's own review,
// `/hooks` in an interactive `codex`. This module only says which case it is.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep, basename } from 'node:path';

export const PLUGIN_ID = 'enforcer@instruxi';
const SKIP = (name) => name === '__pycache__' || name === '.venv' || name.endsWith('.pyc') || name.endsWith('.egg-info');
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** Codex's plugin content hash (codex-rs/hooks/src/engine/plugin_fingerprint.rs), byte for byte. */
export function codexPluginContentHash(root) {
  if (!lstatSync(root).isDirectory()) throw new Error('plugin root is not a directory');
  const h = createHash('sha256').update('codex-plugin-bundle-v1');
  const pending = [root];
  const buf = Buffer.alloc(64 * 1024);
  while (pending.length) {
    const p = /** @type {string} */ (pending.pop());
    const rel = p === root ? '' : relative(root, p).split(sep).join('/');
    if (rel && SKIP(basename(rel))) continue;
    const name = Buffer.from(rel);
    h.update(u64(name.length)).update(name);
    const st = lstatSync(p);
    if (st.isDirectory()) {
      h.update('directory');
      // Rust sorts by the OsStr bytes of the file name
      const kids = readdirSync(p).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (let i = kids.length - 1; i >= 0; i--) pending.push(join(p, kids[i]));
    } else if (st.isFile()) {
      h.update('file').update(u64(st.size));
      const fd = openSync(p, 'r');
      try {
        let n;
        while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    } else throw new Error(`unsupported plugin entry type: ${p}`);
  }
  return `sha256:${h.digest('hex')}`;
}

/** The [hooks.state."enforcer@instruxi:..."] tables of a Codex config.toml: key -> {trusted_hash, trusted_content_hash, enabled}. */
export function enforcerHookStates(toml) {
  const states = {};
  let cur = null;
  for (const line of String(toml).split('\n')) {
    const head = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*"([^"]+)"\s*\]\s*(#.*)?$/.exec(line);
    if (head) {
      cur = head[1].startsWith(`${PLUGIN_ID}:`) ? (states[head[1]] = {}) : null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      cur = null;
      continue;
    }
    const kv = cur && /^\s*(trusted_hash|trusted_content_hash|enabled)\s*=\s*("([^"]*)"|true|false)/.exec(line);
    if (kv) cur[kv[1]] = kv[3] !== undefined ? kv[3] : kv[2] === 'true';
  }
  return states;
}

const vnum = (v) => v.split('.').map((x) => parseInt(x, 10) || 0);
const newer = (a, b) => {
  const x = vnum(a),
    y = vnum(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/** The doctor row for Codex hook approval; null when Enforcer is not a Codex plugin here. */
export function codexHookTrustCheck(home = homedir(), { codexHome = process.env.CODEX_HOME || join(home, '.codex') } = {}) {
  const cfgFile = join(codexHome, 'config.toml');
  if (!existsSync(cfgFile)) return null;
  const toml = readFileSync(cfgFile, 'utf8');
  if (!toml.includes(`[plugins."${PLUGIN_ID}"]`)) return null;
  const cache = join(codexHome, 'plugins', 'cache', 'instruxi', 'enforcer');
  const versions = existsSync(cache) ? readdirSync(cache).filter((v) => /^\d/.test(v)) : [];
  if (!versions.length) return { ok: false, detail: `${PLUGIN_ID} is enabled in ${cfgFile} but not installed in ${cache}` };
  const version = versions.reduce((a, b) => (newer(b, a) ? b : a));
  const states = Object.entries(enforcerHookStates(toml)).filter(([, s]) => s.enabled !== false);
  const review = 'open an interactive `codex`, run /hooks and approve the Enforcer hooks';
  if (!states.length) return { ok: false, detail: `Codex has not approved Enforcer's hooks yet, so it does not run them: ${review}` };
  const combined = states.filter(([, s]) => (s.trusted_hash || '').includes('/'));
  if (combined.length)
    return {
      ok: false,
      detail: `${combined.length} Enforcer hook approval(s) in ${cfgFile} hold "<declaration>/<content>" in trusted_hash, which Codex 0.164 never matches (every hook shows Failed): ${review}`,
    };
  let current;
  try {
    current = codexPluginContentHash(join(cache, version));
  } catch (e) {
    return { ok: false, detail: `could not fingerprint ${join(cache, version)}: ${e.message}` };
  }
  const stale = states.filter(([, s]) => s.trusted_content_hash && s.trusted_content_hash !== current);
  if (stale.length)
    return { ok: false, detail: `enforcer ${version} changed since its hooks were approved, so Codex reports them Failed without running them: ${review}` };
  return { ok: true, detail: `enforcer ${version}: ${states.length} hook approval(s) match the installed plugin` };
}
