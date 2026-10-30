// Worktree pruning: only a clean tree whose branch is merged (or whose PR is MERGED) may go; live workers never.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isObj } from './util.mjs';

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { returncode: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function originRef(b) {
  b = (b || '').trim();
  return b.startsWith('origin/') ? b : 'origin/' + b;
}

/** The repo -> branch registry file; {} when absent or unreadable. */
export function loadRepoBases(path) {
  path = path || join(process.env.ENFORCER_CONFIG_HOME || join(homedir(), '.config', 'enforcer'), 'dispatch', 'repo-bases.json');
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObj(d)) return {};
    return Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === 'string' && v.trim()));
  } catch {
    return {};
  }
}

/** MERGED / OPEN / CLOSED for the PR whose head sha is the branch's current head, null when gh cannot say. */
export function ghPrState(branch, src) {
  const head = git(['rev-parse', '--verify', '-q', branch], src).stdout.trim();
  if (!head) return null;
  let prs;
  try {
    const r = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,headRefOid'], { cwd: src, encoding: 'utf8', timeout: 30000 });
    if (r.error) return null;
    prs = r.status === 0 ? JSON.parse(r.stdout) : [];
  } catch {
    return null;
  }
  const states = (Array.isArray(prs) ? prs : []).filter((p) => isObj(p) && p.headRefOid === head).map((p) => p.state);
  for (const want of ['OPEN', 'MERGED', 'CLOSED']) if (states.includes(want)) return want;
  return null;
}

/** [ok, reason]. */
export function worktreeSafeToRemove(path, branch, src, baseRef = null, prState = null) {
  const st = git(['status', '--porcelain'], path);
  if (st.returncode !== 0) return [false, 'uncommitted changes (status unreadable)'];
  if (st.stdout.trim()) return [false, 'uncommitted changes'];
  const refs = [];
  const h = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], src).stdout.trim();
  for (const r of [baseRef, h]) if (r && !refs.includes(r)) refs.push(r);
  for (const r of refs) {
    if (git(['rev-parse', '--verify', '-q', r], src).returncode === 0 && git(['merge-base', '--is-ancestor', branch, r], src).returncode === 0)
      return [true, 'merged into ' + r];
  }
  const state = (prState || ghPrState)(branch, src);
  if (state === 'MERGED') return [true, 'PR merged'];
  if (state === 'OPEN') return [false, 'open PR'];
  return [false, 'unmerged commits'];
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Node keys of workers recorded in any <stateRoot>/*\/pids.json whose pid is still alive. */
export function liveWorkerKeys(stateRoot) {
  const keys = new Set();
  let names;
  try {
    names = readdirSync(stateRoot);
  } catch {
    return keys;
  }
  for (const n of names) {
    try {
      const d = JSON.parse(readFileSync(join(stateRoot, n, 'pids.json'), 'utf8'));
      for (const [k, pid] of Object.entries((d && d.workers) || {})) if (pidAlive(pid)) keys.add(k);
    } catch {
      /* skip */
    }
  }
  return keys;
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Remove each <repo>-<key> worktree (branch graph/<key>) that is safe to remove (with yes; else only
 *  say so) and list the rest. Returns {removed, kept} as [path, why] pairs. `out` is a write function. */
export function pruneWorktrees(
  repoRoot,
  { yes = false, registry = null, prState = null, out = (s) => process.stdout.write(s), liveKeys = null, minAge = 3600 } = {},
) {
  registry = registry === null ? loadRepoBases() : registry;
  const removed = [];
  const kept = [];
  const say = (s) => out(s + '\n');
  for (const repo of readdirSync(repoRoot).sort()) {
    const src = join(repoRoot, repo);
    if (!existsSync(join(src, '.git')) || !statSync(join(src, '.git')).isDirectory()) continue;
    const porc = git(['worktree', 'list', '--porcelain'], src).stdout;
    for (const blk of porc.split('\n\n')) {
      const f = {};
      for (const l of blk.split('\n')) {
        const i = l.indexOf(' ');
        if (i > 0) f[l.slice(0, i)] = l.slice(i + 1);
      }
      const path = f.worktree;
      const br = f.branch || '';
      if (!path || !br.startsWith('refs/heads/graph/')) continue;
      const key = br.slice('refs/heads/graph/'.length);
      const pb = basename(path);
      if (real(dirname(path)) !== real(repoRoot) || !(pb === `${repo}-${key}` || (pb.startsWith(repo + '-') && pb.endsWith('-' + key)))) continue;
      if (liveKeys && (liveKeys instanceof Set ? liveKeys.has(key) : liveKeys.includes(key))) {
        kept.push([path, 'live worker (pids.json)']);
        continue;
      }
      let young = false;
      try {
        young = Date.now() / 1000 - statSync(path).mtimeMs / 1000 < minAge;
      } catch {
        /* gone */
      }
      if (young) {
        kept.push([path, `modified within the last ${minAge} s`]);
        continue;
      }
      const base = registry[repo];
      const bare = br.slice('refs/heads/'.length);
      const [ok, why] = worktreeSafeToRemove(path, bare, src, base ? originRef(base) : null, prState);
      if (ok && yes) {
        const r = git(['worktree', 'remove', '--force', path], src);
        if (r.returncode !== 0) {
          kept.push([path, 'remove failed: ' + r.stderr.trim().slice(0, 200)]);
          continue;
        }
        removed.push([path, why]);
        say(`removed ${path} (${why})`);
        // a confirmed merge frees the branch name for a re-claim
        if (String(why).startsWith('PR merged') || String(why).startsWith('merged into')) git(['branch', '-D', bare], src);
      } else if (ok) {
        removed.push([path, why]);
        say(`would remove ${path} (${why})`);
      } else kept.push([path, why]);
    }
    if (yes) git(['worktree', 'prune'], src);
  }
  if (kept.length) {
    say(`Review ${kept.length} branches:`);
    for (const [path, why] of kept) say(`  ${path}: ${why}`);
  }
  if (yes)
    git(
      ['worktree', 'prune'],
      join(
        repoRoot,
        readdirSync(repoRoot)
          .sort()
          .find((r) => existsSync(join(repoRoot, r, '.git'))) || '.',
      ),
    );
  return { removed, kept };
}
