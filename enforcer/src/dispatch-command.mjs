// `enforcer dispatch <graph>|status|stop|--help`: the plain front door to the Node dispatcher (src/dispatch/run.mjs).
// Outcome words: done, needs you, landing blocked, blocked on CI, over budget. Never "failed" for merged work.
import { spawn } from 'node:child_process';
import { existsSync, chmodSync, readdirSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { headers, allNodes, preflight } from './preflight.mjs';
import { resolveConfig } from './config.mjs';
import { TIER_MODEL } from './dispatch/model.mjs';
import { strandedReport, strandedLines, workerLogMtime } from './dispatch/stranded.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// no model: without --model each node runs on its tier's model (TIER_MODEL) or its route's, never a forced sonnet
export const DEFAULTS = { workers: 3, salvage: 'on', triage: 'on', warm: 'off' };
export const HELP = `usage: enforcer dispatch <graph> [--workers N] [--model M] [--repo-root dir] [--worker-rules on|off] [--context on|off] [--allow-lint-warnings]   preflight, then start the dispatcher in the background
       enforcer dispatch status [<graph>]                                              what it is doing and what it needs from you
       enforcer dispatch prune [--yes] [--repo-root dir]                               list (or with --yes remove) worktrees whose PR merged and no live worker holds
       enforcer dispatch stop <graph>                                                  finish running workers, start no new ones, then exit
defaults: ${DEFAULTS.workers} workers, no model cap (each tier's model, or its route's), routes from --routes / ENFORCER_ROUTES / the graph / routes.json, salvage ${DEFAULTS.salvage}, triage ${DEFAULTS.triage}, warm workers ${DEFAULTS.warm}
state: ~/.config/enforcer/dispatch/<graph> (dispatcher.log, pids.json, STOP)
       enforcer dispatch --dry-run <graph>                                             print the planned launches; launch nothing
other dispatcher flags pass through; see docs/graph/DISPATCHER.md
`;

// Flags that take a value, so the value is never mistaken for the graph id.
// --agent is not handled here but passes through to the runner.
const VALUE_FLAGS = ['--workers', '--model', '--repo-root', '--worker-rules', '--context', '--agent', '--routes', '--route-probe-ttl'];

const flagValue = (argv, n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** The graph id: the first bare argument that is not a flag's value. */
export const graphArg = (argv) => argv.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(argv[i - 1]));

/**
 * What preflight must judge with the same flags the runner will get: the
 * identity check depends on --agent, --allow-browser-signin and --workers, and
 * judging without them refused every long plan whatever was passed.
 */
export function preflightOptions(argv) {
  const o = {};
  const workerRules = flagValue(argv, '--worker-rules');
  const repoRoot = flagValue(argv, '--repo-root');
  const agent = flagValue(argv, '--agent');
  const workers = Number(flagValue(argv, '--workers'));
  if (workerRules) o.workerRules = workerRules;
  if (repoRoot) o.repoRoot = repoRoot;
  if (agent) o.agent = agent;
  if (argv.includes('--allow-browser-signin')) o.allowBrowserSignin = true;
  if (argv.includes('--allow-lint-warnings')) o.allowLintWarnings = true;
  o.workers = Number.isInteger(workers) && workers > 0 ? workers : DEFAULTS.workers;
  return o;
}

export const stateDir = (graph, env = process.env) => join(env.ENFORCER_CONFIG_HOME || join(homedir(), '.config', 'enforcer'), 'dispatch', graph);
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const tailLine = (p) => {
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).at(-1) || '';
  } catch {
    return '';
  }
};

