// Gemini CLI telemetry to Enforcer governance: `enforcer gemini telemetry [on|off|status]`, and the
// extension's SessionStart hook (`enforcer gemini session-start`), which keeps it on.
//
// WHAT GEMINI CAN AND CANNOT BE TOLD (checked against @google/gemini-cli 0.38.0, bundle source and a live
// run against a local OTLP sink):
//   - settings.json `telemetry` takes the endpoint and protocol, never a header. With otlpProtocol "http"
//     it posts OTLP/JSON to <otlpEndpoint>/v1/logs, /v1/metrics and /v1/traces.
//   - The only way to authenticate is OTEL_EXPORTER_OTLP_HEADERS in Gemini's own process environment.
//   - `logPrompts: false` drops the prompt from gemini_cli.user_prompt but NOT from gemini_cli.api_request
//     (request_text: the whole conversation), api_response (response_text), the gen_ai.* operation
//     details (system instructions, output messages) or tool_call (function_args).
//   - Its OTel SDK's process detector puts argv on the resource, and `gemini -p "<prompt>"` has the prompt
//     in argv.
//
// SO EVERYTHING RIDES IN ONE BLOCK OF <gemini home>/.gemini/.env (mode 0600), which Gemini loads into its
// own process environment before it starts telemetry: the switch (GEMINI_TELEMETRY_ENABLED), the
// X-API-Key header from a telemetry-only ingest key, and the limits that keep content out:
//   OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT=48   every log attribute string is cut to 48 characters.
//       48 keeps every name and id intact (the longest event name is 41, an interactive prompt_id
//       36 + 8 + its counter) and leaves only the fixed JSON scaffolding of request_text, response_text
//       and the gen_ai.* messages; a tool's function_args keeps its first ~30 characters.
//   OTEL_NODE_RESOURCE_DETECTORS=env,host,os         no process detector, so no argv on the resource.
//   OTEL_TRACES_SAMPLER=always_off                   no spans: governance takes logs and metrics only.
// settings.json gets the endpoint, protocol and logPrompts:false but NOT `enabled`. Gemini reads only the
// FIRST .env it finds walking up from the working directory, and a project's own .env shadows ours; in
// that directory the switch is off too, so nothing is exported without the header and the limits.
// `status` names the file that shadows it.
//
// No shell profile and no wrapper on PATH: this file is read by Gemini alone, so the header reaches no
// other OTel exporter (Codex and Claude Code read the same variable).
//
// On by default: `enforcer login` turns it on when Gemini CLI is installed here, and the extension's
// SessionStart hook turns it on (for the next session: Gemini starts telemetry before hooks run) and
// rewrites the key when ensureIngestKey rotates it. `enforcer gemini telemetry off` removes exactly what
// this wrote and records the choice, so neither turns it back on; `on` clears the choice.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SHARED_DIR } from './credentials.mjs';
import { resolveConfig } from './config.mjs';

export const HARNESS = 'gemini-cli';
export const BEGIN = '# >>> enforcer: Gemini CLI telemetry to Enforcer governance. Managed; `enforcer gemini telemetry off` removes it. >>>';
export const END = '# <<< enforcer <<<';
export const ATTRIBUTE_LIMIT = '48';
const OTLP_SUFFIX = '/api/v1/governance/otlp';

/** Gemini's home: GEMINI_CLI_HOME, else the user's home (Gemini's own homedir()). */
export const geminiHome = ({ env = process.env, home = env.HOME || env.USERPROFILE || homedir() } = {}) => env.GEMINI_CLI_HOME || home;
export const geminiDir = (o = {}) => join(geminiHome(o), '.gemini');
export const settingsPath = (o = {}) => join(geminiDir(o), 'settings.json');
export const envPath = (o = {}) => join(geminiDir(o), '.env');
/** Gemini CLI has run here (it creates ~/.gemini on first start). */
export const geminiPresent = (o = {}) => existsSync(geminiDir(o));
const optOutPath = (shared = SHARED_DIR()) => join(shared, 'gemini-telemetry.json');
export const optedOut = (shared = SHARED_DIR()) => {
  try {
    return JSON.parse(readFileSync(optOutPath(shared), 'utf8')).off === true;
  } catch {
    return false;
  }
};

