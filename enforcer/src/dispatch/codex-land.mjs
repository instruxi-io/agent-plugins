// @ts-nocheck untyped option objects (injectable run/land/check), as in salvage.mjs
// The dispatcher lands for Codex workers (owner decision 2026-10-31). Codex CLI's `--sandbox workspace-write` keeps a
// linked worktree's git metadata read-only by design (`.git/worktrees/<name>/index.lock: Read-only file system`), even
// with `--add-dir <git common dir>`: no flag lets a codex worker commit. So a codex worker only edits files and runs
// checks, then reports; the dispatcher, outside the sandbox, commits its worktree on the card branch, pushes, opens the
// PR, lands it with land-pr.sh (CI-gated, never red) and posts the github runner records (pr_merged, checks_green,
// pr_untouched) to the run's evidence route, so the verdict is decided in code. The worker's report stays unjudged
// until those records arrive (the route accepts records on an unjudged or check_error run).
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { sh, landWithHeartbeat, ATTRIBUTION } from './salvage.mjs';
import { statedPaths } from './git-guard.mjs';
import { runGithubCheck, GITHUB_CHECKS } from '../github-checks.mjs';
import { clip } from './util.mjs';

/** The git rules appended to a codex worker's prompt: edit and check only; the dispatcher commits and lands. */
export function codexGitRules() {
  return [
    'GIT RULES (non-negotiable, codex): your sandbox keeps git metadata read-only, so the dispatcher lands for you.',
    '- Edit files and run checks (tests, linters) only. Never run git add, git commit, git push, git merge, gh pr create or gh pr merge.',
    '- Never set or override GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY or GIT_DIR.',
    '- When the change is ready and your checks pass, graph_report status "succeeded" with your evidence. The dispatcher then',
    '  commits your worktree on this branch, pushes, opens the pull request and lands it with land-pr.sh; CI decides the merge.',
  ].join('\n');
}

const within = (file, stated) => stated.some((p) => file === p || file.startsWith(p.endsWith('/') ? p : p + '/'));

/** Parse `git diff --cached --numstat -z`-free plain numstat lines into files. Binary files count as one line each way. */
export function parseNumstat(text) {
  const files = [];
  for (const ln of String(text || '').split(/\r?\n/)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(ln);
    if (!m) continue;
    const num = (v) => (v === '-' ? 1 : Number(v));
    files.push({ path: m[3], additions: num(m[1]), deletions: num(m[2]) });
  }
  return {
    files,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
  };
}

/**
 * Should this staged diff be refused? Empty (nothing changed), or destructive (zero additions and it deletes lines in
 * files outside the node's stated paths). Returns `{reason, files}` or null when the diff may be committed.
 */
export function diffRefusal(diff, node) {
  if (!diff || !diff.files.length) return { reason: 'destructive_or_empty_diff: the worker left no changes in its worktree', files: [] };
  if (diff.additions !== 0) return null;
  const stated = statedPaths(node);
  const files = diff.files.filter((f) => f.deletions > 0 && !within(f.path, stated)).map((f) => f.path);
  if (!files.length) return null;
  const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ` (+${files.length - 10} more)` : '');
  return {
    reason: `destructive_or_empty_diff: the worktree deletes ${diff.deletions} line(s) and adds none, outside the node's stated paths: ${shown}`,
    files,
  };
}

/** The commit message naming the node and the run. */
export function commitMessage(node, runId) {
  return `${node.title || node.key}\n\nNode: ${node.key} (${node.id ?? node.node_id ?? '-'})\nCommitted by graph-dispatch for a codex worker.\nEnforcer-Run: ${runId}`;
}

/** The PR body; it ends with the Enforcer-Run footer that joins the PR to the run. */
export function prBody(node, runId) {
  return `Landed by graph-dispatch for a codex worker on node \`${node.key}\`.\n\n${ATTRIBUTION}\n\nEnforcer-Run: ${runId}`;
}

