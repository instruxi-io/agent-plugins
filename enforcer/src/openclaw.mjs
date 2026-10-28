// OpenClaw: point its official diagnostics-otel exporter at Enforcer governance, with a telemetry-only key.
//
// OpenClaw exports OTel only through the `diagnostics-otel` plugin (docs.openclaw.ai/gateway/opentelemetry;
// built against openclaw 2026.10.8 and @openclaw/diagnostics-otel 2026.10.8). Its settings live in
// openclaw.json under `diagnostics.otel`, and the one way to authenticate is a fixed header map there
// (`diagnostics.otel.headers`): there is no headers helper. So the header carries the per-machine ingest key
// from ingest-key.mjs, never the person's own credential, and the file is OpenClaw's own config, which it
// writes 0600 in a 0700 directory (checked here after every write all the same).
//
// What is written, and only into a block that is absent or already ours (a diagnostics.otel pointing
// anywhere else is somebody's collector and is left alone, reported as `foreign`):
//
//   diagnostics.enabled                 true
//   diagnostics.otel.enabled            true
//   diagnostics.otel.protocol           http/protobuf (the only protocol it has)
//   diagnostics.otel.metricsEndpoint    <origin>/api/v1/governance/otlp/v1/metrics (exact URL, no path appended)
//   diagnostics.otel.logsEndpoint       <origin>/api/v1/governance/otlp/v1/logs   (only with telemetryLogs)
//   diagnostics.otel.headers            { X-API-Key: <ingest key> }
//   diagnostics.otel.traces             false (governance has no /v1/traces)
//   diagnostics.otel.metrics            true
//   diagnostics.otel.logs               telemetryLogs (default false: see below)
//   diagnostics.otel.captureContent     false (no prompt or response text, ever)
//   diagnostics.otel.serviceName        openclaw
//   plugins.entries.diagnostics-otel.enabled  true (and diagnostics-otel added to plugins.allow when there is one)
//
// LOGS ARE OFF BY DEFAULT. diagnostics-otel's logs are the gateway's own file log (logging.file) with the body
// withheld unless content capture is on: no event name, no session, no usage. Cost, tokens, model calls, tool
// timings and session state are all metrics. Set the plugin's telemetryLogs to send the logs too.
//
// Off switch: `openclaw config set plugins.entries.enforcer.config.telemetry false` removes the block (when it
// is ours). Disabling the openclaw@<host> agent in the Enforcer console does the same on the next check.
import { chmodSync, mkdirSync, statSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_DIR } from './credentials.mjs';

export const HARNESS = 'openclaw';
export const EXPORTER_PLUGIN = 'diagnostics-otel';
export const OTLP_SUFFIX = '/api/v1/governance/otlp';
const METRICS_PATH = `${OTLP_SUFFIX}/v1/metrics`;
const LOGS_PATH = `${OTLP_SUFFIX}/v1/logs`;
/** How often the gateway re-checks the key (rotation, revocation). ensureIngestKey itself asks v3 at most hourly. */
export const RECHECK_MS = 60 * 60_000;

export const STATUS_FILE = () => join(SHARED_DIR(), 'openclaw-telemetry.json');

