// `node --test test/dispatch/codex-harness.test.mjs`: the harness adapters (claude unchanged, codex on a route endpoint
// with its own CODEX_HOME), the codex stream, route validation and the codex preflight. No network, no real codex/claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchCmd,
  workerEnv,
  spawnWorker,
  sweepWorkerFiles,
  writeAgentMcpConfig,
  WORKER_STDIO,
  PLUGIN_DIR,
  HARNESS_CAPS,
} from '../../src/dispatch/launch.mjs';
import { adapterFor, runHarnesses, harnessPreflight, ADAPTERS } from '../../src/dispatch/harness/index.mjs';
import codex, {
  codexConfig,
  codexHomePath,
  codexEvents,
  sandboxProbe,
  codexPreflight,
  workerOtel,
  ROUTE_TOKEN_ENV,
  MCP_KEY_ENV,
  SANDBOX_FIX,
} from '../../src/dispatch/harness/codex.mjs';
import { validateRoutes } from '../../src/dispatch/routes.mjs';
import { countTurns } from '../../src/dispatch/stream.mjs';
import { summarize } from '../../src/dispatch/summarize.mjs';
import { routesPreflight } from '../../src/dispatch-command.mjs';

const FIX = fileURLToPath(new URL('../fixtures/codex-exec-route.jsonl', import.meta.url));
const ROUTE_TOKEN = 'sk-spark-route-token-0123456789abcdef';
const AGENT_TOKEN = 'ag_worker0123456789abcdefSECRET';
const INGEST_KEY = 'ik_ingest0123456789abcdefSECRET';
const tmp = () => mkdtempSync(join(tmpdir(), 'enf-codex-'));
const settle = async (p) => {
  const keep = setInterval(() => {}, 50);
  try {
    return await p.done;
  } finally {
    clearInterval(keep);
  }
};
const route = (o = {}) => ({
  tier: 'mechanical',
  route: 'mechanical',
  harness: 'codex',
  model: 'qwen3.8-flash-next',
  endpoint: { url: 'http://127.0.0.1:11434', api: 'openai', token_env: 'SPARK_TOKEN' },
  fallback: 'wait',
  ...o,
});
const deps = (o = {}) => ({
  ensureIngestKey: async () => ({ key: INGEST_KEY }),
  loadConfig: () => ({ ingestUrl: 'https://gov.example' }),
  ...o,
});

// ---- the adapters

test('every harness has an adapter, and HARNESS_CAPS comes from them', () => {
  assert.deepEqual(Object.keys(ADAPTERS), ['claude', 'codex', 'grok', 'gemini']);
  for (const [k, a] of Object.entries(ADAPTERS)) {
    assert.equal(a.name, k);
    assert.equal(HARNESS_CAPS[k], a.caps);
    for (const f of ['command', 'plan', 'promptRules', 'events']) assert.equal(typeof a[f], 'function', `${k}.${f}`);
  }
  assert.equal(HARNESS_CAPS.codex.experimental, true, 'codex stays experimental until the Spark proof');
  assert.throws(() => adapterFor('nope'), /unknown harness nope/);
});

test('claude argv is exactly what it was before the adapters', () => {
  const argv = launchCmd('p', 'sonnet', { agent: 'Bot', agentBin: 'claude', maxBudgetUsd: 5, autocompact: '70' }, 'k1', {
    session: 's1',
    maxTurns: 40,
    mcpConfig: '/state/mcp-k1.json',
  });
  assert.deepEqual(argv, [
    'claude',
    '-p',
    'p',
    '--agent',
    'enforcer:graph-worker',
    '--model',
    'sonnet',
    '--plugin-dir',
    PLUGIN_DIR,
    '--settings',
    '{"enabledPlugins":{"enforcer@instruxi":false}}',
    '--mcp-config',
    '/state/mcp-k1.json',
    '--strict-mcp-config',
    '--session-id',
    's1',
    '--max-turns',
    '40',
    '--allowedTools',
    'Bash,Read,Edit,Write,Grep,Glob,ToolSearch,' +
      ['mcp__plugin_enforcer_enforcer__', 'mcp__enforcer__', 'mcp__enforcer-graph__']
        .flatMap((p) => ['graph_next_work', 'graph_heartbeat', 'graph_report', 'graph_remember', 'graph_plan_status'].map((t) => p + t))
        .join(','),
    '--permission-prompts',
    'none',
    '--output-format',
    'stream-json',
    '--verbose',
    '--name',
    'graph:k1',
    '--max-budget-usd',
    '5',
    '--autocompact',
    '70',
  ]);
  assert.equal(adapterFor('claude').promptRules(), '');
});

