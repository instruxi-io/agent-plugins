// Launching workers: the claude/grok/codex/gemini command lines, the worker environment, detached spawn,
// and process-group kill (SIGTERM, a grace period, then SIGKILL) by process.kill(-pid).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { assertIdent } from './ident.mjs';
import { readFileSync, closeSync, realpathSync, openSync, writeSync, chmodSync, rmSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { openStream, redactFile, addSecret } from './logs.mjs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, DEFAULT_BASE_URL, BASE_URL_VAR } from '../config.mjs';
import { DOT } from '../../hooks/claude/paths.mjs';
import { PROFILE_NAME } from '../../lib/governor/profiles/headless-worker.mjs';

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LAND_PR = join(PLUGIN_DIR, 'bin', 'land-pr.sh');
export const AGENT = process.env.GRAPH_DISPATCH_AGENT || 'enforcer:graph-worker';
export const GRAPH_TOOLS = ['graph_next_work', 'graph_heartbeat', 'graph_report', 'graph_remember', 'graph_plan_status'];
export const PREFIXES = ['mcp__plugin_enforcer_enforcer__', 'mcp__enforcer__', 'mcp__enforcer-graph__'];
export const BASE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'ToolSearch'];
export const HARNESSES = ['claude', 'codex', 'grok', 'gemini'];
export const HARNESS_CAPS = {
  claude: { supported: true, experimental: false, models: null },
  grok: { supported: true, experimental: true, models: ['grok'] },
  codex: { supported: true, experimental: true, models: ['gpt', 'o1', 'o3', 'o4', 'codex'] },
  gemini: { supported: true, experimental: true, models: ['gemini', 'auto'] },
};

/** Per-launch settings: the installed release is off for the child, so the --plugin-dir checkout is the only copy of the hooks and MCP server. */
export const DISABLED_PLUGINS = { 'enforcer@instruxi': false };
export const workerSettings = () => JSON.stringify({ enabledPlugins: DISABLED_PLUGINS });

export const allowedTools = () => [...BASE_TOOLS, ...PREFIXES.flatMap((p) => GRAPH_TOOLS.map((t) => p + t))];

export function harnessKnowsModel(harness, model) {
  const pre = HARNESS_CAPS[harness]?.models;
  return Boolean(model) && (!pre || pre.some((p) => String(model).startsWith(p)));
}

/** The refusal message for a harness that cannot run workers, else null. */
export function harnessRefusal(harness, experimental) {
  const cap = HARNESS_CAPS[harness] || {};
  if (cap.supported === false) return `--harness ${harness} is not supported: ${cap.why || 'no capability'}`;
  if (cap.experimental && !experimental) return `--harness ${harness} is experimental: pass --experimental to use it`;
  return null;
}

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

/** The only inherited variables: the operator's keys (ENFORCER_API_KEY, GRAPH_API_KEY, cloud keys, gh tokens) never pass. */
export const ENV_ALLOW = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'GRAPH_ID',
  BASE_URL_VAR,
  'ENFORCER_PROFILE',
  'ENFORCER_GOVERNOR_RULES',
  'ENFORCER_CONTEXT_PACK',
  'ENFORCER_HARNESS',
  'JEV_HOOKS_HEADLESS',
  'CLAUDE_PLUGIN_ROOT',
  'ENFORCER_PLUGIN_ROOT',
  // named locale and Claude variables (no CLAUDE_* or LC_* prefix passes: an unknown variable may carry a secret)
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];
export const ENV_ALLOW_PREFIX = [];
/** The owner's default for whether dispatched workers run with the worker rules on: decisioning is off unless configured. The one place to change it. */
export const DEFAULT_WORKER_RULES = 'off';
export const WORKER_RULES_MODES = ['on', 'off'];
/** The one preflight line that states the mode. */
export const workerRulesLine = (mode = DEFAULT_WORKER_RULES) =>
  mode === 'on'
    ? 'workers run with the worker rules ON (pass --worker-rules off to relax them)'
    : 'workers run with the worker rules OFF (pass --worker-rules on to enforce them)';
/** Scopes a worker token may carry: graph only. */
export const WORKER_SCOPES = ['graph:read', 'graph:write'];

const allowed = (k) => ENV_ALLOW.includes(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p));

