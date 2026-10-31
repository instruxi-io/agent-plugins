// Worktree setup: base resolution, `git worktree add`, .worktreeinclude copies and .worktreeshare symlinks.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  lstatSync,
  copyFileSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname, normalize, isAbsolute, sep, resolve } from 'node:path';
import { git, originRef, ghPrState } from './prune.mjs';
import { assertIdent, safeIdent } from './ident.mjs';

export class BaseMissing extends Error {}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** origin's default branch as an origin/<name> ref: origin/HEAD, else gh, else origin/main|master; null when none. */
export function defaultBranch(src) {
  const h = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], src).stdout.trim();
  if (h) return h;
  let name = '';
  try {
    const r = spawnSync('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: src, encoding: 'utf8', timeout: 60000 });
    name = r.status === 0 ? (r.stdout || '').trim() : '';
  } catch {
    /* no gh */
  }
  if (name) return 'origin/' + name;
  for (const c of ['origin/main', 'origin/master']) if (git(['rev-parse', '--verify', '-q', c], src).returncode === 0) return c;
  return null;
}

/** [ref, source]: node data.base, then graph bases[repo], then the registry, then origin/HEAD. */
export function resolveBase(node, graphBases = null, registry = null, originHead = null) {
  const data = node.data || {};
  const repo = data.repo;
  if (String(data.base || '').trim()) return [originRef(data.base), 'data.base'];
  for (const [src, table] of [
    ['graph bases', graphBases],
    ['repo-bases.json', registry],
  ]) {
    const b = repo && table ? table[repo] : null;
    if (typeof b === 'string' && b.trim()) return [originRef(b), src];
  }
  return [originHead || 'origin/main', 'origin/HEAD'];
}

const INPUT_BRANCH_KEYS = ['tests_branch', 'input_branch', 'base_branch', 'base_commit'];

