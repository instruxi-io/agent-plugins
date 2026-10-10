// `enforcer dispatch <graph>|status|stop|--help`: the plain front door to the Node dispatcher (src/dispatch/run.mjs).
// Outcome words: done, needs you, landing blocked, blocked on CI, over budget. Never "failed" for merged work.
import { spawn } from 'node:child_process';
import { existsSync, chmodSync, readdirSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { headers, allNodes, preflight } from './preflight.mjs';
import { resolveConfig } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { workers: 3, model: 'sonnet', salvage: 'on', triage: 'on', warm: 'off' };
export const HELP = `usage: enforcer dispatch <graph> [--workers N] [--model M] [--repo-root dir] [--worker-rules on|off] [--context on|off]   preflight, then start the dispatcher in the background
       enforcer dispatch status [<graph>]                                              what it is doing and what it needs from you
       enforcer dispatch prune [--yes] [--repo-root dir]                               list (or with --yes remove) worktrees whose PR merged and no live worker holds
       enforcer dispatch stop <graph>                                                  finish running workers, start no new ones, then exit
defaults: ${DEFAULTS.workers} workers, ${DEFAULTS.model} model cap, salvage ${DEFAULTS.salvage}, triage ${DEFAULTS.triage}, warm workers ${DEFAULTS.warm}
state: ~/.config/enforcer/dispatch/<graph> (dispatcher.log, pids.json, STOP)
       enforcer dispatch --dry-run <graph>                                             print the planned launches; launch nothing
other dispatcher flags pass through; see docs/graph/DISPATCHER.md
`;

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
  const graph = argv.find((a, i) => !a.startsWith('-') && !['--workers', '--model', '--repo-root', '--worker-rules', '--context'].includes(argv[i - 1]));
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
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
  const res = await preflight({ graph, env, ...(workerRules ? { workerRules } : {}), ...(repoRoot ? { repoRoot } : {}) });
  for (const r of res) process.stdout.write(`${r.ok ? 'ok  ' : 'fail'}  ${r.name}: ${r.line}\n`);
  if (res.some((r) => !r.ok)) {
    process.stderr.write('enforcer dispatch: preflight failed, nothing started\n');
    return 2;
  }
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
    '--model',
    flag('--model') || DEFAULTS.model,
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
  const workers = open.filter((n) => n.status === 'running');
  const landing = open.filter((n) => blockedKeys.has(n.key));
  const gates = open.filter((n) => ['gate', 'release'].includes(n.type));
  const review = open.filter((n) => n.status === 'verifying' || ['rejected', 'escalated'].includes(n.verdict?.state || n.verification?.state));
  const needsYou = open.filter((n) => gates.includes(n) || review.includes(n) || n.status === 'failed');
  const mins = (n) => {
    const t = Date.parse(n.updated_at || n.started_at || '');
    return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : '?';
  };
  const model = (n) => ({ mechanical: 'haiku', standard: 'sonnet', deep: 'opus' })[n.data?.tier] || DEFAULTS.model;
  const L = [];
  L.push(`dispatcher: ${running ? `running (pid ${pids.dispatcher})` : 'not running'}${ci.length && running ? '; blocked on CI' : ''}`);
  L.push(`workers (${workers.length}):`);
  for (const n of workers) L.push(`  ${n.key}  ${mins(n)} min  ${model(n)}`);
  if (!workers.length) L.push('  none running');
  L.push(`nodes: ${done.length} done, ${open.length} open, ${landing.length} landing blocked, ${needsYou.length} needs you`);
  L.push(`needs you: ${needsYou.length}`);
  for (const n of landing) L.push(`  landing blocked: ${n.key}`);
  L.push(`review items (${review.length}):`);
  for (const n of review) {
    L.push(`  ${n.key}: a person must resolve the verdict`);
    for (const l of failedLines(n)) L.push(l);
  }
  if (!review.length) L.push('  none');
  L.push(`gates open (${gates.length}):`);
  for (const n of gates) L.push(`  ${n.key}: ${n.title || ''}`);
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