/** Operator credentials a Claude worker on an endpoint route must not inherit: each would win over ANTHROPIC_BASE_URL (or bill the operator). */
export const ENDPOINT_DROP = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY'];
/** Claude Code's model aliases: all point at the route's model, so no alias (agent file, subagent, fallback) lands on Anthropic. */
export const ENDPOINT_MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];
/** The route endpoint's token, read only from the variable its `token_env` names (never argv, never a file); null when it names none. */
export const routeToken = (route, env = process.env) => {
  const name = route?.endpoint?.token_env;
  const v = name ? env[name] : null;
  return typeof v === 'string' && v ? v : null;
};

/** ROUTES.md item 4: the endpoint variables for `route` set on `out` in place. A route with no endpoint changes nothing. */
export function endpointEnv(out, route, env = process.env) {
  const ep = route?.endpoint;
  if (!ep) return out;
  const harness = route.harness || 'claude';
  // Only claude has an endpoint form today; validation (routes.mjs) refuses the others, so this is a second guard, not a path.
  if (harness !== 'claude') throw new Error(`${harness} cannot use a custom endpoint`);
  for (const k of ENDPOINT_DROP) delete out[k];
  const token = routeToken(route, env);
  if (token) addSecret(token);
  out.ANTHROPIC_BASE_URL = ep.url;
  // Sent as Authorization: Bearer. A fixed placeholder when the route names no token, so Claude Code never falls back to the operator's login.
  out.ANTHROPIC_AUTH_TOKEN = token || 'none';
  for (const k of ENDPOINT_MODEL_VARS) out[k] = String(route.model);
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return out;
}

/** The worker environment: the allowlist, the run's worker-scoped token (as GRAPH_API_KEY), if the operator
 *  provides one, a repo-scoped GH_TOKEN (ENFORCER_WORKER_GH_TOKEN), and, for a route with an endpoint, that
 *  endpoint's variables (endpointEnv; the token from the route's token_env, read in `routeEnv` or `env`). Nothing else. */
export function workerEnv(
  graphId,
  env = process.env,
  {
    token = null,
    release = false,
    runId = null,
    workerRules = DEFAULT_WORKER_RULES,
    context = 'on',
    baseUrl = null,
    enforcerHome = null,
    governorHome = null,
    route = null,
    routeEnv = null,
    harness = 'claude',
  } = {},
) {
  const root = pluginDirs()[0];
  const out = {};
  for (const [k, v] of Object.entries(env)) if (allowed(k) && v !== undefined) out[k] = v;
  // `enforcer` inside a worker is THIS plugin's bin, ahead of whatever the operator's PATH resolves: on 2026-10-13 the
  // shell shim `enforcer harness install` writes ran a Grok runtime copy two minor versions old, and every worker
  // launched through it died at once (`--agent enforcer:graph-worker not found`) or ran old evidence code.
  out.PATH = [join(root, 'bin'), ...(out.PATH ? [out.PATH] : [])].join(delimiter);
  Object.assign(out, {
    GRAPH_ID: graphId,
    ENFORCER_PROFILE: PROFILE_NAME, // = PROFILE_ENV
    JEV_HOOKS_HEADLESS: '1',
    CLAUDE_PLUGIN_ROOT: root,
    ENFORCER_PLUGIN_ROOT: root,
  });
  // Grok imports Claude Code's enabled plugins, and expands their hooks' ${CLAUDE_PLUGIN_ROOT} from the environment: with ours set, jev-hooks'
  // UserPromptSubmit gate ran enforcer's path, failed, and blocked the first prompt (every grok worker ended `cancelled` at 0 turns).
  // Grok's own enforcer plugin does not read it (ENFORCER_PLUGIN_ROOT stays), so a grok worker gets none.
  if (harness === 'grok') delete out.CLAUDE_PLUGIN_ROOT;
  // The host root the dispatcher itself talks to (the same resolver its API client uses): without it a worker holding only an API key has no base and its hooks go silent.
  try {
    out[BASE_URL_VAR] = baseUrl || resolveConfig({ env }).baseUrl;
  } catch {
    if (!out[BASE_URL_VAR]) out[BASE_URL_VAR] = DEFAULT_BASE_URL;
  }
  out.ENFORCER_GOVERNOR_RULES = workerRules === 'on' ? 'on' : 'off'; // always set from the flag: an inherited value never decides
  out.ENFORCER_CONTEXT_PACK = context === 'off' ? '0' : '1'; // always set from the flag
  if (release) out.ENFORCER_RELEASE_NODE = '1';
  if (runId) {
    out.GRAPH_RUN_ID = String(runId);
    out.ENFORCER_GRAPH_RUN_ID = String(runId);
  }
  // The worker's credential has two readers: the graph hooks read GRAPH_API_KEY, but the plugin's MCP header helper (bin/enforcer-headers.mjs,
  // src/credentials.mjs) reads ENFORCER_API_KEY and otherwise falls back to the OPERATOR's saved sign-in, so a claim made through the MCP tools
  // would be attributed to the operator, not the agent. Give both the same token. The operator's own ENFORCER_API_KEY is still never inherited.
  if (token) {
    out.GRAPH_API_KEY = token;
    out.ENFORCER_API_KEY = token;
    // HOME stays (git, gh and friends need it) but the shared sign-in lives under ENFORCER_HOME: point that at an empty per-run directory.
    if (enforcerHome) out.ENFORCER_HOME = enforcerHome;
    // The governor's receipts go to a lane of their own (governorLane): in the operator's record they would be shipped by
    // whichever process ships next, under ITS credential, and one run would land as two sessions under two accounts.
    if (governorHome) out.GOVERNOR_HOME = governorHome;
  }
  if (env.ENFORCER_WORKER_GH_TOKEN) out.GH_TOKEN = env.ENFORCER_WORKER_GH_TOKEN;
  // A route with an endpoint: that harness's base URL, token and model variables, and the operator's provider credentials dropped.
  if (route?.endpoint) endpointEnv(out, route, routeEnv || env);
  return out;
}

