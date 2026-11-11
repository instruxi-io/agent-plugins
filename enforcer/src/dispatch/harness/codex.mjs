// The Codex CLI worker: `codex exec --json` in a workspace-write sandbox, stdin closed (spawnWorker), never
// danger-full-access. The dispatcher commits and lands for it (codex-land.mjs): the sandbox keeps a linked worktree's
// git metadata read-only.
//
// On a route with an endpoint (docs/graph/ROUTES.md section 4) the worker gets a CODEX_HOME of its own,
// <state>/codex-<key>/ (0700), holding a config.toml (0600) the dispatcher writes and removes when the worker exits:
//   - the route's model and an OpenAI-compatible provider (`base_url = <url>/v1`, `wire_api = "responses"`) whose key
//     Codex reads from ENFORCER_ROUTE_TOKEN (the file names the variable, never the value);
//   - the enforcer MCP server with the worker's credential sent as X-API-Key from ENFORCER_API_KEY (env_http_headers:
//     the file names the variable), its tools approved (exec cannot answer an approval prompt), no stored OAuth;
//   - the [otel] export to governance (lib/governor/adapters/codex/telemetry.mjs applyOtel, the one copy of that
//     block) with this machine's telemetry-only ingest key; without a key the worker runs without telemetry;
//   - AGENTS.md: the graph-worker instructions (agents/graph-worker.md), which Codex reads from CODEX_HOME.
// Without an endpoint nothing is written: Codex runs on the operator's CODEX_HOME (its login, its plugins and hooks)
// with the enforcer server given on the command line, as before.
import { closeSync, chmodSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isObj } from '../util.mjs';
import { assertIdent } from '../ident.mjs';
import { addSecret } from '../logs.mjs';
import { codexGitRules } from '../codex-land.mjs';
import { knowsModel, readStream, routeToken, PLUGIN_DIR } from './common.mjs';

/** The variable the provider's key is read from (`env_key`); 'none' when the route names no token_env. */
export const ROUTE_TOKEN_ENV = 'ENFORCER_ROUTE_TOKEN';
/** The variable the enforcer MCP server's X-API-Key header is read from: workerEnv sets it to the worker's credential. */
export const MCP_KEY_ENV = 'ENFORCER_API_KEY';
export const MCP_KEY_HEADER = 'X-API-Key';
/** Inherited variables that would point Codex somewhere else or bill the operator: never passed on an endpoint route. */
export const CODEX_ENDPOINT_DROP = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'CODEX_API_KEY'];
export const DEFAULT_MCP_URL = 'https://api.instruxi.dev/mcp';
export const TELEMETRY_TIMEOUT_MS = 8000;
export const WORKER_INSTRUCTIONS = join(PLUGIN_DIR, 'agents', 'graph-worker.md');

export const codexHomePath = (stateDir, key) => join(stateDir, `codex-${assertIdent(key, 'node key')}`);

const tomlString = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string
const mcpUrlOf = (args, env = process.env) => args?.mcpUrl || env.ENFORCER_MCP_URL || DEFAULT_MCP_URL;

/** The provider's base URL: the route's root (validation strips any path) plus /v1, where vLLM serves the OpenAI API. */
export const providerBaseUrl = (url) => `${String(url).replace(/\/+$/, '')}/v1`;

/**
 * config.toml for one worker. `route` must have an endpoint; `otel` is the [otel] text from applyOtel, or null.
 * Holds no secret of its own: the provider key and the MCP header are read from the environment by name; only the
 * otel block carries a (telemetry-only) key, because Codex 0.164 sends otel headers literally.
 */