test('the claude plan and prepare write the agent MCP config only for an agent run', () => {
  const state = tmp();
  const claude = adapterFor('claude');
  assert.deepEqual(claude.plan({ state, key: 'k', args: {} }), { mcpConfig: null });
  const args = { agent: 'Bot', agentKey: AGENT_TOKEN, mcpUrl: 'http://127.0.0.1:9/mcp' };
  const plan = claude.plan({ state, key: 'k', args });
  assert.equal(plan.mcpConfig, join(state, 'mcp-k.json'));
  const r = claude.prepare(plan, { state, key: 'k', args, token: null });
  assert.deepEqual(r.cleanup, [plan.mcpConfig]);
  assert.equal(JSON.parse(readFileSync(plan.mcpConfig, 'utf8')).mcpServers.enforcer.headers['X-API-Key'], AGENT_TOKEN);
});

// ---- codex without an endpoint: the operator's CODEX_HOME, as before

test('codex without an endpoint writes nothing and names the enforcer server on the command line', async () => {
  const state = tmp();
  const plan = codex.plan({ state, key: 'k', route: { harness: 'codex', model: 'gpt-5', endpoint: null } });
  assert.deepEqual(plan, { codexHome: null });
  assert.deepEqual(await codex.prepare(plan, { key: 'k', args: {}, route: null }), { env: {}, cleanup: [] });
  const argv = launchCmd('p', 'gpt-5', { harness: 'codex', mcpUrl: 'https://api.example/mcp' }, 'k', plan);
  const mcp = argv[argv.findIndex((a) => a.startsWith('mcp_servers.enforcer='))];
  assert.equal(
    mcp,
    `mcp_servers.enforcer={url="https://api.example/mcp", default_tools_approval_mode="approve", env_http_headers={"X-API-Key"="${MCP_KEY_ENV}"}}`,
  );
  assert.ok(argv.includes('--model') && argv.at(-1) === 'p');
  assert.equal(workerEnv('g', { PATH: '/bin' }, { harness: 'codex' }).CODEX_HOME, undefined);
});

// ---- codex on a route endpoint

