// `enforcer harness install cursor [--repo <dir>] [--dry-run] [--force]` / `uninstall cursor`.
//
// Cursor installs the plugin natively (.cursor-plugin/plugin.json points at hooks/cursor/hooks.json).
// This is the other way in, for a machine without the plugin and for cloud agents:
//   - default: ~/.cursor/hooks.json (user hooks, every workspace). Its commands name
//     ~/.enforcer/enforcer-cursor-hook.mjs, a stable launcher that follows ~/.enforcer/cursor-root,
//     so an update that moves this package never leaves a hooks file pointing at nothing.
//   - --repo <dir>: <dir>/.cursor/hooks.json plus <dir>/.cursor/enforcer-cursor-hook.mjs, to commit.
//     Cloud agents run only a project's hooks; the launcher finds enforcer on the VM ($ENFORCER_ROOT,
//     the `enforcer` on PATH, or node_modules/@instruxi-io/enforcer).
// Other hooks in the file are kept; ours are found by the launcher's file name and replaced.
// One way in per machine: the install refuses (unless --force) when the enforcer Cursor plugin, the
// other scope's hooks file, or an enforcer command it did not write would also fire. Should two
// fire anyway, `enforcer event` decides each Cursor event once (src/cursor-once.mjs).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync, realpathSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DOT as CLAUDE_DOT } from '../hooks/claude/paths.mjs';
import { SHARED_DIR } from './credentials.mjs';

export const LAUNCHER = 'enforcer-cursor-hook.mjs';
/** Cursor event -> timeout (s). preToolUse fails closed: a governor that cannot run is not an allow. */
export const CURSOR_HOOKS = {
  preToolUse: 30,
  postToolUse: 10,
  postToolUseFailure: 10,
  sessionStart: 15,
  sessionEnd: 10,
  beforeSubmitPrompt: 10,
  subagentStart: 10,
  subagentStop: 10,
  preCompact: 15,
  stop: 10,
};
const FAIL_CLOSED = new Set(['preToolUse', 'subagentStart']);
const CLAUDE_TOO =
  'Claude Code\'s enforcer plugin is installed too: Cursor also runs Claude Code hooks when "third-party plugins" is on. enforcer counts each event once either way.';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;

/** The launcher every hook command runs. `mode` is 'user' or 'repo'. */
export function launcherSource(mode) {
  return [
    '#!/usr/bin/env node',
    `// Written by \`enforcer harness install cursor${mode === 'repo' ? ' --repo' : ''}\`. Runs enforcer's Cursor hook shim`,
    '// (hooks/cursor/shim.mjs) from wherever enforcer is installed; edit nothing here, re-run the install.',
    "import { existsSync, readFileSync, realpathSync } from 'node:fs';",
    "import { delimiter, dirname, join } from 'node:path';",
    "import { homedir } from 'node:os';",
    "import { spawnSync } from 'node:child_process';",
    "const shim = (r) => r && join(r, 'hooks', 'cursor', 'shim.mjs');",
    'const ok = (r) => !!r && existsSync(shim(r));',
    'function root() {',
    '  if (ok(process.env.ENFORCER_ROOT)) return process.env.ENFORCER_ROOT;',
    "  const shared = process.env.ENFORCER_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.enforcer');",
    "  try { const r = readFileSync(join(shared, 'cursor-root'), 'utf8').trim(); if (ok(r)) return r; } catch {}",
    ...(mode === 'repo'
      ? [
          "  const local = join(process.env.CURSOR_PROJECT_DIR || process.cwd(), 'node_modules', '@instruxi-io', 'enforcer');",
          '  if (ok(local)) return local;',
          "  for (const d of (process.env.PATH || '').split(delimiter)) {",
          "    try { const r = dirname(dirname(realpathSync(join(d, 'enforcer')))); if (ok(r)) return r; } catch {}",
          '  }',
        ]
      : []),
    "  return '';",
    '}',
    'const r = root();',
    'const event = process.argv[2] || "";',
    'if (!r) {',
    "  const m = 'enforcer is not installed here: npm i -g @instruxi-io/enforcer, or set ENFORCER_ROOT';",
    '  process.stderr.write(`enforcer-governor: ${m}\\n`);',
    "  if (event === 'preToolUse' || event === 'subagentStart') { process.stdout.write(JSON.stringify({ permission: 'deny', user_message: m, agent_message: m }) + '\\n'); process.exit(0); }",
    '  process.exit(1);',
    '}',
    "const c = spawnSync(process.execPath, [shim(r), ...process.argv.slice(2)], { stdio: 'inherit' });",
    'process.exit(c.status ?? 1);',
    '',
  ].join('\n');
}