// The key and endpoint go into a dotenv line and an OTel header list: refuse anything that could break
// out of either (quotes, newlines, `,` and `=` inside the header value).
const SAFE_KEY = /^[A-Za-z0-9._~-]+$/;

/** The managed .env block. */
export function renderBlock({ key, endpoint }) {
  if (!SAFE_KEY.test(String(key || ''))) throw new Error('the ingest key has characters an OTLP header cannot carry');
  if (!/^https?:\/\/[^\s"'\\]+$/.test(endpoint)) throw new Error(`not an http(s) endpoint: ${endpoint}`);
  return [
    BEGIN,
    'GEMINI_TELEMETRY_ENABLED=true',
    'GEMINI_TELEMETRY_TARGET=local',
    `GEMINI_TELEMETRY_OTLP_ENDPOINT="${endpoint}"`,
    'GEMINI_TELEMETRY_OTLP_PROTOCOL=http',
    'GEMINI_TELEMETRY_LOG_PROMPTS=false',
    `OTEL_EXPORTER_OTLP_HEADERS="X-API-Key=${key}"`,
    `OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT=${ATTRIBUTE_LIMIT}`,
    'OTEL_NODE_RESOURCE_DETECTORS=env,host,os',
    'OTEL_TRACES_SAMPLER=always_off',
    END,
  ].join('\n');
}

/** The text without our block (every copy of it, should a hand edit have duplicated it). */
export function stripBlock(text) {
  const lines = text.split('\n');
  const kept = [];
  let inside = false;
  for (const l of lines) {
    if (l === BEGIN) inside = true;
    else if (inside && l === END) inside = false;
    else if (!inside) kept.push(l);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}); // malformed throws: never overwrite what we cannot read

// Atomic write. `mode` null keeps the file's own mode (0600 when new); a number forces it.
function writeFile(p, text, mode = null) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const m = mode ?? (existsSync(p) ? statSync(p).mode & 0o777 : 0o600);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: m });
  chmodSync(tmp, m); // the umask narrowed the create mode; set it exactly
  renameSync(tmp, p);
}

const OURS = { target: 'local', otlpProtocol: 'http', logPrompts: false };
// Keys that would turn exporting on without our .env block, or send it elsewhere.
const CONFLICTING = ['enabled', 'outfile', 'useCollector', 'useCliAuth'];

/** settings.json `telemetry` with ours applied; `removed` lists their keys it dropped. */
export function applySettings(s, endpoint) {
  const t = { ...(s.telemetry || {}) };
  const removed = CONFLICTING.filter((k) => Object.hasOwn(t, k));
  for (const k of removed) delete t[k];
  return { settings: { ...s, telemetry: { ...t, ...OURS, otlpEndpoint: endpoint } }, removed };
}

async function loadIngest() {
  // ingest-key.mjs (workstream K) provisions the telemetry-only key. Resolved at run time, so this
  // module loads, and says so plainly, on a build without it.
  try {
    return await import(new URL('./ingest-key.mjs', import.meta.url).href);
  } catch (e) {
    throw new Error(`ingest keys are not available in this build (${e.code || e.message})`);
  }
}

/**
 * Turn it on. `explicit` (the `on` command) clears an earlier `off`; otherwise (login, the hook) an
 * earlier `off` wins and nothing is written. `ingest` is the ingest-key module (tests pass a fake).
 */
