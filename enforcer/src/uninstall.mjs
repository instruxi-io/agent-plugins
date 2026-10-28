// `enforcer uninstall [--purge] [--yes]`: undo what install and telemetry enable wrote, by manifest, and say what is left.
// --purge also deletes the credentials and ~/.config/enforcer state, after confirmation.
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { disable as disableTelemetry } from '../lib/governor/adapters/claude-code/telemetry.mjs';
import { disable as disableCodexTelemetry } from '../lib/governor/adapters/codex/telemetry.mjs';
import { SHARED_DIR, SHARED_FILE } from './credentials.mjs';
import { configHome } from './state.mjs';
import { uninstall as uninstallGrok } from './grok-install.mjs';
import { uninstall as uninstallCodex } from './codex-install.mjs';

const ask = (q) =>
  new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(/^y(es)?$/i.test(a.trim()));
    });
  });

export async function uninstall({ purge = false, yes = false, home = homedir(), confirm = ask, out = (s) => process.stdout.write(s + '\n') } = {}) {
  const removed = [],
    left = [];
  // 1. OTEL settings entries (only the keys enable() wrote) and the headers shim + plugin-root
  try {
    const r = disableTelemetry();
    removed.push(`OTEL entries in ${r.settings}`);
  } catch (e) {
    left.push(`OTEL entries in Claude settings (${e.message})`);
  }
  // Codex's [otel] keys (only the ones its enable wrote); config.toml under this home unless CODEX_HOME says otherwise
  try {
    const r = disableCodexTelemetry({ env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || join(home, '.codex') } });
    if (r.changed) removed.push(`OTEL entries in ${r.config}`);
  } catch (e) {
    left.push(`OTEL entries in Codex config.toml (${e.message})`);
  }
  for (const f of ['otel-headers.mjs', 'plugin-root']) {
    const p = join(SHARED_DIR(), f);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(p);
    }
  }
  // 2. harness installs, by their manifests
  for (const [name, fn] of [
    ['grok', uninstallGrok],
    ['codex', uninstallCodex],
  ]) {
    try {
      const r = await /** @type {any} */ (fn)({ home, yes: true, out: () => {} });
      if (r.removed?.length) removed.push(...r.removed.map((x) => `${name}: ${x}`));
    } catch (e) {
      left.push(`${name} install (${e.message})`);
    }
  }
  // 3. purge: credentials and state, after confirmation
  const cfg = configHome();
  const creds = SHARED_FILE();
  if (purge) {
    const targets = [creds, cfg].filter((t) => existsSync(t));
    if (targets.length && (yes || (await confirm(`--purge deletes ${targets.join(' and ')}. You will be signed out. Proceed? [y/N] `)))) {
      for (const t of targets) {
        rmSync(t, { recursive: true, force: true });
        removed.push(t);
      }
    } else if (targets.length) left.push(...targets.map((t) => `${t} (purge declined)`));
  } else {
    for (const t of [creds, cfg]) if (existsSync(t)) left.push(`${t} (rerun with --purge to delete)`);
  }
  for (const r of removed) out(`removed ${r}`);
  for (const l of left) out(`left ${l}`);
  if (!removed.length && !left.length) out('nothing to remove');
  return { ok: true, removed, left };
}

export async function main(argv) {
  const r = await uninstall({ purge: argv.includes('--purge'), yes: argv.includes('--yes') || argv.includes('-y') });
  return r.ok ? 0 : 1;
}