/** Cursor's hooks.json entries for `command(event)`. */
export function hookEntries(command) {
  return Object.fromEntries(
    Object.entries(CURSOR_HOOKS).map(([ev, timeout]) => [ev, { command: command(ev), timeout, ...(FAIL_CLOSED.has(ev) ? { failClosed: true } : {}) }]),
  );
}

const ours = (h) => typeof h?.command === 'string' && h.command.includes(LAUNCHER);
// An enforcer hook this installer did not write: the plugin's shim named directly, or `enforcer event`.
const foreign = (h) => typeof h?.command === 'string' && !ours(h) && /hooks[\\/]cursor[\\/]shim\.mjs|\benforcer(\.mjs)?["']?\s+event\b/.test(h.command);

/** `cfg` with our hooks replaced by `entries` (or removed when null). Other hooks are kept. */
export function mergeHooks(cfg, entries) {
  const out = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? { ...cfg } : {};
  if (out.version === undefined) out.version = 1;
  const hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? { ...out.hooks } : {};
  for (const ev of new Set([...Object.keys(hooks), ...Object.keys(CURSOR_HOOKS)])) {
    const kept = (Array.isArray(hooks[ev]) ? hooks[ev] : []).filter((h) => !ours(h));
    if (entries?.[ev]) kept.push(entries[ev]);
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  out.hooks = hooks;
  return out;
}

export const userHooksPath = (home = homedir()) => join(home, '.cursor', 'hooks.json');

/** Where the files go for this install. */
export function plan({ home = homedir(), repo = null, shared = SHARED_DIR() } = {}) {
  if (repo) {
    const dir = join(resolve(repo), '.cursor');
    // Project hooks run from the project root: a relative path survives a clone anywhere.
    return { mode: 'repo', hooks: join(dir, 'hooks.json'), launcher: join(dir, LAUNCHER), command: (ev) => `node .cursor/${LAUNCHER} ${ev}`, rootFile: null };
  }
  const launcher = join(shared, LAUNCHER);
  return { mode: 'user', hooks: userHooksPath(home), launcher, command: (ev) => `node ${q(launcher)} ${ev}`, rootFile: join(shared, 'cursor-root') };
}

const readJson = (p) => {
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8')); // a malformed file throws: never overwrite what we cannot read
};
const writeAtomic = (p, text, mode = 0o644) => {
  mkdirSync(dirname(p), { recursive: true });
  const keep = existsSync(p) ? statSync(p).mode & 0o777 : mode;
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: keep });
  renameSync(tmp, p);
};

// Every hook entry in a hooks file; an unreadable file has none.
const entriesOf = (p) => {
  try {
    const h = readJson(p).hooks || {};
    return Object.values(h).flatMap((v) => (Array.isArray(v) ? v : []));
  } catch {
    return [];
  }
};

/** Is enforcer wired into this hooks file? */
export function wired(hooksPath) {
  try {
    const h = readJson(hooksPath).hooks || {};
    return Object.keys(CURSOR_HOOKS).every((ev) => (h[ev] || []).some(ours));
  } catch {
    return false;
  }
}

/** Is Cursor on this machine? ~/.cursor, or the `cursor` / `cursor-agent` / `agent` binary on PATH. */
export function detect({ home = homedir(), env = process.env } = {}) {
  if (existsSync(join(home, '.cursor'))) return true;
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of String(env.PATH || '')
    .split(sep)
    .filter(Boolean))
    for (const b of ['cursor', 'cursor-agent', 'agent'])
      for (const x of exts) {
        const f = join(d, b + x);
        if (!existsSync(f)) continue;
        // `agent` is the Cursor CLI's name, but a generic one: count it only when it resolves into Cursor's install.
        if (b !== 'agent') return true;
        try {
          if (/cursor/i.test(realpathSync(f))) return true;
        } catch {}
      }
  return false;
}