const trim = (s) => String(s).replace(/\/+$/, '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The plugin's own settings (plugins.entries.enforcer.config), with defaults. */
export function settings(pluginConfig) {
  const c = isObj(pluginConfig) ? pluginConfig : {};
  return { telemetry: c.telemetry !== false, logs: c.telemetryLogs === true };
}

/** The diagnostics.otel block that sends to governance at otlpBase with key. */
export function desiredOtel({ otlpBase, key, logs = false }) {
  const base = trim(otlpBase);
  return {
    enabled: true,
    protocol: 'http/protobuf',
    metricsEndpoint: `${base}/v1/metrics`,
    ...(logs ? { logsEndpoint: `${base}/v1/logs` } : {}),
    headers: { 'X-API-Key': key },
    serviceName: 'openclaw',
    traces: false,
    metrics: true,
    logs,
    captureContent: false,
  };
}

/**
 * Whose diagnostics.otel block this is: `absent` (no destination set), `ours` (metrics go to a governance OTLP
 * path, on any origin, so a base-URL change is still ours to rewrite) or `foreign` (anywhere else).
 */
export function owner(cfg) {
  const o = cfg?.diagnostics?.otel;
  if (!isObj(o)) return 'absent';
  const dests = [o.endpoint, o.metricsEndpoint, o.logsEndpoint, o.tracesEndpoint].filter((v) => typeof v === 'string' && v);
  if (dests.length === 0 && !isObj(o.headers)) return 'absent';
  const ours = typeof o.metricsEndpoint === 'string' && trim(o.metricsEndpoint).endsWith(METRICS_PATH);
  const rest = dests.every((d) => d === o.metricsEndpoint || trim(d).endsWith(LOGS_PATH));
  return ours && rest ? 'ours' : 'foreign';
}

// Key order is not meaning: OpenClaw's writer reorders a block it round-trips.
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : isObj(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        )
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** True when cfg already holds exactly what enable() would write. */
export function isApplied(cfg, desired) {
  const allow = cfg?.plugins?.allow;
  return (
    cfg?.diagnostics?.enabled === true &&
    same(cfg?.diagnostics?.otel, desired) &&
    cfg?.plugins?.entries?.[EXPORTER_PLUGIN]?.enabled === true &&
    (!Array.isArray(allow) || allow.includes(EXPORTER_PLUGIN))
  );
}

/** Write desired into a mutable config draft. The caller has checked owner(draft) !== 'foreign'. */
export function enable(draft, desired) {
  draft.diagnostics = isObj(draft.diagnostics) ? draft.diagnostics : {};
  draft.diagnostics.enabled = true;
  draft.diagnostics.otel = structuredClone(desired);
  draft.plugins = isObj(draft.plugins) ? draft.plugins : {};
  draft.plugins.entries = isObj(draft.plugins.entries) ? draft.plugins.entries : {};
  const entry = isObj(draft.plugins.entries[EXPORTER_PLUGIN]) ? draft.plugins.entries[EXPORTER_PLUGIN] : {};
  draft.plugins.entries[EXPORTER_PLUGIN] = { ...entry, enabled: true };
  if (Array.isArray(draft.plugins.allow) && !draft.plugins.allow.includes(EXPORTER_PLUGIN)) draft.plugins.allow.push(EXPORTER_PLUGIN);
  return draft;
}

/** Remove our block from a draft (never a foreign one). diagnostics.enabled and the exporter plugin stay as they are. */
export function disable(draft) {
  if (owner(draft) === 'ours') delete draft.diagnostics.otel;
  return draft;
}

/** The redacted state `enforcer harness status openclaw` and the gateway log show. Never holds the key. */
function writeStatus(status, file = STATUS_FILE()) {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // status is a convenience; telemetry never depends on it
  }
}