/** The governor's record directory as the governor itself resolves it (lib/governor/core/store.mjs DIR), for `env`. */
export const governorDir = (env = process.env) =>
  env.GOVERNOR_HOME || join(env.ENFORCER_CONFIG_HOME || join(env.HOME || env.USERPROFILE || '.', '.config', 'enforcer'), 'governor');

/** A stable, non-secret lane name for the account a worker credential speaks as: the worker agent id when the dispatcher mints, else a hash of the agent key. */
export const laneId = ({ agent = null, agentKey = null } = {}) => {
  const owner = agent ? `agent:${agent}` : agentKey ? `key:${agentKey}` : null;
  return owner ? createHash('sha256').update(owner).digest('hex').slice(0, 16) : null;
};

/**
 * The governor record a worker with its own credential writes to: `<governor dir>/agents/<laneId>`, one per account per machine.
 *
 * WHY. The governor keeps ONE receipt file and ONE outbox per machine, and its shipper sends whatever is pending under the
 * credential of the process that runs it. A worker carries the agent's key while the operator's own sessions carry the
 * operator's sign-in, so each shipped the other's receipts: a dispatched run's decisions landed under the operator's account
 * while its Claude telemetry landed under the agent's, and the console counted one run as two sessions. A lane per account
 * means only that account's processes ever ship it. It persists across runs (its chain continues, it is one install, not one
 * per run), and the operator's config.json is copied in on each launch so shipOn and the local rules still follow the operator.
 * Returns the lane path, or null when there is no credential of its own to keep apart.
 */