/**
 * Commit, push, open and land a codex worker's worktree. Never throws. Returns one of:
 *   {ok: true, pr, url, records}                        landed and the github runner records posted
 *   {ok: false, code: 'destructive_or_empty_diff', error, files}
 *   {ok: false, code: 'ci_failed' | 'land_failed' | 'git_failed', error, evidence}
 * Injectable: `run(cmd, cwd) -> [rc, out]` (git, gh), `land({cmd, cwd}) -> Promise<{rc, out}>`, `check(name, opts)` (a
 * github runner record or {skip}), `api.addEvidence`.
 */
export async function landForCodex({
  api,
  graph,
  node,
  runId,
  cwd,
  branch,
  base = 'main',
  landPr,
  landTimeout = 1800,
  logDir,
  say = () => {},
  run = sh,
  land,
  check = runGithubCheck,
}) {
  const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
  const git = (...a) => run(['git', ...a], cwd);
  let [rc, out] = git('add', '-A');
  if (rc) return fail('git_failed', `git add -A failed: ${clip(out, 300)}`);
  [rc, out] = git('diff', '--cached', '--numstat', 'HEAD');
  if (rc) return fail('git_failed', `git diff --cached failed: ${clip(out, 300)}`);
  const refused = diffRefusal(parseNumstat(out), node);
  if (refused) {
    git('reset', '-q');
    return fail('destructive_or_empty_diff', refused.reason, { files: refused.files });
  }
  [rc, out] = git('commit', '-q', '-m', commitMessage(node, runId));
  if (rc) return fail('git_failed', `git commit failed: ${clip(out, 300)}`);
  [rc, out] = git('push', '-u', 'origin', `HEAD:refs/heads/${branch}`);
  if (rc) return fail('git_failed', `git push failed: ${clip(out, 300)}`);
  // reuse an open PR for the branch (a retry), else open one
  let url = '';
  [rc, out] = run(['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], cwd);
  if (rc === 0 && /\/pull\/\d+/.test(out)) url = out.trim();
  else {
    [rc, out] = run(
      [
        'gh',
        'pr',
        'create',
        '--base',
        String(base).replace(/^origin\//, ''),
        '--head',
        branch,
        '--title',
        node.title || node.key,
        '--body',
        prBody(node, runId),
      ],
      cwd,
    );
    const m = rc === 0 ? /https?:\/\/\S+\/pull\/\d+/.exec(out) : null;
    if (!m) return fail('git_failed', `gh pr create failed: ${clip(out, 300)}`);
    url = m[0];
  }
  say(`codex land ${node.key}: committed and opened ${url}; landing with land-pr.sh`);
  const cmd = [landPr, url, '--timeout', String(landTimeout)];
  const landed = await (land || defaultLand(logDir, node.key))({ cmd, cwd });
  const landEvidence = { kind: 'command', cmd: cmd.join(' '), exit: landed.rc, output: clip(landed.out || '') };
  if (landed.rc !== 0) {
    const code = landed.rc === 2 ? 'ci_failed' : 'land_failed';
    return fail(
      code,
      `land-pr.sh exit ${landed.rc} for ${url}: ${String(landed.out || '')
        .trim()
        .slice(-500)}`,
      { url, evidence: [landEvidence] },
    );
  }
  const records = [];
  for (const name of GITHUB_CHECKS) {
    const r = check(name, { cwd, branch });
    if (r && !r.skip) records.push(r);
    else say(`codex land ${node.key}: ${name} record skipped: ${r?.skip || 'no record'}`);
  }
  if (records.length) {
    try {
      await api.addEvidence(graph, node.id ?? node.node_id, runId, { evidence: records });
      say(`codex land ${node.key}: ${records.length} github runner record(s) posted on run ${runId}`);
    } catch (e) {
      say(`codex land ${node.key}: github records not accepted: ${e.message}`);
    }
  }
  return { ok: true, url, records, evidence: [landEvidence] };
}

/** land-pr.sh as a child process, its output in `<logDir>/<key>.land.log`. */
function defaultLand(logDir, key) {
  return async ({ cmd, cwd }) => {
    const logPath = join(logDir || cwd, `${key}.land.log`);
    const { rc } = await landWithHeartbeat({ cmd, cwd, logPath, heartbeat: async () => null });
    let out = '';
    try {
      out = readFileSync(logPath, 'utf8');
    } catch {
      /* none */
    }
    return { rc, out };
  };
}