export function readStatus(file = STATUS_FILE()) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** A config file that holds the key must not be readable by anyone else. */
function tighten(path) {
  try {
    if (path && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {}
}

// Thrown from inside a mutation to leave the file untouched: mutateConfigFile has no "no change" result, and
// rewriting an unchanged diagnostics.otel still makes the Gateway reload (a restart, for diagnostics-otel).
const NO_CHANGE = Symbol('no change');

/** Run fn on the config file's draft; fn returns true to write. Resolves to {wrote, path}. */
async function edit(mutate, fn) {
  try {
    const r = await mutate((draft) => {
      if (!fn(draft)) throw NO_CHANGE;
    });
    tighten(r?.path);
    return { wrote: true };
  } catch (e) {
    if (e === NO_CHANGE) return { wrote: false };
    throw e;
  }
}

/**
 * One check: get the key, and make openclaw.json say what it should. Fails open: a missing sign-in, a disabled
 * agent or a v3 outage never throws into OpenClaw; it is logged and recorded in the status file.
 *
 * Every write decision is made on the config FILE's draft, never on current(): the runtime snapshot redacts
 * header values ("X-API-Key": "***"), so a comparison against it never matches and would rewrite the file,
 * and restart the Gateway, on every check. current() is read only for whose block it is (endpoints are not
 * redacted), so a foreign collector is never handed a key.
 *
 * deps: current() -> the runtime config snapshot; mutate(fn) -> Promise<{path?}> (api.runtime.config.mutateConfigFile);
 * ensureKey() -> ensureIngestKey({harness:'openclaw'}); otlpBase() -> OTLP_BASE(); log {info,warn}.
 */
export async function sync({ pluginConfig, current, mutate, ensureKey, otlpBase, log = console, now = Date.now, statusFile = STATUS_FILE() }) {
  const s = settings(pluginConfig);
  const at = new Date(now()).toISOString();
  const done = (status) => {
    const out = { harness: HARNESS, at, ...status };
    writeStatus(out, statusFile);
    return out;
  };
  const turnOff = async (state, reason) => {
    const { wrote } = await edit(mutate, (draft) => owner(draft) === 'ours' && !!disable(draft));
    if (wrote) log.info?.(`enforcer: OpenClaw telemetry to Enforcer removed (${reason})`);
    return done({ state, reason, wrote });
  };

  if (!s.telemetry) return turnOff('off', 'plugins.entries.enforcer.config.telemetry is false');
  if (owner(current()) === 'foreign') {
    log.warn?.('enforcer: diagnostics.otel already points at another collector; leaving it alone (telemetry to Enforcer not configured)');
    return done({ state: 'foreign', reason: 'diagnostics.otel is configured for another collector' });
  }

  let key;
  try {
    key = await ensureKey();
  } catch (e) {
    const code = e?.code || 'error';
    if (code === 'agent_disabled') return turnOff('agent_disabled', e.message);
    log.warn?.(`enforcer: no telemetry key for OpenClaw (${code}): ${e?.message ?? e}`);
    return done({ state: code === 'signed_out' ? 'signed_out' : 'error', reason: String(e?.message ?? e), code });
  }

  const desired = desiredOtel({ otlpBase: otlpBase(), key: key.key, logs: s.logs });
  const view = { credentialId: key.credentialId, agentId: key.agentId, expiresAt: key.expiresAt, metricsEndpoint: desired.metricsEndpoint, logs: s.logs };
  let foreign = false;
  const { wrote } = await edit(mutate, (draft) => {
    if (owner(draft) === 'foreign') return !(foreign = true); // changed under us since the check above
    if (isApplied(draft, desired)) return false;
    enable(draft, desired);
    return true;
  });
  if (foreign) return done({ state: 'foreign', reason: 'diagnostics.otel is configured for another collector' });
  if (wrote) log.info?.(`enforcer: OpenClaw telemetry to Enforcer configured${key.source === 'cache' ? '' : ` (key ${key.source})`}`);
  return done({ state: 'on', ...view, wrote });
}

// ---- CLI: enforcer harness <install|status> openclaw ---------------------------------------------

/** OpenClaw installs plugins itself and asks the person to trust each source, so this prints the commands. */
export const INSTALL_STEPS = [
  'openclaw plugins install @openclaw/diagnostics-otel',
  'openclaw plugins install enforcer --marketplace instruxi-io/agent-plugins',
  'enforcer login            # once per machine, if this machine is not signed in yet',
  'openclaw mcp login enforcer   # the Enforcer MCP server signs in through OAuth',
];

const STATE_TEXT = {
  on: 'on: metrics go to Enforcer governance',
  off: 'off (plugins.entries.enforcer.config.telemetry is false)',
  foreign: 'not configured: diagnostics.otel already points at another collector, left alone',
  signed_out: 'waiting: this machine is not signed in to Enforcer (run enforcer login)',
  agent_disabled: 'off: the openclaw agent for this machine is disabled in the Enforcer console',
  error: 'error: the last check could not get a telemetry key',
};

/** `enforcer harness status openclaw`: what the Gateway last did. Prints nothing secret. */
export function statusText(st = readStatus()) {
  if (!st) return 'OpenClaw telemetry: no check recorded yet (install the enforcer OpenClaw plugin and start the Gateway)\n';
  const lines = [`OpenClaw telemetry: ${STATE_TEXT[st.state] ?? st.state}`, `  last check: ${st.at}`];
  if (st.metricsEndpoint) lines.push(`  endpoint:   ${st.metricsEndpoint}${st.logs ? ' (+ logs)' : ''}`);
  if (st.credentialId) lines.push(`  key:        credential ${st.credentialId} (agent ${st.agentId}), expires ${st.expiresAt}`);
  if (st.reason && st.state !== 'off') lines.push(`  reason:     ${st.reason}`);
  lines.push('  turn off:   openclaw config set plugins.entries.enforcer.config.telemetry false');
  return `${lines.join('\n')}\n`;
}

export function main(sub, { out = (s) => process.stdout.write(s) } = {}) {
  if (sub === 'install') {
    out(
      `Install the enforcer plugin into OpenClaw (each command asks you to trust its source):\n\n${INSTALL_STEPS.map((s) => `  ${s}`).join('\n')}\n\nThe Gateway then points diagnostics-otel at Enforcer governance with a telemetry-only key for this machine.\n`,
    );
    return 0;
  }
  if (sub === 'status') {
    out(statusText());
    return 0;
  }
  return 2;
}