export function governorLane(owner, env = process.env) {
  const id = laneId(owner);
  if (!id) return null;
  const base = governorDir(env);
  const lane = join(base, 'agents', id);
  mkdirSync(lane, { recursive: true, mode: 0o700 });
  try {
    chmodSync(lane, 0o700);
  } catch {
    /* best effort */
  }
  let cfg = null;
  try {
    cfg = readFileSync(join(base, 'config.json'));
  } catch {
    /* no operator config: the defaults apply, as they do for the operator */
  }
  if (cfg) {
    const tmp = join(lane, `.config.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, cfg, { mode: 0o600 });
      renameSync(tmp, join(lane, 'config.json'));
    } catch {
      rmSync(tmp, { force: true });
    }
  }
  return lane;
}

/** The governor's shipper (lib/governor/core/bin/ship.mjs). */
export const GOVERNOR_SHIPPER = join(PLUGIN_DIR, 'lib', 'governor', 'core', 'bin', 'ship.mjs');

/**
 * Ship what a worker's lane still holds, with the worker's own environment (its credential), before that credential is revoked.
 * The worker's hooks ship at most every 30s, so the last receipts of a run would otherwise wait for the next run of the same
 * account. Bounded; never throws. Resolves to the shipper's one line, or null.
 */
export function drainGovernorLane(env, { shipper = GOVERNOR_SHIPPER, timeoutMs = 20_000, tries = 3, waitMs = 2_000, spawnImpl = spawn } = {}) {
  if (!env?.GOVERNOR_HOME) return Promise.resolve(null);
  const once = () =>
    new Promise((resolve) => {
      let out = '';
      let p;
      try {
        p = spawnImpl(process.execPath, [shipper, '--print'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return resolve(null);
      }
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, timeoutMs);
      p.stdout?.on('data', (d) => (out += d));
      p.on('error', () => {
        clearTimeout(t);
        resolve(null);
      });
      p.on('close', () => {
        clearTimeout(t);
        resolve(out.trim() || null);
      });
    });
  return (async () => {
    let line = null;
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, waitMs));
      line = await once();
      // A shipper the worker's own hook kicked may still hold the lane's lock: wait it out rather than leave the tail.
      if (!line || !/another shipper is running/.test(line)) break;
    }
    return line;
  })();
}

/** Mint a worker-scoped credential for the run through the agent credential route; null when no worker agent is configured. */
export async function mintWorkerToken(api, env = process.env, name = 'graph-worker') {
  return (await mintWorkerCredential(api, env, name))?.secret || null;
}

/**
 * The new credential's id in an issue response. enforcer-v3 answers `{success, data: {credential: {id, ...}, secret}}`
 * (IssuedCredential in enforcer-v3 internal/usecase/agents/views.go); a flat `data.id` / `data.credential_id` is still read.
 */
export const issuedCredentialId = (r) => {
  const d = r?.data;
  const id = d?.credential?.id || d?.id || d?.credential_id;
  return typeof id === 'string' && id ? id : null;
};

/**
 * As mintWorkerToken, but returns {secret, id, agent} so the caller can revoke it; throws when the mint answered without a secret.
 * A response without the credential's id is warned about: without it the credential cannot be revoked and lives its full day.
 */
export async function mintWorkerCredential(
  api,
  env = process.env,
  name = 'graph-worker',
  { warn = (m) => process.stderr.write(`graph-dispatch: ${m}\n`) } = {},
) {
  const agent = env.ENFORCER_WORKER_AGENT_ID;
  if (!agent) return null;
  const r = await api.call('POST', `/agents/${agent}/credentials`, { name, scopes: WORKER_SCOPES, expires_in_days: 1 });
  const secret = r?.data?.secret || null;
  if (!secret) throw new Error(`no secret in the mint response (status ${r?.status ?? 'unknown'})`);
  const id = issuedCredentialId(r);
  if (!id) warn(`the worker credential "${name}" came back without an id, so it cannot be revoked when the worker exits; it expires on its own in a day`);
  return { secret, id, agent };
}

/** Delete a minted worker credential; best effort, returns true when the call did not throw. */
export async function revokeWorkerCredential(api, cred) {
  if (!cred?.id) return false;
  try {
    await api.call('DELETE', `/agents/${cred.agent}/credentials/${cred.id}`);
    return true;
  } catch {
    return false;
  }
}

/** The worker's own MCP connection when it runs as an agent: Claude Code prefers its stored `/mcp` OAuth sign-in for the plugin's
 *  server over the headersHelper, so the environment cannot make the plugin's server speak as the agent. A per-run config with the
 *  agent key as a header, launched with --strict-mcp-config, leaves the stored sign-in and every other MCP server out of the picture. */
export const agentMcpConfig = (mcpUrl, agentKey) => ({ mcpServers: { enforcer: { type: 'http', url: mcpUrl, headers: { 'X-API-Key': agentKey } } } });
export const mcpConfigPath = (stateDir, key) => join(stateDir, `mcp-${assertIdent(key, 'node key')}.json`);

/** Write `<stateDir>/mcp-<key>.json` at 0600 (created with that mode, never world-readable for a moment); returns its path. */
export function writeAgentMcpConfig(stateDir, key, mcpUrl, agentKey) {
  const p = mcpConfigPath(stateDir, key);
  rmSync(p, { force: true });
  const fd = openSync(p, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(agentMcpConfig(mcpUrl, agentKey)));
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort on platforms without modes */
  }
  return p;
}

/** Remove one config file, or with no key every `mcp-*.json` left in the state dir (dispatcher shutdown). */
export function removeAgentMcpConfigs(stateDir, key = null) {
  if (key) {
    rmSync(mcpConfigPath(stateDir, key), { force: true });
    return;
  }
  let names = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    return;
  }
  for (const n of names) if (/^mcp-.+\.json$/.test(n)) rmSync(join(stateDir, n), { force: true });
}

/** The argv of a worker launch. `session` names (or with `resume`, continues) a claude session. */
export function launchCmd(prompt, model, args, key, { session = null, resume = false, maxTurns = null, mcpConfig = null, harness = null } = {}) {
  harness = harness || args.harness || 'claude';
  if (harness === 'grok') {
    const cmd = [args.grok || process.env.GROK_BIN || 'grok', '-p', prompt, '--output-format', 'streaming-messages-json'];
    if (harnessKnowsModel('grok', model)) cmd.push('--model', model);
    return cmd;
  }
  if (harness === 'codex') {
    // Headless exec cannot answer an MCP approval prompt ("approval policy is never"): approve only the enforcer server's tools, not shell or other servers.
    const url = process.env.ENFORCER_MCP_URL || 'https://api.instruxi.dev/mcp';
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
    cmd.push('-c', `mcp_servers.enforcer={url=${JSON.stringify(url)}, default_tools_approval_mode="approve"}`);
    if (harnessKnowsModel('codex', model)) cmd.push('--model', model);
    return [...cmd, prompt];
  }
  if (harness === 'gemini') {
    // gemini 0.38 headless: -p prompt, -o stream-json (NDJSON, fixture test/fixtures/gemini-stream.jsonl), yolo approves tools.
    const cmd = [args.gemini || process.env.GEMINI_BIN || 'gemini', '-p', prompt, '-o', 'stream-json', '--approval-mode', 'yolo'];
    if (harnessKnowsModel('gemini', model)) cmd.push('-m', model);
    return cmd;
  }
  const cmd = [args.agentBin || process.env.CLAUDE_BIN || 'claude', '-p', prompt, '--agent', AGENT, '--model', model];
  for (const d of pluginDirs(args.pluginDir)) cmd.push('--plugin-dir', d);
  cmd.push('--settings', workerSettings());
  // Only an agent run gets its own connection: the path is in argv, the key is only inside the 0600 file.
  if (args.agent && mcpConfig) cmd.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  if (session) cmd.push(resume ? '--resume' : '--session-id', session);
  if (maxTurns) cmd.push('--max-turns', String(maxTurns));
  cmd.push('--allowedTools', allowedTools().join(','), '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--name', 'graph:' + key);
  if (args.maxBudgetUsd) cmd.push('--max-budget-usd', String(args.maxBudgetUsd));
  if (args.autocompact && args.autocompact !== 'auto') cmd.push('--autocompact', String(args.autocompact));
  return cmd;
}

/** The variable carrying a worker's launch nonce: recorded in pids.json, checked before a reap, and swept for after a kill. */
export const NONCE_ENV = 'ENFORCER_LAUNCH_NONCE';
const hasProc = () => {
  try {
    readFileSync('/proc/self/stat');
    return true;
  } catch {
    return false;
  }
};

/** A process's start time as an opaque string, or null when it cannot be read: field 22 of /proc/<pid>/stat
 *  (clock ticks since boot) where /proc exists, `ps -o lstart=` elsewhere (macOS). A reused pid has a different one. */
export function procStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (hasProc()) {
    try {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' '); // f[0] is field 3 (state), so field 22 is f[19]
      return f[19] ? 'proc:' + f[19] : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const t = (r.stdout || '').trim();
  return r.status === 0 && t ? 'ps:' + t : null;
}

/** The launch nonce in a process's environment: the value, '' when it carries none, null when the environment cannot be read
 *  (/proc/<pid>/environ on Linux, `ps eww` on macOS; nothing elsewhere). */
export function procNonce(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (hasProc()) {
    try {
      const e = readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .find((x) => x.startsWith(NONCE_ENV + '='));
      return e ? e.slice(NONCE_ENV.length + 1) : '';
    } catch {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = new RegExp(`(?:^|\\s)${NONCE_ENV}=([0-9a-f-]+)`).exec(r.stdout || '');
  return m ? m[1] : '';
}

/** '' when `pid` is provably the worker recorded as `rec` ({start, nonce} from pids.json), else why it is not (and must not be killed). */
export function verifyWorker(pid, rec) {
  if (!rec || typeof rec !== 'object' || !rec.start || !rec.nonce) return 'no recorded start time and launch nonce';
  const st = procStartTime(pid);
  if (st === null) return 'its start time cannot be read';
  if (st !== rec.start) return 'its start time differs from the recorded one (the pid was reused)';
  const n = procNonce(pid);
  if (n === null) return 'its environment cannot be read to check the launch nonce';
  if (n !== rec.nonce) return 'its environment does not carry the recorded launch nonce';
  return '';
}

/** Pids whose environment carries this launch nonce (a worker's descendant that left the group with setsid still does).
 *  Needs /proc: null where it is not available (macOS, Windows), which is the documented limit of the sweep. */
export function pidsWithNonce(nonce) {
  if (!nonce || !hasProc()) return nonce ? null : [];
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const needle = `${NONCE_ENV}=${nonce}`;
  const out = [];
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${n}/environ`, 'utf8').split('\0').includes(needle)) out.push(Number(n));
    } catch {
      /* gone, or not ours */
    }
  }
  return out;
}