export function codexConfig({ route, key, mcpUrl, otel = null }) {
  const ep = route.endpoint;
  const L = [
    `# Written by the enforcer dispatcher for worker ${key}; removed when it exits. Do not edit.`,
    `model = ${tomlString(route.model)}`,
    'model_provider = "route"',
    'model_reasoning_effort = "medium"',
    // a headless worker on a self-hosted model: no update check, and no stored login or MCP OAuth from the keyring
    'check_for_update_on_startup = false',
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    '',
    '[model_providers.route]',
    `name = ${tomlString(`route ${route.route || route.tier || 'endpoint'}`)}`,
    `base_url = ${tomlString(providerBaseUrl(ep.url))}`,
    `env_key = ${tomlString(ROUTE_TOKEN_ENV)}`,
    'wire_api = "responses"',
    '',
    '[mcp_servers.enforcer]',
    `url = ${tomlString(mcpUrl)}`,
    `env_http_headers = { ${tomlString(MCP_KEY_HEADER)} = ${tomlString(MCP_KEY_ENV)} }`,
    // headless exec cannot answer an approval prompt: approve this server's tools only, not shell or other servers
    'default_tools_approval_mode = "approve"',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ];
  return L.join('\n') + (otel ? '\n' + otel.replace(/^\n+/, '') : '');
}

/** The graph-worker instructions for Codex: agents/graph-worker.md without its Claude Code frontmatter. */
export function workerInstructions(path = WORKER_INSTRUCTIONS) {
  const text = readFileSync(path, 'utf8');
  const body = text.startsWith('---\n') ? text.slice(text.indexOf('\n---', 4) + 4).replace(/^\n+/, '') : text;
  return [
    '# Enforcer graph worker (Codex)',
    '',
    "Under Codex the graph tools are the `enforcer` MCP server's tools (graph_next_work, graph_heartbeat, graph_report,",
    'graph_remember, graph_plan_status); they are already approved. Claude Code tool names below (ToolSearch, Skill,',
    'Read, Edit) map to your own shell and file tools. Your sandbox keeps git metadata read-only: the dispatcher commits',
    'and lands for you (your prompt says how).',
    '',
    body,
  ].join('\n');
}

/** Write `text` to a new file at `p`, created 0600 (never world-readable for a moment). */
function writePrivate(p, text) {
  rmSync(p, { force: true });
  const fd = openSync(p, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort on platforms without modes */
  }
}

/** Remove one worker's CODEX_HOME, or with no key every `codex-*` dir left in the state dir (dispatcher start and shutdown). */
export function removeCodexHomes(stateDir, key = null) {
  if (key) {
    rmSync(codexHomePath(stateDir, key), { recursive: true, force: true });
    return;
  }
  let names = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    return;
  }
  for (const n of names) if (/^codex-[A-Za-z0-9._-]+$/.test(n)) rmSync(join(stateDir, n), { recursive: true, force: true });
}

/** p, or a rejection after ms; the timer is cleared either way. */
async function withTimeout(p, ms) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`no ingest key within ${ms / 1000}s`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * The [otel] block for a worker, or {otel: null, why} when there is none: the operator turned Codex telemetry off
 * (codexTelemetry), or no telemetry-only key could be had (signed out, agent disabled, Enforcer unreachable).
 * Never throws: telemetry never fails a worker. `deps` are test seams.
 */
export async function workerOtel({ ensureIngestKey = null, loadConfig = null, timeoutMs = TELEMETRY_TIMEOUT_MS } = {}) {
  const tel = await import('../../../lib/governor/adapters/codex/telemetry.mjs');
  let cfg = {};
  try {
    cfg = loadConfig ? loadConfig() : (await import('../../../lib/governor/core/store.mjs')).loadConfig();
  } catch {
    /* no governor config: the defaults (telemetry on) apply */
  }
  const { isOff } = await import('../../../lib/governor/core/bool.mjs');
  if (isOff(cfg?.codexTelemetry)) return { otel: null, why: 'codexTelemetry is off in the governor config' };
  try {
    const ensure = ensureIngestKey || (await tel.loadEnsureIngestKey());
    const { key } = await withTimeout(Promise.resolve(ensure({ harness: tel.HARNESS })), timeoutMs);
    if (!key) return { otel: null, why: 'no ingest key' };
    addSecret(key);
    return { otel: tel.applyOtel('', { origin: tel.ingestOrigin(cfg), key }), why: null, key };
  } catch (e) {
    return { otel: null, why: `no ingest key: ${e?.message || e}` };
  }
}