export async function enable({ env = process.env, home = undefined, shared = SHARED_DIR(), explicit = false, ingest = null, baseUrl = null } = {}) {
  const o = { env, ...(home ? { home } : {}) };
  if (!explicit && optedOut(shared)) return { skipped: 'off', settings: settingsPath(o), env: envPath(o) };
  if (explicit) rmSync(optOutPath(shared), { force: true });
  const { ensureIngestKey, OTLP_BASE } = ingest || (await loadIngest());
  const base = baseUrl || resolveConfig({ env }).baseUrl;
  const endpoint = OTLP_BASE ? OTLP_BASE(base) : base.replace(/\/+$/, '') + OTLP_SUFFIX;
  const { key } = await ensureIngestKey({ harness: HARNESS });
  const block = renderBlock({ key, endpoint }); // validates before anything is written

  const sp = settingsPath(o);
  const before = readJson(sp);
  const { settings, removed } = applySettings(before, endpoint);
  const settingsChanged = JSON.stringify(before) !== JSON.stringify(settings);
  if (settingsChanged) {
    if (existsSync(sp)) {
      copyFileSync(sp, sp + '.enforcer-backup');
      chmodSync(sp + '.enforcer-backup', statSync(sp).mode & 0o777);
    }
    writeFile(sp, JSON.stringify(settings, null, 2) + '\n');
  }

  const ep = envPath(o);
  const old = readText(ep);
  const rest = stripBlock(old).replace(/\s+$/, '');
  const next = (rest ? rest + '\n\n' : '') + block + '\n';
  // Windows has no POSIX modes (stat reports 0o666): checking there would rewrite on every start.
  const envChanged = next !== old || (process.platform !== 'win32' && existsSync(ep) && (statSync(ep).mode & 0o777) !== 0o600);
  if (envChanged) writeFile(ep, next, 0o600); // it holds a secret: 0600 even if it was wider
  return { endpoint, settings: sp, env: ep, removed, changed: settingsChanged || envChanged };
}

/** Turn it off: remove exactly what enable() wrote. `record` remembers the choice for login and the hook. */
export function disable({ env = process.env, home = undefined, shared = SHARED_DIR(), record = true } = {}) {
  const o = { env, ...(home ? { home } : {}) };
  const ep = envPath(o);
  const old = readText(ep);
  let changed = false;
  if (old.includes(BEGIN)) {
    changed = true;
    const rest = stripBlock(old).replace(/\s+$/, '');
    if (rest) writeFile(ep, rest + '\n');
    else rmSync(ep, { force: true });
  }
  const sp = settingsPath(o);
  const s = readJson(sp);
  const t = s.telemetry;
  if (t && typeof t.otlpEndpoint === 'string' && t.otlpEndpoint.endsWith(OTLP_SUFFIX)) {
    for (const k of ['otlpEndpoint', ...Object.keys(OURS)]) if (k === 'otlpEndpoint' || t[k] === OURS[k]) delete t[k];
    if (!Object.keys(t).length) delete s.telemetry;
    writeFile(sp, JSON.stringify(s, null, 2) + '\n');
    changed = true;
  }
  if (record) {
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    writeFileSync(optOutPath(shared), JSON.stringify({ off: true, at: new Date().toISOString() }) + '\n');
  }
  return { settings: sp, env: ep, changed };
}

/** Gemini's own .env lookup (loadEnvironment in @google/gemini-cli 0.38.0): the first one found wins. */
export function findEnvFile(cwd, o = {}) {
  let dir = resolve(cwd);
  for (;;) {
    for (const p of [join(dir, '.gemini', '.env'), join(dir, '.env')]) if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const p of [envPath(o), join(geminiHome(o), '.env')]) if (existsSync(p)) return p;
  return null;
}

// Variables in the shell environment beat the .env file (Gemini never overwrites one that is set).
const OVERRIDES = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'GEMINI_TELEMETRY_ENABLED',
  'GEMINI_TELEMETRY_OTLP_ENDPOINT',
  'GEMINI_TELEMETRY_LOG_PROMPTS',
  'GEMINI_TELEMETRY_OUTFILE',
];

// Our block's text, for reading back what it says.
const blockOf = (text) => {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END, i);
  return i < 0 ? '' : text.slice(i, j < 0 ? undefined : j);
};

export function status({ env = process.env, home = undefined, shared = SHARED_DIR(), cwd = process.cwd() } = {}) {
  const o = { env, ...(home ? { home } : {}) };
  const text = readText(envPath(o));
  const on = text.includes(BEGIN);
  const endpoint = (/^GEMINI_TELEMETRY_OTLP_ENDPOINT="?([^"\n]*)"?$/m.exec(blockOf(text)) || [])[1] || null;
  let settingsError = null;
  let settingsOn = false;
  try {
    settingsOn = readJson(settingsPath(o)).telemetry?.enabled === true;
  } catch {
    settingsError = 'settings.json is not valid JSON';
  }
  const found = findEnvFile(cwd, o);
  return {
    on,
    endpoint,
    optedOut: optedOut(shared),
    envFile: envPath(o),
    // In this directory Gemini reads another .env, so our block (and the export) is off here.
    shadowedBy: on && found && found !== envPath(o) ? found : null,
    overridden: OVERRIDES.filter((k) => Object.hasOwn(env, k)),
    settingsOn,
    settingsError,
  };
}

