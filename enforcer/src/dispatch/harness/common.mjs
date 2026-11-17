// What every harness adapter shares: where this plugin lives, the plugin dirs a worker loads, the route token, and the
// stream reader. Nothing here knows a harness by name; see ./index.mjs for the adapter shape.
import { readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOT } from '../../../hooks/claude/paths.mjs';

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const LAND_PR = join(PLUGIN_DIR, 'bin', 'land-pr.sh');

export function pluginNameOf(d) {
  for (const rel of ['plugin.json', join(DOT + '-plugin', 'plugin.json')]) {
    try {
      const n = JSON.parse(readFileSync(join(d, rel), 'utf8')).name;
      if (n) return String(n);
    } catch {
      /* next */
    }
  }
  return null;
}

/** This plugin, then each extra dir, once per real path AND once per plugin name (first wins):
 *  the same plugin twice means two governors answer every tool call. */
export function pluginDirs(extra = []) {
  const out = [];
  const seen = new Set();
  const names = new Set();
  for (const d of [PLUGIN_DIR, ...(extra || [])]) {
    let r;
    try {
      r = realpathSync(d);
    } catch {
      r = d;
    }
    if (seen.has(r)) continue;
    const n = pluginNameOf(d);
    if (n && names.has(n)) continue;
    seen.add(r);
    if (n) names.add(n);
    out.push(d);
  }
  return out;
}

/** The route endpoint's token, read only from the variable its `token_env` names (never argv, never a file); null when it names none. */
export const routeToken = (route, env = process.env) => {
  const name = route?.endpoint?.token_env;
  const v = name ? env[name] : null;
  return typeof v === 'string' && v ? v : null;
};

/** True when `model` is one this harness's CLI knows by name (`caps.models` prefixes; null means any). */
export const knowsModel = (caps, model) => {
  const pre = caps?.models;
  return Boolean(model) && (!pre || pre.some((p) => String(model).startsWith(p)));
};

/** A worker's stream file, or null when it cannot be read. */
export function readStream(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
