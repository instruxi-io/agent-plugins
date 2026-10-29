// `enforcer harness install|uninstall <grok|codex|gemini>`: all three are the same migration off the old runtime copy.
// Grok and Codex install the plugin natively now, and its hooks run from the plugin root, so the copy at
// ~/.config/enforcer/<harness>/<version>, the hooks/agent files pointing at it and the ~/.local/bin/enforcer
// shim are leftovers. This removes exactly what the old install's manifest.json lists, restores the
// `.enforcer-bak-*` files it recorded, and prints the native install command. No manifest: nothing written.
import { readFileSync, writeFileSync, existsSync, rmSync, rmdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { assertSchema } from './schema.mjs';
import { resolveConfig } from './config.mjs';

export const HARNESSES = ['grok', 'codex', 'gemini'];
export const NATIVE = {
  grok: 'grok plugin marketplace add instruxi-io/agent-plugins && grok plugin install enforcer --trust',
  codex: 'codex plugin marketplace add instruxi-io/agent-plugins && codex plugin add enforcer@instruxi',
  // Gemini has no plugin marketplace for our hooks: only the graph MCP server is wired, at user scope.
  gemini: 'gemini mcp add --scope user --transport http --trust enforcer <mcp-url> -H "X-API-Key: $ENFORCER_API_KEY"',
};
/** The native install command, with gemini's `<mcp-url>` filled in from the resolved config when it resolves. */
export function nativeCmd(harness) {
  let url = null;
  try {
    url = resolveConfig().mcpUrl;
  } catch {
    /* no config: leave the placeholder */
  }
  return url ? NATIVE[harness].replace('<mcp-url>', url) : NATIVE[harness];
}
export const shimPath = (home = homedir()) => join(home, '.local', 'bin', 'enforcer');
export const baseDir = (harness, home = homedir()) => join(home, '.config', 'enforcer', harness);
export const manifestPath = (harness, home = homedir()) => join(baseDir(harness, home), 'manifest.json');

const BAK = /\.enforcer-bak-[0-9-]+$/;

// The old [mcp_servers.enforcer] section, cut out of a config.toml.
const HEADER = /^\s*\[\[?\s*[^\]\s][^\]]*\]\]?\s*(#.*)?$/;
export function removeMcp(toml) {
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim().replace(/\s+/g, '') === '[mcp_servers.enforcer]');
  if (start < 0) return toml;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (HEADER.test(lines[i])) {
      end = i;
      break;
    }
  lines.splice(start, end - start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// manifest.backups is {target: backup} or [backup, ...] (target = the backup path without its suffix).
function backupsOf(man) {
  const b = man.backups;
  if (!b) return [];
  if (Array.isArray(b)) return b.filter((x) => BAK.test(x)).map((x) => ({ target: x.replace(BAK, ''), backup: x }));
  return Object.entries(b).map(([target, backup]) => ({ target, backup: String(backup) }));
}

// Is the shim this harness's to remove? Grok listed it in files; Codex recorded `shim` only when it wrote it.
// Either way, leave it while the other harness's manifest still claims it.
function ownsShim(harness, man, home) {
  const shim = shimPath(home);
  const mine = man.shim === shim || (man.files || []).includes(shim);
  if (!mine) return false;
  for (const other of HARNESSES.filter((h) => h !== harness)) {
    const mp = manifestPath(other, home);
    if (!existsSync(mp)) continue;
    try {
      const o = JSON.parse(readFileSync(mp, 'utf8'));
      if (o.shim === shim || (o.files || []).includes(shim)) return false;
    } catch {
      return false; // unreadable: assume it still needs the shim
    }
  }
  return true;
}

export function migrate(harness, { dryRun = false, home = homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness ${harness}`);
  const mp = manifestPath(harness, home);
  const native = () => out(`install ${harness} natively:\n  ${nativeCmd(harness)}`);
  if (!existsSync(mp)) {
    out(`no old ${harness} runtime copy (no ${mp}); nothing to remove`);
    native();
    return { ok: true, removed: [], restored: [] };
  }
  const man = assertSchema(JSON.parse(readFileSync(mp, 'utf8')), mp);
  const shim = shimPath(home);
  const keepShim = !ownsShim(harness, man, home);
  const backups = backupsOf(man);
  const restoredTargets = new Set(backups.map((b) => b.target));
  const targets = [man.runtime, man.versionFile, ...(man.files || []), ...(man.skills || []), ...(man.shim ? [man.shim] : [])]
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i)
    .filter((t) => !(t === shim && keepShim))
    .filter((t) => !restoredTargets.has(t));
  const verb = (w) => (dryRun ? `would ${w}` : `${w.replace(/e$/, '')}ing`);
  const removed = [],
    restored = [];
  for (const t of targets) {
    if (!existsSync(t)) continue;
    out(`${verb('remove')} ${t}`);
    if (!dryRun) rmSync(t, { recursive: true, force: true });
    removed.push(t);
  }
  if (keepShim && existsSync(shim) && (man.shim === shim || (man.files || []).includes(shim))) out(`left ${shim}: another harness's manifest still uses it`);
  for (const { target, backup } of backups) {
    if (!existsSync(backup)) {
      out(`backup ${backup} is gone; ${target} left as it is`);
      continue;
    }
    out(`${verb('restore')} ${target} from ${backup}`);
    if (!dryRun) {
      rmSync(target, { recursive: true, force: true });
      renameSync(backup, target);
    }
    restored.push(target);
  }
  if (man.configSectionAdded && man.config && !restoredTargets.has(man.config) && existsSync(man.config)) {
    const cur = readFileSync(man.config, 'utf8'),
      next = removeMcp(cur);
    if (next !== cur) {
      out(`${verb('remove')} [mcp_servers.enforcer] from ${man.config}`);
      if (!dryRun) writeFileSync(man.config, next);
      removed.push(`${man.config} [mcp_servers.enforcer]`);
    }
  }
  out(`${verb('remove')} ${mp}`);
  if (!dryRun) {
    rmSync(mp, { force: true });
    try {
      rmdirSync(baseDir(harness, home));
    } catch {
      /* holds files that are not ours */
    }
  }
  removed.push(mp);
  native();
  return { ok: true, dryRun, removed, restored };
}