/** [ref, source] when the claim card's inputs name a branch (test-first's tests_branch) or commit to build on, else null. */
export function inputBase(inputs) {
  if (!inputs || typeof inputs !== 'object') return null;
  for (const k of INPUT_BRANCH_KEYS) {
    const v = typeof inputs[k] === 'string' ? inputs[k].trim() : '';
    if (!v) continue;
    if (/^[0-9a-f]{7,40}$/i.test(v)) return [v, 'input ' + k];
    const b = v.replace(/^origin\//, '');
    if (b.split('/').every((p) => safeIdent(p))) return [originRef(b), 'input ' + k];
  }
  return null;
}

export function checkBase(ref, source, cwd) {
  if (source === 'origin/HEAD') return;
  if (git(['rev-parse', '--verify', '-q', ref], cwd).returncode !== 0) throw new BaseMissing(`base ${ref} (from ${source}) does not exist on origin`);
}

/** The plan code in a worktree directory name: the graph id's first 8 characters, sanitized ('' when unknown). */
export const planCode = (graphId) =>
  String(graphId || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8);

/** The branch a worker uses: the claim card's `branch` (node.branch or data.branch) when it is a safe ref, else graph/<key>. */
export function branchFor(node, { code = null, epoch = null } = {}) {
  const b = node.branch ?? (node.data || {}).branch;
  if (typeof b === 'string' && b.split('/').every((p) => safeIdent(p))) return b;
  // The frontier row carries no branch (the server stamps it on the claim card), so compute the server's own name:
  // graph/<graphs.code>/<key>/e<epoch>, -a<attempt> when attempt > 1.
  const c = String(code || '');
  const e = Number(epoch ?? node.epoch ?? (node.data || {}).epoch ?? 1);
  if (c && safeIdent(c) && Number.isInteger(e) && e >= 0) {
    const at = Number(node.attempt ?? (node.data || {}).attempt ?? 1);
    return `graph/${c}/${node.key}/e${e}` + (Number.isInteger(at) && at > 1 ? `-a${at}` : '');
  }
  return 'graph/' + node.key;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run fn holding a lock file in the repo's git dir, so two dispatchers never race `git worktree add` in one repo.
 *  A lock older than staleSec is a dead holder's and is taken over. */
export function withRepoLock(src, fn, { timeoutMs = 120000, staleSec = 120 } = {}) {
  const gd = git(['rev-parse', '--git-common-dir'], src).stdout.trim();
  const dir = gd ? resolve(src, gd) : join(src, '.git');
  const lock = join(dir, 'graph-dispatch-worktree.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleSec * 1000) unlinkSync(lock);
      } catch {
        /* gone already */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for the worktree lock ' + lock);
      sleepSync(50 + Math.floor(Math.random() * 100));
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** [path, branch, note]. A node with a data.repo checkout under repoRoot gets <repoRoot>/<repo>-<plan code>-<key> on the
 *  card's branch (else graph/<key>); the plan code is the graph id's first 8 characters. */
export function worktreeFor(
  node,
  repoRoot,
  stateDir,
  {
    dry = false,
    graphBases = null,
    registry = null,
    graphId = null,
    graphCode = null,
    graphEpoch = null,
    inputs = null,
    say = /** @type {(m: string) => void} */ (() => {}),
  } = {},
) {
  const key = assertIdent(node.key, 'node key'); // the key and repo become paths and a branch: never trust a caller to have checked
  const repo = (node.data || {}).repo;
  if (repo !== undefined && repo !== null) assertIdent(repo, 'data.repo');
  const branch = branchFor(node, { code: graphCode, epoch: graphEpoch });
  const code = planCode(graphId);
  const gitMarker = repo && repoRoot ? join(repoRoot, repo, '.git') : null;
  if (!repo || !repoRoot || !(isDir(gitMarker) || isFile(gitMarker))) {
    const path = join(stateDir, 'work', key);
    if (!dry) mkdirSync(path, { recursive: true });
    return [path, null, `scratch dir (${!repo ? 'no data.repo' : `no checkout of ${repo} under ${repoRoot}`})`];
  }
  const src = join(repoRoot, repo);
  const path = join(repoRoot, code ? `${repo}-${code}-${key}` : `${repo}-${key}`);
  if (isDir(path)) return [path, branch, 'reused'];
  let [base, source] = resolveBase(node, graphBases, registry, null);
  const ib = inputBase(inputs);
  if (ib) {
    [base, source] = ib;
    say(`worktree-base: from ${source} ${base.replace(/^origin\//, '')}`);
  } else if (inputs && typeof inputs === 'object') {
    // inputs present but none names a branch: ordinary node, the base applies
  } else if (node.data && node.data.needs_input_branch) {
    say('worktree-base: WARNING input branch absent; falling back to ' + base);
  }
  if (source === 'origin/HEAD') {
    base = defaultBranch(src);
    if (!base) throw new BaseMissing("cannot resolve origin's default branch (no origin/HEAD, gh repo view failed, no origin/main or origin/master)");
  }
  if (!dry) {
    const f = git(['fetch', '-q', 'origin'], src);
    if (f.returncode !== 0) throw new BaseMissing(`git fetch origin failed (a stale ref would be used): ${(f.stderr || f.stdout).trim().slice(0, 200)}`);
  }
  checkBase(base, source, src);
  if (dry) return [path, branch, 'would add off ' + base];
  return withRepoLock(src, () => addWorktree(src, path, branch, base));
}

function addWorktree(src, path, branch, base) {
  if (isDir(path)) return [path, branch, 'reused'];
  let r = git(['worktree', 'add', path, '-b', branch, base], src);
  if (r.returncode === 0) return [path, branch, 'added off ' + base];
  git(['worktree', 'prune'], src);
  let note = 'reused branch'; // the branch exists from an earlier attempt
  if (git(['merge-base', '--is-ancestor', branch, base], src).returncode === 0 || ghPrState(branch, src) === 'MERGED') {
    // no commits ahead of base (or already merged): stale, check it out into the new worktree
    git(['branch', '-f', branch, base], src);
    r = git(['worktree', 'add', path, branch], src);
    note = 'reused stale branch, reset to ' + base;
  } else {
    // it has commits: leave it alone and take the next -a<attempt> name
    const stem = branch.replace(/-a\d+$/, '');
    for (let n = Math.max(2, Number((/-a(\d+)$/.exec(branch) || [])[1] || 1) + 1); n < 50; n++) {
      const alt = `${stem}-a${n}`;
      if (git(['rev-parse', '--verify', '-q', 'refs/heads/' + alt], src).returncode === 0) continue;
      branch = alt;
      r = git(['worktree', 'add', path, '-b', branch, base], src);
      note = `branch has commits; new branch ${alt} off ${base}`;
      break;
    }
  }
  if (r.returncode !== 0) throw new Error('worktree add failed: ' + (r.stderr || r.stdout).trim().slice(0, 300));
  return [path, branch, note];
}

function manifest(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** Apply <src>/.worktreeinclude (ignored files to COPY) and .worktreeshare (dirs to SYMLINK). {copied, linked, notes}. */
export function worktreeSetup(src, path, { dry = false } = {}) {
  let copied = 0;
  let linked = 0;
  const notes = [];
  const root = real(src);
  const includes = [];
  for (let pat of manifest(join(src, '.worktreeinclude'))) {
    if (isAbsolute(pat) || pat.split('/').includes('..')) notes.push(`skip ${pat} (missing or outside repo)`);
    else if (!/[*?[]/.test(pat)) includes.push(pat);
    else {
      pat = pat.replace(/\/+$/, '');
      const specs = [':(glob)' + pat.replace(/^\/+/, '')];
      if (!pat.includes('/')) specs.push(':(glob)**/' + pat);
      const r = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...specs], src);
      const found = r.stdout.split('\0').filter(Boolean).sort();
      if (!found.length) notes.push(`skip ${pat} (matches no ignored file)`);
      includes.push(...found);
    }
  }
  for (const rel of includes) {
    const f = real(join(src, rel));
    if (!f.startsWith(root + sep) || !isFile(f)) {
      notes.push(`skip ${rel} (missing or outside repo)`);
      continue;
    }
    if (git(['ls-files', '--error-unmatch', '--', rel], src).returncode === 0) {
      notes.push(`skip ${rel} (tracked by git)`);
      continue;
    }
    const dest = join(path, rel);
    if (lexists(dest)) {
      notes.push(`skip ${rel} (already in worktree)`);
      continue;
    }
    if (!dry) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(f, dest);
    }
    copied++;
  }
  for (const rel of manifest(join(src, '.worktreeshare'))) {
    const target = normalize(join(src, rel));
    const dest = normalize(join(path, rel));
    const parts = rel.split('/');
    let lead = 0;
    while (lead < parts.length && parts[lead] === '..') lead++;
    const inside = real(target).startsWith(root + sep);
    if (isAbsolute(rel) || parts.slice(lead).includes('..') || lead > 1 || (lead === 0 && !inside)) {
      notes.push(`skip ${rel} (share escapes the source root)`);
      continue;
    }
    if (!isDir(target)) {
      notes.push(`skip ${rel} (not a directory in the main checkout)`);
      continue;
    }
    if (rel.startsWith('..') && dirname(normalize(path)) !== dirname(root)) {
      notes.push(`skip ${rel} (sibling share needs worktree beside checkout)`);
      continue;
    }
    if (lexists(dest)) {
      notes.push(`skip ${rel} (already in worktree)`);
      continue;
    }
    if (!dry) {
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(target, dest);
      if (lead === 0) {
        // keep the share out of `git status`: .git/info/exclude of the worktree
        const ex = git(['rev-parse', '--git-path', 'info/exclude'], path).stdout.trim();
        if (ex) {
          const p = resolve(path, ex);
          mkdirSync(dirname(p), { recursive: true });
          appendFileSync(p, '/' + rel.replace(/\/+$/, '') + '\n');
        }
      }
    }
    linked++;
  }
  return { copied, linked, notes };
}
