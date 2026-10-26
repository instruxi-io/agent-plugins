// `enforcer dispatch preflight <graph>`: every way a dispatch fails before it spends, as one line each.
// Checks: credential, gh, repos, acceptance, governor-lander, frontier. Exit 2 when any fails.
import { defaultFetch } from '../lib/api/client.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authHeaders, signInProblem } from './credentials.mjs';
import { DEFAULT_WORKER_RULES, workerRulesLine } from './dispatch/launch.mjs';
import { identityCheck, readAgentKey } from './dispatch/agent.mjs';
import { DOT } from '../hooks/claude/paths.mjs';
import { safeIdent, pyRepr, unsafeIdent } from './dispatch/ident.mjs';

const OWN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DISPATCH_TYPES = 'task,bug,chore,merge,scout,milestone,ops'.split(',');
export const DEFAULT_GRAPH_BASE = 'https://api.instruxi.dev/api/v1/graph';
import { resolveConfig } from './config.mjs';

const vkey = (v) =>
  v
    .split(/[.-]/)
    .map((x) => (/^\d+$/.test(x) ? x.padStart(8, '0') : x))
    .join('.');

/** The installed plugin: CLAUDE_PLUGIN_ROOT, else the newest cache entry, else this checkout. */
export function installedRoot(env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT && existsSync(join(env.CLAUDE_PLUGIN_ROOT, 'plugin.json'))) return env.CLAUDE_PLUGIN_ROOT;
  const cache = join(env.CLAUDE_CONFIG_DIR || join(homedir(), DOT), 'plugins', 'cache');
  const found = [];
  try {
    for (const mk of readdirSync(cache))
      for (const name of ['enforcer', 'enforcer-graph']) {
        const d = join(cache, mk, name);
        if (existsSync(d)) for (const v of readdirSync(d)) if (existsSync(join(d, v, 'plugin.json'))) found.push(join(d, v));
      }
  } catch {}
  found.sort((a, b) => (vkey(a) < vkey(b) ? -1 : 1));
  return found.at(-1) || OWN_ROOT;
}

/** Whether Claude Code loads `root` as a plugin: a Grok or Codex runtime copy has plugin.json but no Claude Code manifest dir. */
export const isClaudePlugin = (root) => existsSync(join(root, DOT + '-plugin', 'plugin.json'));

/**
 * The installed Claude Code plugin a dispatch started from a runtime copy hands off to, else null. The
 * `enforcer` shim on PATH (written by `enforcer harness install`) runs ~/.config/enforcer/<harness>/<VERSION>:
 * passed to workers as --plugin-dir, Claude Code names that copy after its directory and every worker dies at
 * once with `--agent 'enforcer:graph-worker' not found` (2026-10-13, again 2026-10-26).
 */
export function handoffRoot(own = OWN_ROOT, env = process.env) {
  if (isClaudePlugin(own)) return null;
  const { CLAUDE_PLUGIN_ROOT: _, ...rest } = env; // a Grok session may point this at the runtime copy itself
  const r = installedRoot(rest);
  return r !== own && r !== OWN_ROOT && isClaudePlugin(r) ? r : null; // OWN_ROOT is installedRoot's nothing-found fallback
}

const pluginVersion = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
};