/** `codex exec --json` prints one JSON event per line (fixtures: test/fixtures/codex-exec.jsonl, codex-exec-route.jsonl):
 *  thread.started{thread_id}, turn.started, item.started|completed{item:{id,type,...}}, turn.completed{usage},
 *  turn.failed{error{message}}, error{message}. Item types read: agent_message{text},
 *  command_execution{command,aggregated_output,exit_code,status}, mcp_tool_call{server,tool,arguments,result,error,status}.
 *  Anything else (reasoning, `error` items, which the fixtures show as warnings) is ignored. An MCP call is named
 *  mcp__<server>__<tool>, so a graph_next_work / graph_report reads as it does from Claude Code (run id, reported). */
export function* codexEvents(path) {
  const text = readStream(path);
  if (text === null) return;
  let sid = null;
  let turns = 0;
  let lastText = null;
  let error = null;
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let sawUsage = false;
  // cache_write_input_tokens: some Codex builds send it (fixture codex-exec.jsonl), most do not; carried only when seen
  let cacheWrite = null;
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    const item = isObj(e.item) ? e.item : {};
    if (e.type === 'thread.started') {
      sid = typeof e.thread_id === 'string' ? e.thread_id : null;
      yield { type: 'system', subtype: 'init', session_id: sid, message: {} };
    } else if (e.type === 'item.completed' && item.type === 'agent_message') {
      turns++;
      lastText = String(item.text ?? '');
      yield { type: 'assistant', message: { content: [{ type: 'text', text: lastText }] } };
    } else if (e.type === 'item.completed' && item.type === 'command_execution') {
      turns++;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command } }] } };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: item.exit_code !== 0, content: String(item.aggregated_output ?? '') }] },
      };
    } else if (e.type === 'item.completed' && item.type === 'mcp_tool_call') {
      turns++;
      const name = `mcp__${String(item.server ?? '')}__${String(item.tool ?? '')}`;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name, input: isObj(item.arguments) ? item.arguments : {} }] } };
      const res = isObj(item.result) ? item.result : {};
      const failed = item.status === 'failed' || isObj(item.error);
      const content = Array.isArray(res.content) ? res.content : isObj(item.error) ? String(item.error.message ?? '') : '';
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: failed, content }] } };
    } else if (e.type === 'turn.completed' || e.type === 'turn.failed') {
      const u = isObj(e.usage) ? e.usage : {};
      for (const k of Object.keys(usage)) {
        if (typeof u[k] !== 'number') continue;
        usage[k] += u[k];
        sawUsage = true;
      }
      if (typeof u.cache_write_input_tokens === 'number') cacheWrite = (cacheWrite || 0) + u.cache_write_input_tokens;
      const failed = e.type === 'turn.failed';
      if (failed) error = String((isObj(e.error) ? e.error.message : null) ?? error ?? 'turn failed');
      yield {
        type: 'result',
        subtype: failed ? 'error_turn_failed' : 'success',
        is_error: failed,
        num_turns: turns,
        session_id: sid,
        result: failed ? error : lastText,
        usage: sawUsage
          ? {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_input_tokens: usage.cached_input_tokens,
              reasoning_output_tokens: usage.reasoning_output_tokens,
              ...(cacheWrite !== null ? { cache_creation_input_tokens: cacheWrite } : {}),
            }
          : { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens },
        message: {},
      };
    } else if (e.type === 'error') {
      error = String(e.message ?? 'error');
    }
  }
}

// ---- usage after exit

/**
 * The run usage body (graph's runs.Usage) for a codex worker's summary, or null when its stream reported no usage
 * (null means "not reported": never post zeros for it). Codex's counts are cumulative over the turns (codexEvents
 * sums every turn.completed), and its input_tokens INCLUDES the cached prompt tokens. Graph's convention is Claude's:
 * input_tokens EXCLUDES cache reads and cache writes. So (the same split as governance migration 040):
 *   input_tokens                = input - cached_input - cache_write_input   (floor 0: a stream with cached > input)
 *   cache_read_input_tokens     = cached_input
 *   cache_creation_input_tokens = cache_write_input, else 0 (most Codex builds do not send it)
 *   output_tokens               = output (Codex's reasoning tokens are already inside output; not added again)
 *   turns                       = the run's turns as the done line counts them
 *   model                       = the model the route launched it on
 *   source                      = "reported" (the provider's own counters)
 * cost_usd is never sent: an endpoint route is self-hosted (no price), and Codex's stream carries no cost.
 */