/** The enforcer Cursor plugin's root, when Cursor has it installed (~/.cursor/plugins/...), else null. */
export function pluginInstalled({ home = homedir() } = {}) {
  const walk = (d, depth) => {
    if (depth > 5) return null;
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return null;
    }
    if (names.some((n) => n.name === '.cursor-plugin')) {
      try {
        const m = JSON.parse(readFileSync(join(d, '.cursor-plugin', 'plugin.json'), 'utf8'));
        if (m?.name === 'enforcer' && existsSync(join(d, 'hooks', 'cursor', 'shim.mjs'))) return d;
      } catch {}
    }
    for (const n of names) {
      if (!n.isDirectory() || n.name === 'node_modules' || n.name === '.git') continue;
      const r = walk(join(d, n.name), depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(join(home, '.cursor', 'plugins'), 0);
}

/** Enforcer installs that would fire alongside this one, as sentences. */
export function conflicts({ home = homedir(), repo = null, cwd = process.cwd(), shared = undefined } = {}) {
  const p = plan({ home, repo, shared: shared ?? SHARED_DIR() });
  const found = [];
  const plugin = pluginInstalled({ home });
  if (plugin) found.push(`the enforcer Cursor plugin is installed (${plugin}) and runs these hooks already`);
  if (entriesOf(p.hooks).some(foreign)) found.push(`${p.hooks} already runs enforcer through another command`);
  const other = repo ? userHooksPath(home) : join(resolve(cwd), '.cursor', 'hooks.json');
  if (resolve(other) !== resolve(p.hooks) && entriesOf(other).some((h) => ours(h) || foreign(h)))
    found.push(`${other} already runs enforcer's hooks (${repo ? 'user hooks' : 'this repo'})`);
  return found;
}

// Claude Code has the enforcer plugin: Cursor runs its hooks too when third-party plugins are on.
const claudePlugin = (home) => {
  try {
    return /"enforcer[@"]/.test(readFileSync(join(home, CLAUDE_DOT, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return false;
  }
};

export function install({
  home = homedir(),
  repo = null,
  dryRun = false,
  root = PACKAGE_ROOT,
  shared = undefined,
  force = false,
  cwd = process.cwd(),
  now = Date.now,
  out = (s) => process.stdout.write(s + '\n'),
} = {}) {
  const p = plan({ home, repo, shared: shared ?? SHARED_DIR() });
  const next = mergeHooks(readJson(p.hooks), hookEntries(p.command));
  const dup = conflicts({ home, repo, cwd, shared });
  if (dup.length && !force) {
    out(`Not installed: ${dup.join('; ')}. Two enforcer hooks on one Cursor would both fire; keep one, or pass --force to install anyway.`);
    return { ok: false, ...p, conflicts: dup };
  }
  if (dup.length) out(`Installing anyway (--force): ${dup.join('; ')}. enforcer decides each Cursor event once, so the extra hook only costs a process.`);
  if (claudePlugin(home)) out(CLAUDE_TOO);
  if (dryRun) {
    out(`would write ${p.hooks} and ${p.launcher}${p.rootFile ? ` and ${p.rootFile} (${root})` : ''}`);
    return { ok: true, ...p, config: next };
  }
  writeAtomic(p.launcher, launcherSource(p.mode), 0o755);
  if (p.rootFile) writeAtomic(p.rootFile, root + '\n', 0o600);
  // The first time enforcer touches someone's hooks file, keep a copy of it as it was.
  let backup = null;
  if (existsSync(p.hooks) && !entriesOf(p.hooks).some(ours)) {
    backup = `${p.hooks}.bak-${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`;
    copyFileSync(p.hooks, backup);
    out(`Backed up ${p.hooks} to ${backup}.`);
  }
  writeAtomic(p.hooks, JSON.stringify(next, null, 2) + '\n');
  out(`Cursor hooks written to ${p.hooks}.`);
  if (p.mode === 'repo')
    out(`Commit ${p.hooks} and ${p.launcher}. Cloud agents need enforcer on the VM (npm i -g @instruxi-io/enforcer in the environment's install step).`);
  else out('Restart Cursor (or reopen the workspace) to load them.');
  return { ok: true, ...p, config: next, backup, conflicts: dup };
}

export function uninstall({ home = homedir(), repo = null, dryRun = false, shared = undefined, out = (s) => process.stdout.write(s + '\n') } = {}) {
  const p = plan({ home, repo, shared: shared ?? SHARED_DIR() });
  if (!existsSync(p.hooks)) {
    out(`nothing to remove: ${p.hooks} does not exist`);
    return { ok: true, ...p };
  }
  const next = mergeHooks(readJson(p.hooks), null);
  if (dryRun) {
    out(`would remove enforcer's hooks from ${p.hooks}`);
    return { ok: true, ...p, config: next };
  }
  writeAtomic(p.hooks, JSON.stringify(next, null, 2) + '\n');
  rmSync(p.launcher, { force: true });
  if (p.rootFile) rmSync(p.rootFile, { force: true });
  out(`Removed enforcer's hooks from ${p.hooks}.`);
  return { ok: true, ...p, config: next };
}

/** argv after `harness install|uninstall cursor`. */
export function main(verb, argv) {
  const i = argv.indexOf('--repo');
  const repo = i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '.';
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  try {
    return (verb === 'uninstall' ? uninstall({ repo, dryRun }) : install({ repo, dryRun, force })).ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(`enforcer: not changed: ${e.message}\n`);
    return 1;
  }
}