test('codex on an endpoint: config.toml with the provider, the MCP server by env var, telemetry, and AGENTS.md', async () => {
  const state = tmp();
  const r = route();
  const plan = codex.plan({ state, key: 'node-a', route: r });
  assert.equal(plan.codexHome, join(state, 'codex-node-a'));
  const out = await codex.prepare(plan, { key: 'node-a', args: { mcpUrl: 'https://api.example/mcp' }, route: r, token: AGENT_TOKEN, deps: deps() });
  assert.deepEqual(out.env, { CODEX_HOME: plan.codexHome });
  assert.deepEqual(out.cleanup, [plan.codexHome]);
  assert.deepEqual(out.notes, []);
  const cfg = join(plan.codexHome, 'config.toml');
  if (process.platform !== 'win32') {
    assert.equal(statSync(plan.codexHome).mode & 0o777, 0o700);
    assert.equal(statSync(cfg).mode & 0o777, 0o600);
    assert.equal(statSync(join(plan.codexHome, 'AGENTS.md')).mode & 0o777, 0o600);
  }
  const text = readFileSync(cfg, 'utf8');
  const head = text.slice(0, text.indexOf('[otel]'));
  assert.equal(
    head,
    [
      '# Written by the enforcer dispatcher for worker node-a; removed when it exits. Do not edit.',
      'model = "qwen3.8-flash-next"',
      'model_provider = "route"',
      'model_reasoning_effort = "medium"',
      'check_for_update_on_startup = false',
      'cli_auth_credentials_store = "file"',
      'mcp_oauth_credentials_store = "file"',
      '',
      '[model_providers.route]',
      'name = "route mechanical"',
      'base_url = "http://127.0.0.1:11434/v1"',
      `env_key = "${ROUTE_TOKEN_ENV}"`,
      'wire_api = "responses"',
      '',
      '[mcp_servers.enforcer]',
      'url = "https://api.example/mcp"',
      `env_http_headers = { "X-API-Key" = "${MCP_KEY_ENV}" }`,
      'default_tools_approval_mode = "approve"',
      '',
      '[analytics]',
      'enabled = false',
      '',
      '',
    ].join('\n'),
  );
  // the otel block is the telemetry adapter's own: full signal paths, binary protocol, literal header, no traces, no prompt text
  assert.match(text, /\[otel\]\n# BEGIN Enforcer telemetry/);
  assert.ok(text.includes('endpoint = "https://gov.example/api/v1/governance/otlp/v1/logs", protocol = "binary"'));
  assert.ok(text.includes('endpoint = "https://gov.example/api/v1/governance/otlp/v1/metrics"'));
  assert.ok(text.includes(`"X-API-Key" = "${INGEST_KEY}"`));
  assert.ok(text.includes('trace_exporter = "none"') && text.includes('log_user_prompt = false') && text.includes('log_agent_responses = false'));
  // neither the route token nor the agent credential is in the file: Codex reads both from the environment by name
  assert.ok(!text.includes(ROUTE_TOKEN) && !text.includes(AGENT_TOKEN));
  const agents = readFileSync(join(plan.codexHome, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Enforcer graph worker \(Codex\)/);
  assert.match(agents, /You are a graph worker/);
  assert.ok(!agents.includes('\nname: graph-worker'), 'frontmatter stripped');
});

test('codex endpoint argv: workspace-write, no MCP override, the route model, never danger-full-access, no secret', () => {
  const r = route();
  const argv = launchCmd('do it', r.model, { harness: 'codex' }, 'k', { codexHome: '/s/codex-k', endpoint: true });
  assert.deepEqual(argv, [
    'codex',
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '--model',
    'qwen3.8-flash-next',
    'do it',
  ]);
  for (const bad of ['danger-full-access', '--dangerously-bypass-approvals-and-sandbox', ROUTE_TOKEN, AGENT_TOKEN])
    assert.ok(!argv.join(' ').includes(bad), bad);
});

test('codex endpoint environment: the route token by name, the worker credential for the MCP header, no operator OpenAI setup', () => {
  const env = { PATH: '/bin', HOME: '/h', SPARK_TOKEN: ROUTE_TOKEN, OPENAI_API_KEY: 'sk-operator', OPENAI_BASE_URL: 'https://x', CODEX_HOME: '/h/.codex' };
  const e = workerEnv('g', env, { harness: 'codex', route: route(), token: AGENT_TOKEN });
  assert.equal(e[ROUTE_TOKEN_ENV], ROUTE_TOKEN);
  assert.equal(e[MCP_KEY_ENV], AGENT_TOKEN);
  assert.equal(e.OPENAI_API_KEY, 'none');
  assert.equal(e.OPENAI_BASE_URL, undefined);
  assert.equal(e.CODEX_HOME, undefined, 'set from the plan, never inherited');
  assert.equal(e.ANTHROPIC_BASE_URL, undefined);
  // no token_env: a placeholder, never the operator's login
  const none = workerEnv('g', env, { harness: 'codex', route: route({ endpoint: { url: 'http://127.0.0.1:11434', api: 'openai' } }) });
  assert.equal(none[ROUTE_TOKEN_ENV], 'none');
});

test('telemetry: absent, with one note, when no key can be had or the operator turned it off; never a failed worker', async () => {
  const state = tmp();
  const r = route();
  const plan = codex.plan({ state, key: 'k2', route: r });
  const signedOut = deps({
    ensureIngestKey: async () => {
      throw new Error('This machine is not signed in to Enforcer');
    },
  });
  const out = await codex.prepare(plan, { key: 'k2', args: {}, route: r, deps: signedOut });
  assert.deepEqual(out.notes, ['codex workers run without telemetry: no ingest key: This machine is not signed in to Enforcer']);
  const text = readFileSync(join(plan.codexHome, 'config.toml'), 'utf8');
  assert.ok(!text.includes('[otel]'));
  assert.match(text, /\[mcp_servers\.enforcer\]/);
  let asked = false;
  const off = await workerOtel({
    loadConfig: () => ({ codexTelemetry: false }),
    ensureIngestKey: async () => {
      asked = true;
      return { key: INGEST_KEY };
    },
  });
  assert.deepEqual([off.otel, asked], [null, false]);
  assert.match(off.why, /codexTelemetry is off/);
  const slow = await workerOtel({ loadConfig: () => ({}), ensureIngestKey: () => new Promise(() => {}), timeoutMs: 20 });
  assert.match(slow.why, /no ingest key within/);
});

test('the CODEX_HOME is removed when the worker exits, and swept at dispatcher start', async () => {
  const state = tmp();
  const r = route();
  const plan = codex.plan({ state, key: 'k3', route: r });
  const out = await codex.prepare(plan, { key: 'k3', args: {}, route: r, deps: deps() });
  const p = spawnWorker([process.execPath, '-e', 'process.exit(0)'], { cwd: state, logPath: join(state, 'k3.jsonl'), env: process.env, cleanup: out.cleanup });
  await settle(p);
  assert.ok(!existsSync(plan.codexHome));
  // left behind by a SIGKILLed dispatcher: swept with the mcp configs, nothing else touched
  mkdirSync(codexHomePath(state, 'old'), { mode: 0o700 });
  writeFileSync(join(codexHomePath(state, 'old'), 'config.toml'), 'x');
  writeAgentMcpConfig(state, 'old', 'http://127.0.0.1:9/mcp', AGENT_TOKEN);
  writeFileSync(join(state, 'pids.json'), '{}');
  sweepWorkerFiles(state);
  assert.ok(!existsSync(codexHomePath(state, 'old')) && !existsSync(join(state, 'mcp-old.json')));
  assert.ok(existsSync(join(state, 'pids.json')));
});

test('workers get stdin closed: a child reading stdin sees EOF at once (codex exec would block otherwise)', async () => {
  assert.equal(WORKER_STDIO(3)[0], 'ignore');
  const state = tmp();
  const logPath = join(state, 'stdin.jsonl');
  const reader = "let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>{console.log('eof '+n);process.exit(0)})";
  const p = spawnWorker([process.execPath, '-e', reader], { cwd: state, logPath, env: process.env });
  const t = setTimeout(() => process.kill(-p.pid, 'SIGKILL'), 5000);
  await settle(p);
  clearTimeout(t);
  assert.equal(readFileSync(logPath, 'utf8').trim(), 'eof 0');
});

// ---- the stream

test('codex route stream: turns, MCP graph calls, usage with cached and reasoning tokens, result', () => {
  // agent_message + 2 command_execution + 1 mcp_tool_call
  assert.equal(countTurns(FIX, 'codex'), 4);
  const s = summarize(FIX, 'codex');
  assert.equal(s.result, 'success');
  assert.equal(s.turns, 4);
  assert.equal(s.session_id, '019a7c2e-4b1d-7f20-9a3e-5c2d8e1f0a11');
  assert.deepEqual(s.usage, { input_tokens: 18342, output_tokens: 214, cache_read_input_tokens: 12288, reasoning_output_tokens: 96 });
  assert.equal(s.reported, true, 'an mcp graph_report counts as reported');
  assert.equal(s.report_status, 'succeeded');
  assert.match(s.result_text, /^Created hello\.txt/);
  const evs = [...codexEvents(FIX)];
  const denied = evs.flatMap((e) => e.message.content || []).find((c) => c.type === 'tool_result' && c.is_error);
  assert.match(denied.content, /Read-only file system/);
});

test('codex turn.failed is an error result carrying the message', () => {
  const dir = tmp();
  const p = join(dir, 'failed.jsonl');
  writeFileSync(
    p,
    [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"stream disconnected before completion"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 400 Bad Request"}}',
    ].join('\n'),
  );
  const s = summarize(p, 'codex');
  assert.equal(s.result, 'error_turn_failed');
  assert.equal(s.is_error, true);
  assert.equal(s.result_text, 'unexpected status 400 Bad Request');
});

// ---- routes

test('route validation: codex speaks openai on an endpoint, never anthropic', () => {
  const env = { SPARK_TOKEN: ROUTE_TOKEN };
  const v = (r) => validateRoutes({ version: 1, routes: { mechanical: r } }, 'f.json', { env, experimental: true });
  const ok = v({ harness: 'codex', model: 'qwen3.8-flash-next', endpoint: { url: 'http://127.0.0.1:11434', api: 'openai', token_env: 'SPARK_TOKEN' } });
  assert.deepEqual(ok.routes.mechanical.endpoint, { url: 'http://127.0.0.1:11434', api: 'openai', token_env: 'SPARK_TOKEN' });
  assert.throws(
    () => v({ harness: 'codex', model: 'qwen', endpoint: { url: 'http://127.0.0.1:11434', api: 'anthropic' } }),
    /routes\.mechanical\.endpoint\.api: codex cannot speak anthropic/,
  );
});

// ---- preflight

// a Linux host with /usr/bin/bwrap, whatever host runs the test (the macOS runner has no bwrap)
const sys = (o = {}) => ({
  platform: 'linux',
  env: { PATH: '/nonexistent' },
  exists: (p) => p === '/usr/bin/bwrap',
  readFile: () => '1\n',
  run: (bin, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.164.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  },
  ...o,
});
const bwrapFails = (bin, args) =>
  args[0] === '--version'
    ? { status: 0, stdout: 'codex-cli 0.164.0\n' }
    : { status: 1, stdout: '', stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' };

test('sandbox probe: bwrap unsharing user+net passes; the RTM_NEWADDR failure fails naming the AppArmor fix', () => {
  // the probe runs bwrap itself (never codex) with a new user and network namespace
  let ran = null;
  const ok = sandboxProbe(
    sys({
      run: (bin, args) => {
        ran = [bin, ...args];
        return { status: 0 };
      },
    }),
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ran, ['/usr/bin/bwrap', '--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true']);
  const bad = sandboxProbe(sys({ run: bwrapFails }));
  assert.equal(bad.ok, false);
  assert.match(bad.line, /Failed RTM_NEWADDR: Operation not permitted/);
  assert.ok(bad.line.includes(SANDBOX_FIX));
  assert.match(bad.line, /apparmor_parser -r/);
  assert.match(bad.line, /Never run codex workers with danger-full-access/);
  assert.equal(sandboxProbe(sys({ platform: 'darwin' })).ok, true);
});

test('sandbox probe without any bwrap: fails only where user namespaces are restricted', () => {
  const none = () => false;
  assert.equal(sandboxProbe(sys({ exists: none, readFile: () => '1' })).ok, false);
  assert.equal(sandboxProbe(sys({ exists: none, readFile: () => '0' })).ok, true);
});

test('codex preflight: the binary and its version, then the sandbox', () => {
  const lines = codexPreflight({ codex: '/opt/codex' }, sys());
  assert.deepEqual(
    lines.map((l) => [l.name, l.ok]),
    [
      ['codex', true],
      ['codex-sandbox', true],
    ],
  );
  assert.equal(lines[0].line, '/opt/codex: codex-cli 0.164.0');
  const missing = codexPreflight({}, sys({ run: () => ({ status: null, error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) }) }));
  assert.equal(missing[0].ok, false);
  assert.match(missing[0].line, /not runnable: ENOENT/);
});

test('the run harnesses: --harness, route harnesses and route:<harness> fallbacks; checks only for codex', () => {
  const t = { routes: { mechanical: { harness: 'codex', fallback: 'route:gemini' }, deep: { fallback: 'wait' } } };
  assert.deepEqual(runHarnesses(t, 'claude').sort(), ['claude', 'codex', 'gemini']);
  assert.deepEqual(runHarnesses(null, 'claude'), ['claude']);
  assert.deepEqual(harnessPreflight(['claude', 'grok'], {}, sys()), []);
  assert.equal(harnessPreflight(['codex'], {}, sys()).length, 2);
});

test('enforcer dispatch: a codex route on a host whose sandbox cannot start fails preflight, nothing started', async () => {
  const dir = tmp();
  const file = join(dir, 'routes.json');
  // no endpoint, so no probe: the harness checks are what is under test
  writeFileSync(file, JSON.stringify({ version: 1, routes: { mechanical: { harness: 'codex' } } }));
  const out = [];
  const err = process.stderr.write;
  process.stderr.write = () => true;
  let rc;
  try {
    rc = await routesPreflight(
      ['g1', '--routes', file, '--experimental'],
      'g1',
      { PATH: '/bin' },
      {
        out: (s) => out.push(s),
        harnessSys: sys({ run: bwrapFails }),
      },
    );
  } finally {
    process.stderr.write = err;
  }
  const text = out.join('');
  assert.match(text, /ok {4}codex: codex: codex-cli 0\.164\.0/);
  if (existsSync('/usr/bin/bwrap')) {
    assert.equal(rc, 2);
    assert.match(text, /fail {2}codex-sandbox: .*Failed RTM_NEWADDR/);
  }
});

test('codex landing targets the repo default branch, not a literal main (enforcer-smoke is master)', async () => {
  const { codexLandBase } = await import('../../src/dispatch/run.mjs');
  assert.equal(
    codexLandBase({ data: {} }, '/r', 'enforcer-smoke', () => 'origin/master'),
    'master',
  );
  assert.equal(
    codexLandBase({ data: { base: 'origin/staging' } }, '/r', 'x', () => 'origin/master'),
    'staging',
  );
  assert.equal(
    codexLandBase({ data: { base: 'dev' } }, '/r', 'x', () => 'origin/master'),
    'dev',
  );
  assert.equal(
    codexLandBase({ data: {} }, '/r', 'x', () => null),
    'main',
  );
  assert.equal(
    codexLandBase({ data: {} }, '/r', 'x', () => {
      throw new Error('no git');
    }),
    'main',
  );
});