export function codexRunUsage(s, { model = null } = {}) {
  const u = isObj(s?.usage) ? s.usage : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  const cached = num(u.cache_read_input_tokens) ?? 0;
  const write = num(u.cache_creation_input_tokens) ?? 0;
  const turns = num(s?.num_turns) ?? num(s?.turns);
  return {
    ...(model ? { model: String(model) } : {}),
    input_tokens: Math.max(0, (input ?? 0) - cached - write),
    output_tokens: output ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: write,
    ...(turns !== null ? { turns } : {}),
    source: 'reported',
  };
}

// ---- preflight

export const SANDBOX_FIX =
  'Ubuntu restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and bwrap has no AppArmor ' +
  'profile granting userns, so every sandboxed command would fail with "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted". ' +
  'Fix: install a profile for /usr/bin/bwrap that allows userns (docs/graph/DISPATCHER.md "Codex workers"), e.g. ' +
  "printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,\\n}\\n' | " +
  'sudo tee /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap. Never run codex workers with danger-full-access instead.';
export const USERNS_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

/** The first `bwrap` on PATH (/usr/bin/bwrap first: the path Ubuntu's AppArmor profiles attach to), or null. */
function findBwrap(env, exists = existsSync) {
  const dirs = ['/usr/bin', ...String(env.PATH || '').split(':')].filter(Boolean);
  for (const d of dirs) if (exists(join(d, 'bwrap'))) return join(d, 'bwrap');
  return null;
}

/**
 * Can Codex's Linux sandbox start here? The cheapest probe that fails the way Codex does: bwrap with a new user and
 * network namespace (bwrap brings up loopback in the new netns, which is exactly the RTM_NEWADDR step a userns without
 * capabilities refuses). Not Linux: Codex uses Seatbelt (macOS), nothing to probe. Returns {ok, line}.
 * `sys` is a test seam: {platform, readFile, run, env, exists}.
 */
