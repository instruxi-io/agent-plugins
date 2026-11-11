// The Claude Code worker: `claude -p` with this checkout as the plugin, the graph-worker agent, stream-json output,
// and, on a route with an endpoint, ANTHROPIC_BASE_URL and the model aliases (docs/graph/ROUTES.md section 4).
import { closeSync, openSync, writeSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertIdent } from '../ident.mjs';
import { addSecret } from '../logs.mjs';
import { isObj } from '../util.mjs';
import { pluginDirs, routeToken, readStream } from './common.mjs';

export const AGENT = process.env.GRAPH_DISPATCH_AGENT || 'enforcer:graph-worker';
export const GRAPH_TOOLS = ['graph_next_work', 'graph_heartbeat', 'graph_report', 'graph_remember', 'graph_plan_status'];
export const PREFIXES = ['mcp__plugin_enforcer_enforcer__', 'mcp__enforcer__', 'mcp__enforcer-graph__'];
export const BASE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'ToolSearch'];

/** Per-launch settings: the installed release is off for the child, so the --plugin-dir checkout is the only copy of the hooks and MCP server. */
export const DISABLED_PLUGINS = { 'enforcer@instruxi': false };
export const workerSettings = () => JSON.stringify({ enabledPlugins: DISABLED_PLUGINS });

export const allowedTools = () => [...BASE_TOOLS, ...PREFIXES.flatMap((p) => GRAPH_TOOLS.map((t) => p + t))];

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

/** ROUTES.md item 4 for Claude Code: the endpoint variables for `route` set on `out` in place. */
function endpointEnv(out, route, env) {
  const ep = route.endpoint;
  for (const k of ENDPOINT_DROP) delete out[k];
  const token = routeToken(route, env);
  if (token) addSecret(token);
  out.ANTHROPIC_BASE_URL = ep.url;
  // Sent as Authorization: Bearer. A fixed placeholder when the route names no token, so Claude Code never falls back to the operator's login.
  out.ANTHROPIC_AUTH_TOKEN = token || 'none';
  for (const k of ENDPOINT_MODEL_VARS) out[k] = String(route.model);
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // Load the graph MCP tools up front instead of deferring them behind ToolSearch. On a vLLM endpoint the
  // ToolSearch result (tool_reference blocks) is rejected by the model's chat template (400 "Unexpected item type
  // in content", three times per worker), and the retry that follows reprocesses the whole prompt uncached.
  out.ENABLE_TOOL_SEARCH = 'false';
  return out;
}

export function* claudeEvents(path) {
  const text = readStream(path);
  if (text === null) return;
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObj(e)) {
      if (!isObj(e.message)) e.message = {};
      yield e;
    }
  }
}

/** @type {import('./index.mjs').HarnessAdapter} */
export default {
  name: 'claude',
  caps: { supported: true, experimental: false, models: null, resume: true },
  apis: ['anthropic'],

  /** The argv of a worker launch. `session` names (or with `resume`, continues) a claude session. */
  command(prompt, model, args, key, { session = null, resume = false, maxTurns = null, mcpConfig = null, endpoint = false } = {}) {
    const cmd = [args.agentBin || process.env.CLAUDE_BIN || 'claude', '-p', prompt, '--agent', AGENT, '--model', model];
    for (const d of pluginDirs(args.pluginDir)) cmd.push('--plugin-dir', d);
    cmd.push('--settings', workerSettings());
    // Only an agent run gets its own connection: the path is in argv, the key is only inside the 0600 file.
    if (args.agent && mcpConfig) cmd.push('--mcp-config', mcpConfig, '--strict-mcp-config');
    if (session) cmd.push(resume ? '--resume' : '--session-id', session);
    if (maxTurns) cmd.push('--max-turns', String(maxTurns));
    cmd.push(
      '--allowedTools',
      allowedTools().join(','),
      '--permission-prompts',
      'none',
      '--output-format',
      'stream-json',
      '--verbose',
      '--name',
      'graph:' + key,
    );
    // No spend cap on a self-hosted endpoint: its tokens are not a provider bill (ROUTES.md section 2), and with a cap
    // Claude Code adds a "USD budget: $x/$y" system message every turn whose numbers change, which defeats vLLM's prefix
    // cache (measured on the DGX Spark: 0 hits over 435,883 prompt tokens with the cap, ~25k cached per turn without).
    if (args.maxBudgetUsd && !endpoint) cmd.push('--max-budget-usd', String(args.maxBudgetUsd));
    if (args.autocompact && args.autocompact !== 'auto') cmd.push('--autocompact', String(args.autocompact));
    return cmd;
  },

  endpointEnv,

  /** An agent run talks to the API through its own MCP connection (see writeAgentMcpConfig), never the stored sign-in. */
  plan({ state, key, args }) {
    const own = args.agent && args.agentKey && args.mcpUrl;
    return { mcpConfig: own ? mcpConfigPath(state, key) : null };
  },

  prepareWhat: 'write its MCP config',
  prepare(plan, { state, key, args, token }) {
    if (!plan.mcpConfig) return { env: {}, cleanup: [] };
    writeAgentMcpConfig(state, key, args.mcpUrl, token || args.agentKey);
    return { env: {}, cleanup: [plan.mcpConfig] };
  },

  promptRules: () => '',
  sweep: (state) => removeAgentMcpConfigs(state),
  events: claudeEvents,
};