/** One line for `enforcer status`, or null when Gemini CLI is not here. */
export function statusLine(o = {}) {
  if (!geminiPresent(o)) return null;
  const t = status(o);
  if (t.on) return `Gemini CLI telemetry: on, to ${t.endpoint}${t.shadowedBy ? ` (off in this directory: Gemini reads ${t.shadowedBy} instead)` : ''}.`;
  return t.optedOut
    ? 'Gemini CLI telemetry: off (you turned it off; `enforcer gemini telemetry on` to resume).'
    : 'Gemini CLI telemetry: off. `enforcer gemini telemetry on` to turn it on.';
}

/** `enforcer login` calls this after a sign-in. Never throws; returns lines to print. */
export async function onLogin(o = {}) {
  if (!geminiPresent(o)) return [];
  try {
    const r = await enable(o);
    if (r.skipped) return [];
    return [`Gemini CLI telemetry: on, to ${r.endpoint} (from its next session). \`enforcer gemini telemetry off\` turns it off.`];
  } catch (e) {
    return [`Gemini CLI telemetry not set up: ${e.message}`];
  }
}

const out = (s) => process.stdout.write(s + '\n');

export async function main([cmd, sub] = []) {
  if (cmd === 'session-start') {
    // Gemini's SessionStart hook: refresh (or first write) for the next session. Silent, never blocks:
    // stdout must be JSON only, and a failure must not disturb the session.
    try {
      readFileSync(0, 'utf8');
    } catch {}
    try {
      if (geminiPresent()) await enable();
    } catch {}
    out('{}');
    return 0;
  }
  if (cmd !== 'telemetry' || (sub && !['on', 'off', 'status'].includes(sub))) {
    process.stderr.write('usage: enforcer gemini telemetry [on|off|status]\n');
    return 2;
  }
  try {
    if (sub === 'on') {
      const r = await enable({ explicit: true });
      out(`Gemini CLI telemetry on: logs and metrics to ${r.endpoint}, from Gemini's next session.`);
      out(`Authenticated with a telemetry-only ingest key in ${r.env} (mode 0600); ${r.settings} names the endpoint.`);
      out('Prompt and response text are not exported: see `enforcer gemini telemetry status` for the limits.');
      if (r.removed.length)
        out(
          `Removed telemetry.${r.removed.join(', telemetry.')} from ${r.settings}: ${r.removed.length > 1 ? 'they' : 'it'} would export without the key or elsewhere.`,
        );
    } else if (sub === 'off') {
      const r = disable();
      out(`Gemini CLI telemetry off. Removed the enforcer block from ${r.env} and its keys from ${r.settings}; sign-in will not turn it back on.`);
    } else {
      const t = status();
      if (t.settingsError) out(`Warning: ${t.settingsError}.`);
      out(
        t.on
          ? `Gemini CLI telemetry: on, logs and metrics to ${t.endpoint}.`
          : `Gemini CLI telemetry: off${t.optedOut ? ' (turned off; sign-in leaves it off)' : ''}.`,
      );
      if (t.on) {
        out(`Key and switch: ${t.envFile}. Prompts not exported; log attributes cut to ${ATTRIBUTE_LIMIT} characters; no traces; no argv.`);
        if (t.shadowedBy) out(`In this directory Gemini loads ${t.shadowedBy} instead of ${t.envFile}, so nothing is exported from here.`);
      }
      if (t.overridden.length) out(`Set in your shell, so they win over ${t.envFile}: ${t.overridden.join(', ')}.`);
      if (t.settingsOn)
        out('Warning: telemetry.enabled is true in Gemini settings, so a directory that shadows the key still exports, unauthenticated and unlimited.');
    }
    return 0;
  } catch (e) {
    out(`Not changed: ${e.message}`);
    return 1;
  }
}
