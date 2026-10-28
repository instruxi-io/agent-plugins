// Point Codex's own OpenTelemetry exporter at Enforcer governance. On by default.
//
// Codex (codex-rs) exports logs/events, metrics and traces when its config.toml
// says where. This writes the [otel] keys that say so, into
// $CODEX_HOME/config.toml (~/.codex/config.toml):
//
//   [otel]
//   log_user_prompt = false
//   log_agent_responses = false
//   log_guardian_assessments = false
//   tool_result = { max_bytes = 0 }
//   exporter = { otlp-http = { endpoint = "<origin>/api/v1/governance/otlp/v1/logs", protocol = "binary", headers = { "X-API-Key" = "<ingest key>" } } }
//   metrics_exporter = { otlp-http = { endpoint = "<origin>/api/v1/governance/otlp/v1/metrics", ... } }
//   trace_exporter = "none"
//
// The schema is codex-rs/config/src/types.rs OtelConfigToml, checked against
// Codex 0.164.0 (rust-v0.164.0), and a local OTLP sink received both signals
// with the header from that version:
//   - The endpoint is the FULL signal path: Codex never appends /v1/logs.
//   - metrics_exporter defaults to `statsig`, which sends metrics to OpenAI.
//     Ours replaces it, so metrics go to governance instead.
//   - Governance has no traces endpoint, so trace_exporter is "none".
//   - protocol "binary" is OTLP http/protobuf.
//   - Headers are written literally: Codex does not expand ${VAR} in them.
//
// THE CREDENTIAL. Codex sends a fixed header, so it gets a fixed credential: a
// per-machine, per-harness ingest key that can only write telemetry
// (src/ingest-key.mjs, ensureIngestKey). The file holds it, so the file is kept
// 0600. Each Codex session start re-asks for the key, and a rotated key is
// written over the old one; Codex reads its config at start, so the new key is
// in use from the next session.
//
// NO PROMPT TEXT. log_user_prompt, log_agent_responses and
// log_guardian_assessments are forced false (a true one left by hand would send
// prompt or response text), and tool_result.max_bytes 0 keeps tool OUTPUT out of
// the codex.tool_result event. Codex 0.164 has no setting for that event's
// `arguments` attribute: the tool's arguments (shell commands, file paths) are
// exported whenever log export is on.
//
// THE REST OF THE FILE IS THE USER'S. The edit is line-based and touches only
// the keys above (and any [otel.exporter...]-style sub-tables that would clash
// with them); every other key, table and comment is kept byte for byte. A file
// this cannot edit safely (an inline `otel = {...}` or dotted `otel.x` keys at
// the top level) is refused, never rewritten.
//
// OFF. `enforcer governor telemetry codex off` removes exactly these keys and
// records codexTelemetry=false in the governor config, so session starts stop
// re-enabling it. `... codex on` turns it back on.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { baseUrl } from '../../core/credentials.mjs';
import { isOff } from '../../core/bool.mjs';
import { DIR, privateDir } from '../../core/store.mjs';
import { OTLP_PATH } from '../claude-code/telemetry.mjs';

export const HARNESS = 'codex';
export const LOGS_PATH = `${OTLP_PATH}/v1/logs`;
export const METRICS_PATH = `${OTLP_PATH}/v1/metrics`;
export const KEY_HEADER = 'X-API-Key';
export const BEGIN = '# BEGIN Enforcer telemetry (managed; `enforcer governor telemetry codex off` removes it)';
export const END = '# END Enforcer telemetry';

/** The [otel] keys this writes, and so the only ones it removes. */
export const OWNED = ['log_user_prompt', 'log_agent_responses', 'log_guardian_assessments', 'tool_result', 'exporter', 'metrics_exporter', 'trace_exporter'];

const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
export const codexHome = (env = process.env) => env.CODEX_HOME || join(home(), '.codex');
export const CODEX_CONFIG = (env = process.env) => join(codexHome(env), 'config.toml');

// ensureIngestKey lives in src/ingest-key.mjs (key provisioning). Loaded lazily, by URL, so a hook that never
// needs a key never loads it; tests pass their own.
const INGEST_KEY_MODULE = new URL('../../../../src/ingest-key.mjs', import.meta.url).href;
/** @returns {Promise<(o: { harness: string }) => Promise<{ key: string }>>} */
export const loadEnsureIngestKey = async () => (await import(INGEST_KEY_MODULE)).ensureIngestKey;

/** @typedef {{ kind: 'header'|'key'|'trivia', path: string[], start: number, end: number }} Stmt */

// ── a line-based TOML reader: just enough to find tables and key statements ──

/**
 * Split TOML text into statements: table headers, key/value statements (which may span lines) and
 * trivia (blank and comment lines). Tracks strings (basic, literal, multi-line) and bracket depth,
 * so a `[` inside a value or a string is never taken for a header.
 * @returns {Stmt[]} end is exclusive
 */
