// The one config resolver. Every component that needs to know which Enforcer
// server it talks to, or where state lives, asks here (the hooks and the dispatcher
// call it; docs/CONFIG.md is the contract).
//
// Base URL precedence, highest first:
//   1. an explicit flag (--base-url)
//   2. ENFORCER_BASE_URL
//   3. base_url saved in ~/.enforcer/credentials.json by the last sign-in
//   4. DEFAULT_BASE_URL (production)
// GRAPH_BASE_URL is a narrower override of the graph API URL only.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readCredentials } from './credentials.mjs';

/** Production origin. credentials.mjs re-exports it. */
export const DEFAULT_BASE_URL = 'https://api.instruxi.dev';

export class ConfigError extends Error {
  constructor(variable, message) {
    super(`${variable}: ${message}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

const num = (min, max) => (v, name) => {
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n) || n < min || n > max) throw new ConfigError(name, `must be a number between ${min} and ${max}, got "${v}"`);
};
const url = (v, name) => {
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(name, `must be an absolute http(s) URL, got "${v}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError(name, `must be http(s), got "${v}"`);
};
const oneOf =
  (...ok) =>
  (v, name) => {
    if (!ok.includes(v)) throw new ConfigError(name, `must be one of ${ok.join(', ')}, got "${v}"`);
  };
const flag = oneOf('0', '1', 'true', 'false', '', 'yes', 'no');
const nonEmpty = (v, name) => {
  if (!v.trim()) throw new ConfigError(name, 'must not be blank');
};

/** Every variable the plugin reads: name -> {default, check}. docs/CONFIG.md lists these. */
export const VARS = {
  ENFORCER_BASE_URL: { default: DEFAULT_BASE_URL, check: url },
  ENFORCER_API_KEY: { default: '(none)', check: nonEmpty },
  ENFORCER_HOME: { default: '~/.enforcer', check: nonEmpty },
  ENFORCER_CONFIG_HOME: { default: '~/.config/enforcer', check: nonEmpty },
  ENFORCER_STATE_DIR: { default: '<config home>/sessions/<harness>', check: nonEmpty },
  ENFORCER_HARNESS: { default: 'claude', check: oneOf('claude', 'codex', 'grok', 'cursor') },
  ENFORCER_HEADLESS: { default: '(unset)', check: flag },
  ENFORCER_GOVERNOR: { default: '(unset)', check: nonEmpty },
  ENFORCER_SCOPE: { default: '(unset)', check: nonEmpty },
  ENFORCER_TENANT_CODE: { default: '(unset)', check: nonEmpty },
  ENFORCER_RESOURCES: { default: '(unset)', check: nonEmpty },
  ENFORCER_GRAPH_RUN_ID: { default: '(set by the dispatcher)', check: nonEmpty },
  GRAPH_BASE_URL: { default: '<base>/api/v1/graph', check: url },
  GRAPH_ID: { default: '(from .enforcer/graph.json)', check: nonEmpty },
  GRAPH_API_KEY: { default: '(none)', check: nonEmpty },
  GRAPH_AUTH_HELPER: { default: '(signed-in credential)', check: nonEmpty },
  GRAPH_HOOK_TIMEOUT: { default: '1.5', check: num(0.05, 600), blankIsError: true },
  GRAPH_EVIDENCE_MODE: { default: '(unset)', check: nonEmpty },
  GRAPH_INVITE_URL_BASE: { default: '(unset)', check: url },
  GRAPH_JEV_PRICE_PER_MTOK_USD: { default: '(unset)', check: num(0, 1e6) },
  GOVERNOR_HOME: { default: '~/.enforcer-governor', check: nonEmpty },
  CLAUDE_PLUGIN_DATA: { default: '(set by Claude Code)', check: nonEmpty },
};

/** Named ConfigErrors for every variable in env that is set and malformed. Empty array when all is well. */
export function validateEnv(env = process.env) {
  const errors = [];
  for (const [name, spec] of Object.entries(VARS)) {
    const v = env[name];
    if (v === undefined || (v === '' && !spec.blankIsError)) continue; // blank means unset, except where blank would silently change behavior
    try {
      spec.check(String(v), name);
    } catch (e) {
      if (e instanceof ConfigError) errors.push(e);
      else throw e;
    }
  }
  return errors;
}

/** Name of the base URL variable, for messages and source labels. */
export const BASE_URL_VAR = 'ENFORCER_BASE_URL';
/** The base URL set in the environment, or '' when unset. The only direct read of that variable. */
export const envBaseUrl = (env = process.env) => env[BASE_URL_VAR] || '';

const trim = (s) => String(s).replace(/\/+$/, '');

/** The URLs one base implies. */
export function deriveUrls(base, env = {}) {
  const b = trim(base);
  return {
    mcpUrl: `${b}/mcp`,
    graphUrl: env.GRAPH_BASE_URL ? trim(env.GRAPH_BASE_URL) : `${b}/api/v1/graph`,
    filesUrl: `${b}/api/v1/files`,
    governanceUrl: `${b}/api/v1/governance`,
    enforcerUrl: `${b}/api/v1/enforcer`,
  };
}

/**
 * Resolve the config. Throws ConfigError when a variable is malformed.
 * `saved` defaults to the stored credential document.
 */
export function resolveConfig({ flag: flagBase, env = process.env, saved } = /** @type {any} */ ({})) {
  const errors = validateEnv(env);
  if (errors.length) throw errors[0];
  if (flagBase) url(flagBase, '--base-url');
  const doc = saved === undefined ? readCredentials() : saved;
  const savedBase = doc?.enforcer?.base_url;
  let base, source;
  if (flagBase) {
    base = flagBase;
    source = 'flag';
  } else if (envBaseUrl(env)) {
    base = envBaseUrl(env);
    source = 'ENFORCER_BASE_URL';
  } else if (savedBase) {
    base = savedBase;
    source = 'saved credentials';
  } else {
    base = DEFAULT_BASE_URL;
    source = 'default';
  }
  base = trim(base);
  const home = env.HOME || env.USERPROFILE || homedir();
  const configHome = env.ENFORCER_CONFIG_HOME || join(home, '.config', 'enforcer');
  const harness = env.ENFORCER_HARNESS || 'claude';
  return {
    baseUrl: base,
    source,
    ...deriveUrls(base, env),
    harness,
    configHome,
    stateDir: env.ENFORCER_STATE_DIR || env.CLAUDE_PLUGIN_DATA || join(configHome, 'sessions', harness),
  };
}

/** `--base-url X` or `--base-url=X` from an argv, else undefined. */
export function flagValue(argv, name = '--base-url') {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return undefined;
}