export function sandboxProbe({
  platform = process.platform,
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
  run = spawnSync,
  exists = existsSync,
} = {}) {
  if (platform !== 'linux') return { ok: true, line: `not Linux (${platform}): Codex uses its own sandbox there, not probed` };
  let restricted = null;
  try {
    restricted = readFile(USERNS_SYSCTL).trim() === '1';
  } catch {
    restricted = false;
  }
  const bwrap = findBwrap(env, exists);
  if (!bwrap) {
    return restricted
      ? { ok: false, line: `no bwrap on PATH and ${USERNS_SYSCTL} is 1. ${SANDBOX_FIX}` }
      : { ok: true, line: 'no system bwrap; Codex uses its bundled one (user namespaces are not restricted)' };
  }
  const r = run(bwrap, ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8', timeout: 5000 });
  if (r.status === 0)
    return { ok: true, line: `${bwrap} can unshare user and network namespaces${restricted ? ' (AppArmor userns restriction on, bwrap allowed)' : ''}` };
  const why = String(r.stderr || r.error?.message || `exit ${r.status}`)
    .trim()
    .split('\n')[0];
  return { ok: false, line: `${bwrap} cannot start a sandbox: ${why}. ${SANDBOX_FIX}` };
}

/** `codex --version`: {ok, line}. */
export function codexVersion(bin, { run = spawnSync } = {}) {
  const r = run(bin, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return { ok: false, line: `${bin} not runnable: ${r.error?.code || r.error?.message || `exit ${r.status}`}` };
  return { ok: true, line: `${bin}: ${String(r.stdout || '').trim() || 'unknown version'}` };
}

/** Preflight for a run with codex workers: the binary and its version, then the sandbox. [{name, ok, line}]. */
export function codexPreflight(args = {}, sys = {}) {
  const bin = args.codex || (sys.env || process.env).CODEX_BIN || 'codex';
  const out = [];
  const v = codexVersion(bin, sys);
  out.push({ name: 'codex', ...v });
  out.push({ name: 'codex-sandbox', ...sandboxProbe(sys) });
  return out;
}

const caps = { supported: true, experimental: true, models: ['gpt', 'o1', 'o3', 'o4', 'codex'], resume: false };

/** @type {import('./index.mjs').HarnessAdapter} */
export default {
  name: 'codex',
  caps,
  apis: ['openai'],

  command(prompt, model, args, key, { codexHome = null, endpoint = false } = {}) {
    const cmd = [
      args.codex || process.env.CODEX_BIN || 'codex',
      'exec',
      '--json',
      // default exec sandbox is read-only (a worker could not commit or land): write inside the cwd (the worktree) only,
      // plus network for git push and gh. Narrower than danger-full-access; no approvals needed (exec never asks).
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ];
    // No `--add-dir <git common dir>`: workspace-write keeps a linked worktree's git metadata read-only by design even
    // with it (codex 0.164, measured 2026-10-31). A codex worker edits and checks only; the dispatcher commits and lands.
    // With a CODEX_HOME of its own the enforcer server is in its config.toml; otherwise on the command line. Headless exec
    // cannot answer an MCP approval prompt ("approval policy is never"): approve only the enforcer server's tools. The
    // worker's credential, when it has one, goes as X-API-Key from ENFORCER_API_KEY: the argv names the variable only.
    if (!codexHome)
      cmd.push(
        '-c',
        `mcp_servers.enforcer={url=${JSON.stringify(mcpUrlOf(args))}, default_tools_approval_mode="approve", env_http_headers={${JSON.stringify(MCP_KEY_HEADER)}=${JSON.stringify(MCP_KEY_ENV)}}}`,
      );
    // an endpoint's model is trusted to the probe, not to the prefix list (ROUTES.md section 4)
    if ((endpoint && codexHome) || knowsModel(caps, model)) cmd.push('--model', model);
    return [...cmd, prompt];
  },

  /** ROUTES.md section 4 for Codex: the provider key under ROUTE_TOKEN_ENV, and nothing of the operator's OpenAI setup. */
  endpointEnv(out, route, env = process.env) {
    for (const k of CODEX_ENDPOINT_DROP) delete out[k];
    const token = routeToken(route, env);
    if (token) addSecret(token);
    // the placeholder keeps Codex off any login of its own when the route names no token (vLLM without --api-key ignores it)
    out[ROUTE_TOKEN_ENV] = token || 'none';
    // as measured on the Spark (2026-11-10): a self-hosted provider run with OPENAI_API_KEY=none
    out.OPENAI_API_KEY = 'none';
    return out;
  },

  plan({ state, key, route }) {
    return { codexHome: route?.endpoint ? codexHomePath(state, key) : null };
  },

  prepareWhat: 'write its Codex config',
  /** Write <state>/codex-<key>/ (0700) with config.toml and AGENTS.md (0600). `deps` are test seams for workerOtel. */
  async prepare(plan, { key, args, route, deps = /** @type {any} */ ({}) }) {
    if (!plan.codexHome) return { env: {}, cleanup: [] };
    const dir = plan.codexHome;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const notes = [];
    try {
      const t = await workerOtel(deps);
      if (!t.otel) notes.push(`codex workers run without telemetry: ${t.why}`);
      writePrivate(join(dir, 'config.toml'), codexConfig({ route, key, mcpUrl: mcpUrlOf(args), otel: t.otel }));
      writePrivate(join(dir, 'AGENTS.md'), workerInstructions(deps.instructions));
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return { env: { CODEX_HOME: dir }, cleanup: [dir], notes };
  },

  promptRules: () => codexGitRules(),
  events: codexEvents,
  // a codex worker completes its run through MCP before it exits, without usage: the dispatcher posts it afterwards
  usageAfterExit: (s, { model }) => codexRunUsage(s, { model }),
  preflight: codexPreflight,
  sweep: (state) => removeCodexHomes(state),
};