export function statements(text) {
  const lines = text.split('\n');
  /** @type {Stmt[]} */
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) {
      out.push({ kind: 'trivia', path: [], start: i, end: i + 1 });
      i++;
      continue;
    }
    if (t.startsWith('[')) {
      const m = /^\[\[?(.*?)\]\]?\s*(#.*)?$/.exec(t);
      if (!m) throw new Error(`line ${i + 1}: cannot read the table header`);
      out.push({ kind: 'header', path: keyPath(m[1]), start: i, end: i + 1 });
      i++;
      continue;
    }
    const eq = keyEnd(line);
    if (eq < 0) throw new Error(`line ${i + 1}: cannot read the key`);
    const path = keyPath(line.slice(0, eq));
    // scan the value until strings and brackets close
    const st = { str: '', depth: 0 };
    let j = i;
    scan(line.slice(eq + 1), st);
    while ((st.str || st.depth > 0) && j + 1 < lines.length) scan(lines[++j], st);
    if (st.str || st.depth > 0) throw new Error(`line ${i + 1}: a value never closes`);
    out.push({ kind: 'key', path, start: i, end: j + 1 });
    i = j + 1;
  }
  return out;
}

// Where the `=` after a key is (quotes respected), or -1.
function keyEnd(line) {
  let q = '';
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) {
      if (c === '\\' && q === '"') k++;
      else if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '=') return k;
  }
  return -1;
}