export async function start(argv, env = process.env) {
  const graph = graphArg(argv);
  const flag = (n) => flagValue(argv, n);
  const repoRoot = flag('--repo-root');
  const workerRules = flag('--worker-rules');
  if (workerRules !== undefined && !['on', 'off'].includes(workerRules)) {
    process.stderr.write('enforcer dispatch: --worker-rules must be on or off\n');
    return 2;
  }
  const context = flag('--context');
  if (context !== undefined && !['on', 'off'].includes(context)) {
    process.stderr.write('enforcer dispatch: --context must be on or off\n');
    return 2;
  }
  if (process.platform === 'win32') {
    process.stderr.write('enforcer dispatch: not supported on Windows (workers need process groups and POSIX signals); use WSL\n');
    return 2;
  }
  if (argv.includes('--dry-run')) {
    // plan only: nothing is claimed, created, launched or written
    const { main: runtime } = await import('./dispatch/run.mjs');
    return runtime(['--graph', graph, ...argv.filter((a) => a !== graph)], env);
  }
  const res = await preflight({ graph, env, ...preflightOptions(argv) });
  for (const r of res) process.stdout.write(`${r.ok ? 'ok  ' : 'fail'}  ${r.name}: ${r.line}\n`);
  if (res.some((r) => !r.ok)) {
    process.stderr.write('enforcer dispatch: preflight failed, nothing started\n');
    return 2;
  }
  const rrc = await routesPreflight(argv, graph, env);
  if (rrc) return rrc;
  const dir = stateDir(graph, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const old = readJson(join(dir, 'pids.json'));
  if (old?.dispatcher && alive(old.dispatcher)) {
    process.stderr.write(`enforcer dispatch: already running for ${graph} (pid ${old.dispatcher}); see: enforcer dispatch status ${graph}\n`);
    return 3;
  }
  const extra = argv.filter(
    (a, i) =>
      a !== graph &&
      !['--workers', '--model', '--repo-root', '--worker-rules', '--context'].includes(a) &&
      !['--workers', '--model', '--repo-root', '--worker-rules', '--context'].includes(argv[i - 1]),
  );
  const args = [
    join(HERE, '../bin/enforcer'),
    'dispatch',
    'run',
    '--graph',
    graph,
    '--workers',
    String(flag('--workers') || DEFAULTS.workers),
    // --model only when it was given: a forced default would cap every tier and route model to it
    ...(flag('--model') ? ['--model', flag('--model')] : []),
    '--state-dir',
    dir,
    ...(workerRules ? ['--worker-rules', workerRules] : []),
    ...(context ? ['--context', context] : []),
    ...(repoRoot ? ['--repo-root', repoRoot] : []),
    ...extra,
  ];
  const out = openSync(join(dir, 'dispatcher.out'), 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  writeFileSync(join(dir, 'dispatcher.pid'), String(child.pid));
  process.stdout.write(`dispatching ${graph}: pid ${child.pid}. See what it is doing: enforcer dispatch status ${graph}\n`);
  return 0;
}

/** The route table the runner will use, printed after preflight: a table that cannot be used stops here (exit 5). */
export async function routesPreflight(argv, graph, env = process.env, { api = null, out = (s) => process.stdout.write(s) } = {}) {
  const { loadRoutes, routeLines, ProbeCache, RouteError } = await import('./dispatch/routes.mjs');
  const file = flagValue(argv, '--routes') || null;
  const noRoutes = argv.includes('--no-routes');
  const ttl = Number(flagValue(argv, '--route-probe-ttl') ?? 60);
  const args = { harness: flagValue(argv, '--harness') || 'claude', model: flagValue(argv, '--model') || null, experimental: argv.includes('--experimental') };
  let graphRoutes;
  let nodes = [];
  if (!noRoutes && !file && !env.ENFORCER_ROUTES) {
    try {
      if (!api) {
        const { API } = await import('./dispatch/api.mjs');
        api = new API(resolveConfig({ env }).graphUrl, { headers: () => headers(env) });
      }
      graphRoutes = ((await api.graph(graph)) || {}).node_defaults?.routes;
    } catch {
      /* unreadable graph defaults: the next source decides, as the runner does */
    }
  }
  try {
    const loaded = loadRoutes({ file, noRoutes, graphRoutes, env, ...args });
    if (loaded.table && api?.nodes) nodes = await api.nodes(graph).catch(() => []);
    const probes = loaded.table ? new ProbeCache({ ttl: Number.isFinite(ttl) ? ttl : 60, env }) : null;
    for (const l of await routeLines(loaded, args, { probes, nodes })) out(`${l}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof RouteError)) throw e;
    out(`fail  routes: ${e.message}\n`);
    process.stderr.write('enforcer dispatch: the route table cannot be used, nothing started\n');
    return e.exitCode;
  }
}

/** A running worker's model, and with a route its harness, endpoint and tier, from its pids.json meta. */
export function workerRouteText(meta, n) {
  const tier = String(n.data?.tier || '').toLowerCase();
  const model = meta?.model || (Object.hasOwn(TIER_MODEL, tier) ? TIER_MODEL[tier] : 'sonnet');
  if (!meta?.route && !meta?.fallback_from) return model;
  const at = meta.endpoint ? ` @${String(meta.endpoint).replace(/^https?:\/\//, '')}` : '';
  const via = meta.fallback_from ? `${meta.fallback_from}->fallback:${meta.route || meta.harness}, endpoint down` : meta.route;
  return `${meta.harness || 'claude'} ${model}${at} (${via})`;
}

const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16) + 'Z';

/** One line per endpoint the dispatcher has probed: up, or down since when and why, with the nodes it holds. */
export function endpointLines(endpoints) {
  const L = [];
  for (const [url, e] of Object.entries(endpoints || {})) {
    const held = e.holding?.length ? `; holding ${e.holding.length} node${e.holding.length === 1 ? '' : 's'}: ${e.holding.join(', ')}` : '';
    L.push(e.up ? `endpoint ${url} up` : `endpoint ${url} DOWN since ${hhmm(e.since)} (${e.reason})${held}`);
  }
  return L;
}

/** Failed criteria of a review item, from verdict/verification {threshold, failed:[{criterion|line|text|index, probability}]}. */
export function failedLines(n) {
  const v = n.verdict || n.verification || {};
  const failed = Array.isArray(v.failed) ? v.failed : [];
  const out = [];
  if (failed.length && v.threshold != null) out.push(`    threshold ${v.threshold}`);
  for (const f of failed) {
    if (typeof f !== 'object' || f === null) {
      out.push(`    failed: ${f}`);
      continue;
    }
    const p = f.probability ?? f.p ?? f.confidence;
    const what = f.criterion ?? f.line ?? f.text ?? (f.index != null ? `criterion ${f.index}` : '?');
    out.push(`    failed: ${what}${p != null ? ` (probability ${p})` : ''}`);
  }
  return out;
}

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

/** Plain-language status. Returns the text. */
export async function statusText(graph, env = process.env) {
  const dir = stateDir(graph, env);
  const base = resolveConfig({ env }).graphUrl;
  const nodes = await allNodes(base, graph, await headers(env));
  const log = existsSync(join(dir, 'dispatcher.log')) ? readFileSync(join(dir, 'dispatcher.log'), 'utf8').split('\n').filter(Boolean) : [];
  const pids = readJson(join(dir, 'pids.json'));
  const running = pids?.dispatcher && alive(pids.dispatcher);
  const blockedKeys = new Set();
  const ci = [];
  for (const l of log) {
    const m = /LANDING-BLOCKED\s+(\S+?)[: ]/.exec(l);
    if (m) blockedKeys.add(m[1]);
    if (/CI-UNAVAILABLE/.test(l)) ci.push(l);
  }
  const done = nodes.filter((n) => n.status === 'done');
  const open = nodes.filter((n) => !['done', 'cancelled'].includes(n.status));
  const strandedRep = strandedReport(open, { dispatcherRunning: Boolean(running), logMtime: (k) => workerLogMtime(join(dir, 'logs'), k) });
  const strandedKeys = new Set(strandedRep.stranded.map((s) => s.key));
  // a lapsed node is listed as stranded below, never as a worker: its timer counts from the claim, not from a heartbeat
  const workers = open.filter((n) => n.status === 'running' && !strandedKeys.has(n.key));
  const landing = open.filter((n) => blockedKeys.has(n.key));
  const gates = open.filter((n) => ['gate', 'release'].includes(n.type));
  const review = open.filter((n) => n.status === 'verifying' || ['rejected', 'escalated'].includes(n.verdict?.state || n.verification?.state));
  const needsYou = open.filter((n) => gates.includes(n) || review.includes(n) || n.status === 'failed');
  const mins = (n) => {
    const t = Date.parse(n.updated_at || n.started_at || '');
    return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : '?';
  };
  const model = (n) => workerRouteText(pids?.meta?.[n.key], n);
  const L = [];
  L.push(`dispatcher: ${running ? `running (pid ${pids.dispatcher})` : 'not running'}${ci.length && running ? '; blocked on CI' : ''}`);
  const sl = strandedLines(strandedRep, graph, { dispatcherRunning: Boolean(running) });
  for (const l of sl.lines) L.push(l);
  L.push(`workers (${workers.length}):`);
  for (const n of workers) L.push(`  ${n.key}  ${mins(n)} min  ${model(n)}`);
  if (!workers.length) L.push('  none running');
  if (running) for (const l of endpointLines(pids?.endpoints)) L.push(l);
  L.push(`nodes: ${done.length} done, ${open.length} open, ${landing.length} landing blocked, ${needsYou.length} needs you`);
  L.push(`needs you: ${needsYou.length}`);
  for (const n of landing) L.push(`  landing blocked: ${n.key}`);
  L.push(`review items (${review.length}):`);
  for (const n of review) {
    L.push(`  ${n.key}: a person must resolve the verdict`);
    for (const l of failedLines(n)) L.push(l);
  }
  if (!review.length) L.push('  none');
  // Every item a person must answer carries the command that answers it, ready to paste after `!`.
  else L.push(`  answer: ! graphwatch inbox ${graph}  (item ids), then ! graphwatch resolve ${graph} <item> approve|reject|override --note "<why>"`);
  L.push(`gates open (${gates.length}):`);
  for (const n of gates) {
    L.push(`  ${n.key}: ${n.title || ''}`);
    const options = Array.isArray(n.data?.options) && n.data.options.length ? n.data.options.join('|') : 'approve|reject';
    L.push(`    answer: ! graphwatch decide ${graph} ${n.key} ${options} --note "<why>"`);
  }
  if (!gates.length) L.push('  none');
  L.push(`last line: ${last(log) || '(dispatcher has not written anything yet)'}`);
  return L.join('\n') + '\n';
}

export async function stop(graph, env = process.env, waitMs = 600000) {
  const dir = stateDir(graph, env);
  const pids = readJson(join(dir, 'pids.json'));
  if (!pids?.dispatcher || !alive(pids.dispatcher)) {
    process.stdout.write(`no dispatcher is running for ${graph}\n`);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'STOP'), '');
  process.stdout.write(`stop requested for ${graph}: running workers finish, no new ones start\n`);
  const end = Date.now() + waitMs;
  while (alive(pids.dispatcher) && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
  if (alive(pids.dispatcher)) {
    process.stdout.write(`still draining (pid ${pids.dispatcher}); check: enforcer dispatch status ${graph}\n`);
    return 1;
  }
  process.stdout.write('dispatcher stopped\n');
  rmSync(join(dir, 'STOP'), { force: true });
  return 0;
}

export async function main(argv, env = process.env) {
  const [sub, ...rest] = argv;
  if (sub === undefined) {
    process.stdout.write(HELP);
    return 2;
  }
  if (sub === '--help' || sub === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (sub === 'status') {
      const graph = rest[0];
      if (!graph) {
        let names = [];
        try {
          names = readdirSync(dirname(stateDir('x', env))).filter((d) => alive(readJson(join(dirname(stateDir('x', env)), d, 'pids.json'))?.dispatcher || 0));
        } catch {}
        process.stdout.write(
          names.length
            ? names.map((d) => `running: ${d}   (enforcer dispatch status ${d})\n`).join('')
            : 'no dispatcher is running; start one with: enforcer dispatch <graph>\n',
        );
        return 0;
      }
      process.stdout.write(await statusText(graph, env));
      return 0;
    }
    if (sub === 'stop') {
      if (!rest[0]) {
        process.stderr.write('usage: enforcer dispatch stop <graph>\n');
        return 2;
      }
      return await stop(rest[0], env);
    }
    if (sub === 'prune') {
      const i = rest.indexOf('--repo-root');
      if (rest.includes('--help') || rest.includes('-h')) {
        process.stdout.write(
          'usage: enforcer dispatch prune [--yes] [--repo-root dir]\n  without --yes: dry run, print what would be removed; --yes removes merged, clean, unheld worktrees and their local branches\n',
        );
        return 0;
      }
      const repoRoot = i >= 0 ? rest[i + 1] : join(homedir(), 'apps');
      const { pruneWorktrees, liveWorkerKeys } = await import('./dispatch/prune.mjs');
      const liveKeys = liveWorkerKeys(dirname(stateDir('x', env)));
      pruneWorktrees(repoRoot, { yes: rest.includes('--yes'), liveKeys });
      return 0;
    }
    if (sub === 'run') return await (await import('./dispatch/run.mjs')).main(rest, env); // the foreground dispatcher `start` detaches
    return await start(argv, env);
  } catch (e) {
    process.stderr.write(`enforcer dispatch: ${e.message}\n`);
    return 2;
  }
}