export async function headers(env) {
  if (env.GRAPH_AUTH_HELPER) {
    const r = spawnSync(env.GRAPH_AUTH_HELPER.replace(/^~/, homedir()), { shell: true, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) return {};
    try {
      return JSON.parse(r.stdout || '{}');
    } catch {
      return {};
    }
  }
  if (env.GRAPH_API_KEY) return { 'X-API-Key': env.GRAPH_API_KEY };
  try {
    return await authHeaders();
  } catch {
    return {};
  }
}

async function get(base, path, h) {
  const r = await defaultFetch(base.replace(/\/$/, '') + path, { headers: h });
  let body = {};
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
}

async function lintPost(base, graph, h, acceptance) {
  const r = await defaultFetch(`${base.replace(/\/$/, '')}/graphs/${graph}/acceptance/lint`, {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ acceptance }),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  return b.warnings || b.data?.warnings || [];
}

/** One line per finding: `<key>: line <i> <code> — <first 60 chars>`; a task/bug/chore with no acceptance is acceptance_missing. */
export async function acceptanceLint(base, graph, h, nodes, types = DISPATCH_TYPES) {
  const found = [];
  for (const n of nodes) {
    if (['done', 'cancelled', 'succeeded'].includes(n.status)) continue;
    if (types !== null && !types.includes(n.type)) continue;
    const a = n.data?.acceptance;
    const lines = (Array.isArray(a) ? a : a ? [a] : []).map(String);
    const key = n.key || n.id;
    if (!lines.length) {
      if (['task', 'bug', 'chore'].includes(n.type)) found.push(`${key}: acceptance_missing — no acceptance lines`);
      continue;
    }
    for (const w of await lintPost(base, graph, h, lines))
      found.push(`${key}: line ${w.index} ${w.code} — ${(w.line ?? lines[w.index] ?? '').replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  return found;
}

const run = (cmd, args, o = {}) => {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, env: o.env, ...o });
  } catch (e) {
    return { status: 1, error: e };
  }
};

export async function allNodes(base, graph, h) {
  const out = [];
  for (let off = 0; ; off += 200) {
    const r = await get(base, `/graphs/${graph}/nodes?limit=200&offset=${off}`, h);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const d = r.body.data || [];
    out.push(...d);
    if (!d.length || off + 200 >= (r.body.meta?.total ?? out.length)) return out;
  }
}

/** Returns [{name, ok, line}] */
export async function preflight(
  {
    graph,
    repoRoot = join(homedir(), 'apps'),
    types = DISPATCH_TYPES,
    env = process.env,
    pluginRoot,
    agent = null,
    workers = 3,
    allowBrowserSignin = false,
    workerRules = DEFAULT_WORKER_RULES,
    workerRoot = OWN_ROOT,
    allowLintWarnings = false,
  } = /** @type {any} */ ({}),
) {
  const res = [];
  const add = (name, ok, line) => res.push({ name, ok, line });
  const base = resolveConfig({ env }).graphUrl;
  const FIX = 'sign in: /enforcer:login';

  // 1 credential
  let h = {},
    authed = false;
  try {
    h = await headers(env);
    if (!Object.keys(h).length) add('credential', false, signInProblem() || FIX);
    else {
      const r = await get(base, `/graphs/${graph}`, h);
      authed = r.status === 200;
      add(
        'credential',
        authed,
        authed
          ? 'ok'
          : r.status === 401 || r.status === 403
            ? `${signInProblem() || FIX} (HTTP ${r.status})`
            : `GET /graphs/${graph} returned HTTP ${r.status}`,
      );
    }
  } catch (e) {
    add('credential', false, `cannot reach ${base}: ${e.message}`);
  }

  // 2 gh
  const gh = run('gh', ['auth', 'status'], { env });
  add('gh', gh.status === 0, gh.status === 0 ? 'ok' : 'gh is not signed in: run `gh auth login`');

  // 4 repos
  let nodes = null;
  if (authed) {
    try {
      nodes = await allNodes(base, graph, h);
    } catch (e) {
      add('repos', false, `cannot list nodes: ${e.message}`);
    }
  } else add('repos', false, 'skipped: no credential, cannot read the plan');
  if (nodes) {
    const repos = new Map();
    const unsafe = [];
    for (const n of nodes) {
      const d = n.data || {};
      const why = unsafeIdent(n);
      if (why) {
        unsafe.push(`node ${n.id || '?'}: ${why}`);
        continue;
      }
      if (d.repo) {
        const s = repos.get(d.repo) || new Set();
        if (d.base) s.add(String(d.base).replace(/^origin\//, ''));
        repos.set(d.repo, s);
      }
    }
    const bad = [...unsafe];
    for (const [repo, bases] of repos) {
      if (!safeIdent(repo)) {
        bad.push(`${pyRepr(repo)} (data.repo does not match ^[A-Za-z0-9._-]+$)`);
        continue;
      }
      const dir = join(repoRoot, repo);
      if (!existsSync(join(dir, '.git'))) {
        bad.push(`${repo} (no checkout at ${dir})`);
        continue;
      }
      for (const b of bases)
        if (run('git', ['ls-remote', '--exit-code', '--heads', 'origin', b], { cwd: dir, env }).status !== 0) bad.push(`${repo} (base ${b} not fetchable)`);
    }
    add(
      'repos',
      !bad.length,
      bad.length ? `missing: ${bad.join(', ')}; clone them under ${repoRoot} or pass --repo-root` : `ok (${repos.size} repo${repos.size === 1 ? '' : 's'})`,
    );
  }

  // 4a acceptance lint: every dispatchable open node's lines through the server's advisory lint
  if (nodes) {
    try {
      const found = await acceptanceLint(base, graph, h, nodes, types);
      if (!found.length) add('acceptance', true, 'ok');
      else if (allowLintWarnings) add('acceptance', true, `warning (--allow-lint-warnings): ${found.join('; ')}`);
      else add('acceptance', false, `${found.join('; ')}; fix the lines or pass --allow-lint-warnings`);
    } catch (e) {
      add('acceptance', false, `cannot lint acceptance: ${e.message}`);
    }
  }

  // 5 governor: the INSTALLED plugin's gate, headless, must allow graph.land for both landers
  const root = pluginRoot || installedRoot(env);
  const ver = pluginVersion(root);
  try {
    let gm;
    for (const rel of ['lib/governor/core/gate.mjs', 'lib/governor/src/gate.mjs', 'core/gate.mjs'])
      if (!gm && existsSync(join(root, rel))) gm = join(root, rel);
    if (!gm) throw new Error('no gate.mjs');
    const { gate } = await import(pathToFileURL(gm).href);
    const cmds = ['enforcer ' + 'land 1', '"${CLAUDE_PLUGIN_ROOT}/bin/' + 'land-pr.sh" 1'];
    const denied = [];
    for (const command of cmds) {
      let v;
      try {
        v = gate(
          {
            tool: 'shell',
            name: 'Bash',
            action: 'Bash:' + command,
            input: { command },
            raw: { command },
            worker: { headless: true, branch: 'graph/preflight', pluginRoot: root },
          },
          {},
          {},
        );
      } catch {
        v = null;
      }
      if (!v || v.action !== 'allow' || (v.ruleId && v.ruleId !== 'graph.land')) denied.push(command);
    }
    add(
      'governor-lander',
      !denied.length,
      denied.length ? `the installed enforcer ${ver} denies the lander (${denied.join(', ')}); update the plugin` : `ok (enforcer ${ver})`,
    );
  } catch (e) {
    add('governor-lander', false, `the installed enforcer ${ver} cannot be evaluated (${e.message}); update the plugin`);
  }

  add('worker-rules', true, workerRulesLine(workerRules));

  // 5a identity workers will use
  {
    const agentKey = agent ? readAgentKey(agent, env) : null;
    const id = identityCheck({ agent, agentKey, nodes: nodes || [], workers, allowBrowserSignin });
    add('identity', id.ok, id.line);
  }

  // 5b the plugin root workers will run: the dispatcher's checkout (--plugin-dir), not the installed release
  if (isClaudePlugin(workerRoot))
    add('worker-plugin', true, `workers run ${workerRoot} (enforcer ${pluginVersion(workerRoot)}); the installed release is disabled for them`);
  else
    add(
      'worker-plugin',
      false,
      `workers would run ${workerRoot}, a runtime copy Claude Code cannot load as enforcer (every worker dies: --agent 'enforcer:graph-worker' not found); install the plugin (claude plugin install enforcer@instruxi) and dispatch again`,
    );

  // 6 frontier: claimable, not claimed
  if (authed) {
    try {
      const r = await get(base, `/graphs/${graph}/frontier`, h);
      const ok =
        r.status === 200 &&
        (r.body.data || []).some((n) => (types === null || types.includes(n.type)) && [undefined, null, 'looking_for_work'].includes(n.work_state));
      add(
        'frontier',
        ok,
        ok
          ? 'ok'
          : r.status !== 200
            ? `GET frontier returned HTTP ${r.status}`
            : `no claimable node of type ${types ? types.join('/') : 'any'} on the frontier`,
      );
    } catch (e) {
      add('frontier', false, e.message);
    }
  } else add('frontier', false, 'skipped: no credential');
  return res;
}

export async function main(args, out = process.stdout) {
  const o = { repoRoot: join(homedir(), 'apps'), types: DISPATCH_TYPES, graph: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo-root') o.repoRoot = args[++i].replace(/^~/, homedir());
    else if (args[i] === '--types') {
      const t = args[++i];
      o.types = t === 'all' ? null : t.split(',');
    } else if (args[i] === '--agent') o.agent = args[++i];
    else if (args[i] === '--allow-lint-warnings') o.allowLintWarnings = true;
    else if (args[i] === '--allow-browser-signin') o.allowBrowserSignin = true;
    else if (args[i] === '--worker-rules') o.workerRules = args[++i];
    else if (args[i] === '--workers') o.workers = Number(args[++i]);
    else if (args[i] === '--graph') o.graph = args[++i];
    else if (args[i] && !args[i].startsWith('-') && !o.graph) o.graph = args[i];
  }
  if (!o.graph) {
    process.stderr.write('usage: enforcer dispatch preflight <graph> [--repo-root dir] [--types t1,t2|all] [--allow-lint-warnings]\n');
    return 2;
  }
  const res = await preflight(o);
  for (const r of res) out.write(`${r.ok ? 'ok  ' : 'fail'}  ${r.name}: ${r.line}\n`);
  return res.every((r) => r.ok) ? 0 : 2;
}