/** `a."b.c" . d` -> ['a', 'b.c', 'd'] */
export function keyPath(raw) {
  const parts = [];
  let cur = '';
  let q = '';
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (q) {
      if (c === '\\' && q === '"') cur += raw[++k];
      else if (c === q) q = '';
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '.') {
      parts.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

// Advance string / bracket state over one line of a value.
function scan(s, st) {
  for (let k = 0; k < s.length; k++) {
    if (st.str) {
      if (st.str === '"""' || st.str === "'''") {
        if (st.str === '"""' && s[k] === '\\') {
          k++;
          continue;
        }
        if (s.startsWith(st.str, k)) {
          st.str = '';
          k += 2;
        }
      } else if (st.str === '"' && s[k] === '\\') k++;
      else if (s[k] === st.str) st.str = '';
      continue;
    }
    const c = s[k];
    if (c === '#') return;
    if (s.startsWith('"""', k) || s.startsWith("'''", k)) {
      st.str = s.slice(k, k + 3);
      k += 2;
    } else if (c === '"' || c === "'") st.str = c;
    else if (c === '[' || c === '{') st.depth++;
    else if (c === ']' || c === '}') st.depth--;
  }
  // a single-line string cannot cross a line end
  if (st.str === '"' || st.str === "'") throw new Error('a string never closes');
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (path, prefix) => prefix.length <= path.length && prefix.every((x, i) => path[i] === x);

/** Is this table header ours to remove? [otel.exporter], [otel.exporter.otlp-http], ... clash with the inline keys. */
const ownedTable = (path) => path[0] === 'otel' && path.length > 1 && OWNED.includes(path[1]);

/**
 * Remove everything this module owns from config.toml text: the managed block, owned [otel] keys and
 * clashing sub-tables; an [otel] table left with nothing in it goes too. Returns the text unchanged when
 * there is nothing of ours. Throws on a file it cannot edit safely.
 * @param {string} text
 */
export function removeOtel(text) {
  const st = statements(text);
  const lines = text.split('\n');
  const drop = new Set();
  let table = /** @type {string[]} */ ([]);
  let tableStmt = -1;
  let otelHeader = -1;
  st.forEach((s, idx) => {
    if (s.kind === 'header') {
      table = s.path;
      tableStmt = idx;
      if (same(s.path, ['otel'])) otelHeader = idx;
      if (ownedTable(s.path)) {
        // the whole sub-table, down to the next header
        let e = idx + 1;
        while (e < st.length && st[e].kind !== 'header') e++;
        for (let n = s.start; n < (e < st.length ? st[e].start : lines.length); n++) drop.add(n);
      }
      return;
    }
    if (s.kind === 'trivia') {
      const t = lines[s.start].trim();
      if (t === BEGIN || t === END) drop.add(s.start);
      return;
    }
    const full = [...table, ...s.path];
    if (tableStmt < 0 && full[0] === 'otel')
      throw new Error('config.toml sets otel at the top level (otel = {...} or otel.x = ...); edit it into an [otel] table first');
    if (same(table, ['otel']) && OWNED.includes(full[1])) {
      for (let n = s.start; n < s.end; n++) drop.add(n);
    }
  });
  if (!drop.size) return text;
  // an [otel] header whose table is now empty (blank lines aside) goes as well
  if (otelHeader >= 0) {
    const h = st[otelHeader];
    let e = otelHeader + 1;
    while (e < st.length && st[e].kind !== 'header') e++;
    const bodyEnd = e < st.length ? st[e].start : lines.length;
    let empty = true;
    for (let n = h.end; n < bodyEnd; n++) if (!drop.has(n) && lines[n].trim() !== '') empty = false;
    if (empty) for (let n = h.start; n < bodyEnd; n++) drop.add(n);
  }
  const kept = lines.filter((_, n) => !drop.has(n));
  return tidy(kept.join('\n'));
}

// No runs of blank lines left behind by a removal, and one trailing newline.
const tidy = (s) =>
  s
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n')
    .replace(/^\n+/, '');

const tomlString = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string

/** The managed lines for an endpoint origin and key. */
export function managedLines(origin, key) {
  const o = String(origin).replace(/\/+$/, '');
  const exp = (path) =>
    `{ otlp-http = { endpoint = ${tomlString(o + path)}, protocol = "binary", headers = { ${tomlString(KEY_HEADER)} = ${tomlString(key)} } } }`;
  return [
    BEGIN,
    'log_user_prompt = false',
    'log_agent_responses = false',
    'log_guardian_assessments = false',
    'tool_result = { max_bytes = 0 }',
    `exporter = ${exp(LOGS_PATH)}`,
    `metrics_exporter = ${exp(METRICS_PATH)}`,
    'trace_exporter = "none"',
    END,
  ];
}

/**
 * config.toml text with our [otel] keys set: everything of ours removed first, then the managed block put
 * at the top of the existing [otel] table, or a new [otel] table appended.
 * @param {string} text
 * @param {{ origin: string, key: string }} o
 */
export function applyOtel(text, { origin, key }) {
  if (!key) throw new Error('no ingest key');
  const base = removeOtel(text || '');
  const block = managedLines(origin, key);
  const st = statements(base);
  const header = st.find((s) => s.kind === 'header' && same(s.path, ['otel']));
  const lines = base.split('\n');
  if (header) {
    lines.splice(header.end, 0, ...block);
    return tidy(lines.join('\n'));
  }
  const body = base.trim() ? base.replace(/\n*$/, '\n\n') : '';
  return `${body}[otel]\n${block.join('\n')}\n`;
}

/**
 * What config.toml says about our export, read without trusting it.
 * @param {string} text
 */
export function readOtel(text) {
  const r = {
    managed: false,
    logs: /** @type {string|null} */ (null),
    metrics: /** @type {string|null} */ (null),
    metricsKind: 'statsig',
    key: false,
    sensitive: /** @type {string[]} */ ([]),
  };
  let st;
  try {
    st = statements(text || '');
  } catch {
    return { ...r, error: 'config.toml could not be read' };
  }
  const lines = (text || '').split('\n');
  let table = /** @type {string[]} */ ([]);
  for (const s of st) {
    if (s.kind === 'header') {
      table = s.path;
      if (startsWith(s.path, ['otel', 'metrics_exporter'])) r.metricsKind = s.path[2] || 'table';
      continue;
    }
    if (s.kind === 'trivia') {
      if (lines[s.start].trim() === BEGIN) r.managed = true;
      continue;
    }
    if (!same(table, ['otel'])) continue;
    const src = lines.slice(s.start, s.end).join('\n');
    const val = src.slice(src.indexOf('=') + 1).trim();
    const name = s.path[0];
    const endpoint = /endpoint\s*=\s*"([^"]*)"/.exec(val)?.[1] || null;
    if (name === 'exporter') {
      r.logs = endpoint;
      r.key = new RegExp(`"${KEY_HEADER}"\\s*=\\s*"[^"]+"`).test(val);
    } else if (name === 'metrics_exporter') {
      r.metrics = endpoint;
      r.metricsKind = /otlp-http/.test(val) ? 'otlp-http' : /otlp-grpc/.test(val) ? 'otlp-grpc' : val.replace(/"/g, '');
    } else if (['log_user_prompt', 'log_agent_responses', 'log_guardian_assessments'].includes(name) && /^true\b/.test(val)) r.sensitive.push(name);
  }
  return r;
}

// ── the file ──

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return null;
    throw e;
  }
}

