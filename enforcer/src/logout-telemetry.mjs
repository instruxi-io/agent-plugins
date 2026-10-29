// Sign-out for the harness telemetry keys (src/ingest-key.mjs): `enforcer logout` calls forgetTelemetry
// BEFORE it removes the sign-in, so a signed-out machine stops exporting telemetry now rather than when
// the key expires.
//
//   1. revoke each cached key with v3 where the sign-in may (best effort: the default sign-in lacks
//      enforcer:agents-credentials.destructive, so those are reported and expire on their own), and delete
//      ~/.enforcer/ingest-keys.json
//   2. take the key out of each harness config, through that harness's own off path:
//        Codex     ~/.codex/config.toml managed [otel] keys      (codex telemetry disable)
//        Gemini    ~/.gemini/.env managed block (+ settings.json) (gemini disable, record: false)
//        OpenClaw  ~/.openclaw/openclaw.json diagnostics.otel     (openclaw disable, ours only)
//        Hermes    nothing: it asks `enforcer ingest-key` for the key each time and keeps none on disk
//   3. say which files still hold a key, if any
//
// None of this records an opt-out: Codex's codexTelemetry, Gemini's gemini-telemetry.json and OpenClaw's
// plugins.entries.enforcer.config.telemetry are left as they are, so the next sign-in turns telemetry back on.
// Every step fails open; sign-out never depends on it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { forgetIngestKeys, REVOKE_WHY } from './ingest-key.mjs';

const home = (env) => env.HOME || env.USERPROFILE || homedir();

/** OpenClaw's config file: OPENCLAW_CONFIG_PATH, else <OPENCLAW_STATE_DIR or ~/.openclaw>/openclaw.json. */
export const openclawConfigPath = (env = process.env) =>
  env.OPENCLAW_CONFIG_PATH || join(env.OPENCLAW_STATE_DIR || join(home(env), '.openclaw'), 'openclaw.json');

/** Codex: remove the managed [otel] keys when they are there (codex telemetry's own disable). A line, or null. */
export async function removeCodexKey(env = process.env) {
  const codex = await import('../lib/governor/adapters/codex/telemetry.mjs');
  const p = codex.CODEX_CONFIG(env);
  try {
    const s = codex.status({}, { env });
    if (s.error) return `Codex: could not read ${p} (${s.error}); remove the Enforcer [otel] exporter from it by hand.`;
    if (!s.managed && !s.on) return null;
    return codex.disable({ env }).changed ? `Codex: removed the telemetry key from ${p}.` : null;
  } catch (e) {
    return `Codex: could not edit ${p} (${/** @type {any} */ (e)?.message || e}); remove the Enforcer [otel] exporter from it by hand.`;
  }
}

/** Gemini CLI: remove the managed .env block and settings (gemini's disable) without recording an opt-out. */
export async function removeGeminiKey(env = process.env) {
  const gemini = await import('./gemini-telemetry.mjs');
  const o = { env, home: home(env) };
  if (!gemini.geminiPresent(o)) return null;
  try {
    const r = gemini.disable({ ...o, record: false });
    return r.changed ? `Gemini CLI: removed the telemetry key from ${r.env}.` : null;
  } catch (e) {
    return `Gemini CLI: could not edit ${gemini.envPath(o)} (${/** @type {any} */ (e)?.message || e}); remove the block between the enforcer markers by hand.`;
  }
}

/** OpenClaw: drop diagnostics.otel when it is ours (openclaw's disable), leaving its telemetry switch alone. */
export async function removeOpenclawKey(env = process.env) {
  const openclaw = await import('./openclaw.mjs');
  const p = openclawConfigPath(env);
  if (!existsSync(p)) return null;
  try {
    const text = readFileSync(p, 'utf8');
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch {
      // OpenClaw also reads JSON5; rewriting that here would lose its comments.
      return text.includes(openclaw.OTLP_SUFFIX)
        ? `OpenClaw: ${p} is not plain JSON, so it was left as it is; run \`openclaw config unset diagnostics.otel\` to remove the telemetry key.`
        : null;
    }
    if (openclaw.owner(cfg) !== 'ours') return null;
    openclaw.disable(cfg);
    const mode = statSync(p).mode & 0o777;
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, p);
    return `OpenClaw: removed the telemetry key from ${p} (a running Gateway keeps its exporter until it reloads its config or restarts).`;
  } catch (e) {
    return `OpenClaw: could not edit ${p} (${/** @type {any} */ (e)?.message || e}); run \`openclaw config unset diagnostics.otel\`.`;
  }
}

/** Files in the harness and Enforcer dirs (top level, small) that still contain one of `keys`. */
export function filesHoldingKeys(keys, env = process.env) {
  const secrets = keys.filter((k) => typeof k === 'string' && k.length >= 8);
  if (!secrets.length) return [];
  const dirs = new Set([
    env.ENFORCER_HOME || join(home(env), '.enforcer'),
    env.CODEX_HOME || join(home(env), '.codex'),
    join(env.GEMINI_CLI_HOME || home(env), '.gemini'),
    dirname(openclawConfigPath(env)),
  ]);
  const hits = [];
  for (const d of dirs) {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const f = join(d, n);
      try {
        const st = statSync(f);
        if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
        const text = readFileSync(f, 'utf8');
        if (secrets.some((k) => text.includes(k))) hits.push(f);
      } catch {
        /* unreadable: not ours to report */
      }
    }
  }
  return hits;
}

const listIds = (xs) => xs.map((x) => `${x.harness} ${x.credentialId}${x.expiresAt ? ` (expires ${x.expiresAt})` : ''}`).join(', ');

/**
 * The whole telemetry sign-out. Resolves to the lines to print (none when there was nothing to do). Never throws.
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: typeof fetch, forget?: typeof forgetIngestKeys }} [o]
 */
export async function forgetTelemetry({ env = process.env, fetchImpl = globalThis.fetch, forget = forgetIngestKeys } = {}) {
  const lines = [];
  let keys = [];
  try {
    const r = await forget({ fetchImpl });
    keys = r.keys;
    if (r.revoked.length) lines.push(`Telemetry keys revoked on the server: ${r.revoked.map((x) => `${x.harness} ${x.credentialId}`).join(', ')}.`);
    const byWhy = new Map();
    for (const x of r.notRevoked) byWhy.set(x.why, [...(byWhy.get(x.why) || []), x]);
    for (const [why, xs] of byWhy) {
      lines.push(
        `Telemetry keys NOT revoked on the server (${REVOKE_WHY[why] || why}): ${listIds(xs)}. They are removed from this machine and stop working when they expire; revoke them sooner in the Enforcer console.`,
      );
    }
    if (r.keys.length || r.revoked.length || r.notRevoked.length) lines.push(`Deleted the telemetry key cache ${r.file}.`);
  } catch (e) {
    lines.push(`Telemetry keys: could not clear the cache (${/** @type {any} */ (e)?.message || e}).`);
  }
  for (const step of [removeCodexKey, removeGeminiKey, removeOpenclawKey]) {
    try {
      const l = await step(env);
      if (l) lines.push(l);
    } catch (e) {
      lines.push(`Telemetry: a harness config could not be cleaned (${/** @type {any} */ (e)?.message || e}).`);
    }
  }
  try {
    const left = filesHoldingKeys(keys, env);
    if (left.length) lines.push(`Still holding a telemetry key (remove it by hand): ${left.join(', ')}.`);
  } catch {
    /* best effort */
  }
  if (lines.length) lines.push('Telemetry comes back on at the next sign-in, as before (nothing was turned off for good).');
  return lines;
}
