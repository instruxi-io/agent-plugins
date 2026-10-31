// Git guard rails for non-Claude workers (codex, gemini, grok). Incident 2026-10-31 (conformance graph 6dd4ed03): a
// codex worker that could not `git add` (its sandbox did not cover the worktree's git dir) committed through an empty
// GIT_INDEX_FILE and merged with `gh pr merge` directly: the merge deleted 377 lines and added none. The prompt rules
// below tell every non-Claude worker how to land; the post-run guard catches a merge like that one if it happens anyway.
import { spawnSync } from 'node:child_process';

/** The landing rules appended to a non-Claude worker's prompt. `landPr` is the plugin's land-pr.sh path. */
export function nonClaudeGitRules(landPr) {
  return [
    'GIT RULES (non-negotiable):',
    `- Land a pull request ONLY with the plugin's land-pr.sh (${landPr}); never run \`gh pr merge\` yourself.`,
    '- Never set or override GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY or GIT_DIR, and never commit from a temporary index.',
    '- If git cannot write (git add, commit or push fails), stop and graph_report status "failed" with the exact git error.',
  ].join('\n');
}

/** The paths a node says it touches (`data.paths` or `data.files`), or [] when it names none. */
export function statedPaths(node) {
  const d = (node && node.data) || {};
  const list = Array.isArray(d.paths) ? d.paths : Array.isArray(d.files) ? d.files : [];
  return list.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().replace(/^\.\//, ''));
}

const within = (file, stated) => stated.some((p) => file === p || file.startsWith(p.endsWith('/') ? p : p + '/'));

/**
 * Is this pull request a destructive merge? `pr` is `gh pr view --json state,additions,deletions,files,url`.
 * Destructive: merged, zero additions, and it deletes lines in files outside the node's stated paths.
 * Returns `{reason, files, url}` or null.
 */
export function destructiveMerge(pr, node) {
  if (!pr || String(pr.state).toUpperCase() !== 'MERGED') return null;
  if (Number(pr.additions) !== 0 || !(Number(pr.deletions) > 0)) return null;
  const stated = statedPaths(node);
  const files = (pr.files || []).filter((f) => Number(f.deletions) > 0 && !within(String(f.path), stated)).map((f) => String(f.path));
  if (!files.length) return null;
  const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ` (+${files.length - 10} more)` : '');
  return {
    reason: `destructive_merge: ${pr.url || 'the merged PR'} deleted ${pr.deletions} line(s) and added none, outside the node's stated paths: ${shown}`,
    files,
    url: pr.url || null,
  };
}

/** Read the PR of `branch` with gh, in cwd. Null when there is none or gh fails. `run` is injectable for tests. */
export function prForBranch(branch, cwd, run = spawnSync) {
  if (!branch) return null;
  const r = run('gh', ['pr', 'view', branch, '--json', 'state,additions,deletions,files,url'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (!r || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** The post-run check: the destructive-merge finding for a worker's branch, or null. */
export function checkDestructiveMerge({ node, branch, cwd, run = spawnSync }) {
  return destructiveMerge(prForBranch(branch, cwd, run), node);
}