/** Write config.toml atomically, 0600 (it holds the key). The first write keeps the user's original as .enforcer-backup. */
function writeConfig(p, text) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const bak = p + '.enforcer-backup';
  if (existsSync(p) && !existsSync(bak)) {
    copyFileSync(p, bak);
    chmodSync(bak, 0o600);
  }
  const tmp = p + `.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

const origin = (cfg) => String(cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '');

/** p, or a rejection after ms; the timer is cleared either way so it never holds a hook open. */
async function withTimeout(p, ms) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`no ingest key within ${ms / 1000}s`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Turn Codex telemetry on (or refresh its key). Writes only when the text changes.
 * @param {any} cfg governor config (ingestUrl / centralUrl)
 * @param {{ ensureIngestKey?: Function, env?: Record<string, string|undefined>, timeoutMs?: number }} [deps]
 */
export async function enable(cfg = {}, { ensureIngestKey, env = process.env, timeoutMs = 8000 } = {}) {
  const ensure = ensureIngestKey || (await loadEnsureIngestKey());
  const { key } = await withTimeout(Promise.resolve(ensure({ harness: HARNESS })), timeoutMs);
  const p = CODEX_CONFIG(env);
  const before = readText(p);
  const next = applyOtel(before || '', { origin: origin(cfg), key });
  const changed = next !== before;
  if (changed) writeConfig(p, next);
  else chmodSync(p, 0o600);
  return { config: p, logs: origin(cfg) + LOGS_PATH, metrics: origin(cfg) + METRICS_PATH, changed };
}

/** Turn it off: remove exactly what enable() wrote. */
export function disable({ env = process.env } = {}) {
  const p = CODEX_CONFIG(env);
  const before = readText(p);
  if (before === null) return { config: p, changed: false };
  const next = removeOtel(before);
  if (next !== before) writeConfig(p, next);
  return { config: p, changed: next !== before };
}

/**
 * @param {any} [cfg]
 * @returns {ReturnType<typeof readOtel> & { on: boolean, config: string, exists?: boolean, optedOut: boolean, error?: string }}
 */
export function status(cfg = {}, { env = process.env } = {}) {
  const p = CODEX_CONFIG(env);
  let text = null;
  try {
    text = readText(p);
  } catch (e) {
    return { ...readOtel(''), on: false, config: p, error: /** @type {any} */ (e).message, optedOut: isOff(cfg.codexTelemetry) };
  }
  const r = readOtel(text || '');
  const ours = !!r.logs?.endsWith(LOGS_PATH) && !!r.metrics?.endsWith(METRICS_PATH);
  return { ...r, on: ours && r.key, config: p, exists: text !== null, optedOut: isOff(cfg.codexTelemetry) };
}

/** Is the Enforcer plugin enabled in this Codex? (`[plugins."enforcer@..."] enabled = true`) */
export function pluginInstalled({ env = process.env } = {}) {
  let text;
  try {
    text = readText(CODEX_CONFIG(env));
  } catch {
    return false;
  }
  if (!text) return false;
  let table = /** @type {string[]} */ ([]);
  const lines = text.split('\n');
  try {
    for (const s of statements(text)) {
      if (s.kind === 'header') table = s.path;
      else if (s.kind === 'key' && table[0] === 'plugins' && /^enforcer@/.test(table[1] || '') && s.path[0] === 'enabled')
        if (/=\s*true\b/.test(lines[s.start])) return true;
    }
  } catch {}
  return false;
}

// The last on-by-default attempt, for status: setup fails open (signed out, agent disabled, Enforcer
// unreachable) and keeps whatever key the file already holds, so status is where a failure shows.
export const LAST_FILE = () => join(DIR, 'codex-telemetry.json');
function recordLast(r) {
  try {
    privateDir(DIR);
    writeFileSync(
      LAST_FILE(),
      JSON.stringify({ at: new Date().toISOString(), ...(r.skipped ? { skipped: r.skipped } : { ok: true, changed: !!r.changed }) }) + '\n',
      { mode: 0o600 },
    );
  } catch {}
}
/** @returns {{ at: string, ok?: boolean, changed?: boolean, skipped?: string } | null} */
export function lastAttempt() {
  try {
    return JSON.parse(readFileSync(LAST_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The on-by-default path, for a Codex session start and for sign-in: enable unless the user turned it off,
 * never throws. `skipped` says why nothing was written; the file keeps its last key.
 * @param {any} cfg
 * @param {{ ensureIngestKey?: Function, env?: Record<string, string|undefined>, signedIn?: () => boolean, timeoutMs?: number }} [deps]
 * @returns {Promise<{ skipped?: string, changed?: boolean, config?: string, logs?: string, metrics?: string }>}
 */
export async function ensure(cfg = {}, deps = {}) {
  if (isOff(cfg.codexTelemetry)) return { skipped: 'turned off (codexTelemetry)' };
  /** @type {{ skipped?: string, changed?: boolean, config?: string, logs?: string, metrics?: string }} */
  let r;
  if (deps.signedIn && !deps.signedIn()) r = { skipped: 'not signed in' };
  else {
    try {
      r = await enable(cfg, deps);
    } catch (e) {
      r = { skipped: /** @type {any} */ (e)?.message || String(e) };
    }
  }
  recordLast(r);
  return r;
}