/** SIGKILL every process carrying the nonce; returns the pids signalled (null when /proc is not available). */
export function killNonce(nonce) {
  const pids = pidsWithNonce(nonce);
  for (const pid of pids || [])
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  return pids;
}

/** A launched process: `detached` (its own session and group, group id = pid), output to a log file.
 *  .exited is null while it runs, then {code, signal}; .done resolves at exit. .nonce is the launch nonce put in its
 *  environment (NONCE_ENV) and .start its start time, both recorded in pids.json so a later reap can prove the pid is ours. */
export function spawnWorker(cmd, { cwd, logPath, env = process.env, cleanup = [], secrets = [] }) {
  const nonce = randomUUID();
  env = { ...env, [NONCE_ENV]: nonce };
  const tidy = () => {
    for (const f of cleanup)
      try {
        rmSync(f, { force: true });
      } catch {
        /* gone */
      }
  };
  const fd = openStream(logPath);
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  const p = { child, pid: child.pid, exited: null, returncode: null, nonce, start: procStartTime(child.pid) };
  p.done = new Promise((res) => {
    child.on('error', (e) => {
      if (!p.exited) {
        tidy();
        p.exited = { code: 127, signal: null, error: e };
        p.returncode = 127;
        res(p.exited);
      }
    });
    child.on('exit', (code, signal) => {
      tidy();
      p.exited = { code, signal };
      redactFile(logPath, secrets);
      p.returncode = code ?? (signal === 'SIGKILL' ? 137 : 143);
      res(p.exited);
    });
  });
  child.unref?.();
  return p;
}
export const alive = (p) => p != null && p.exited === null;

const sig = (pid, n) => {
  try {
    process.kill(-pid, n);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM the worker's process group, wait `grace` ms, then SIGKILL it. Resolves once it has exited (or 10 s after KILL).
 *  Then, where /proc exists, SIGKILL any process still carrying the worker's launch nonce (one that left the group with setsid);
 *  on macOS and Windows such a process survives. */
export async function killGroup(p, grace = 30000, killWait = 10000) {
  if (!alive(p)) return;
  const wait = (ms) =>
    new Promise((r) => {
      const t = setTimeout(() => r('timeout'), ms);
      p.done.then(() => {
        clearTimeout(t);
        r('exit');
      });
    });
  sig(p.pid, 'SIGTERM');
  if ((await wait(grace)) === 'timeout') {
    sig(p.pid, 'SIGKILL');
    await wait(killWait);
  }
  killNonce(p.nonce);
}

/** True when the process exists (kill -0), whether or not it leads a group: a dispatcher started with `&` is not a leader. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** True when pid is alive and a session leader (pgid == pid): how a worker we launched looks; a recycled pid usually is not. */
export function pidAliveGroup(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
