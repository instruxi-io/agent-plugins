// GitHub checks: an acceptance row `{"check": "github.pr_merged" | "github.pr_untouched" | "github.checks_green"}` is
// decided by the server from RUNNER evidence (no server-side GitHub credential in v1). The runner, never the model, runs
// `gh pr view` / `gh pr checks` as argv (no shell, spawnAllowed's minimal environment plus the read-only GH_TOKEN) and
// yields one record `{kind:'check', source:'runner', name:'github.<x>', ...}` with the fields the server reads:
//   pr_merged, pr_untouched: pr ("owner/name#N"), head (PR head branch), state, merge_sha, files
//   checks_green:            pr, sha (PR head commit), checks [{name, conclusion, required}]
// A gh failure (no token, no PR, network, bad JSON) yields {skip: reason}: no record, which the server reads as
// no_runner_record, an error and never a pass. The report hook strips `source: runner` from worker evidence.
import { spawnAllowed } from './acceptance-allowlist.mjs';

export const GITHUB_CHECKS = Object.freeze(['github.pr_merged', 'github.checks_green', 'github.pr_untouched']);

/** The full check name of an acceptance row `{check: "github.<name>"}`, or null for any other row. */
export function githubCheckName(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.check !== 'string') return null;
  const n = row.check.trim();
  return GITHUB_CHECKS.includes(n) ? n : null;
}

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** owner/name from a remote URL (https, ssh or scp form), or ''. */
export function slugOf(url) {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : '';
}

/** Run the check for `name` in `cwd`. Returns the runner record or {skip: reason}.
 *  @param {string} name
 *  @param {{cwd?: string, env?: any, timeoutMs?: number, run?: any, branch?: string, repo?: string}} opts */
export function runGithubCheck(name, { cwd, env = process.env, timeoutMs = 60000, run, branch, repo } = {}) {
  if (!GITHUB_CHECKS.includes(name)) return { skip: `unknown check ${name}` };
  const exec = (argv) => spawnAllowed(argv, { cwd, env, timeoutMs, ...(run ? { run } : {}) });
  const git = (...a) => {
    const r = exec(['git', ...a]);
    return r.exit === 0 ? String(r.out).trim() : '';
  };
  const slug = repo || slugOf(git('remote', 'get-url', 'origin'));
  if (!SLUG_RE.test(slug)) return { skip: `${name}: no GitHub origin owner/name` };
  const br = branch || git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!br || br === 'HEAD' || !BRANCH_RE.test(br)) return { skip: `${name}: no run branch` };
  const gh = (argv) => {
    const r = exec(['gh', ...argv]);
    if (r.exit !== 0) return { err: `gh ${argv.slice(0, 2).join(' ')} exited ${r.exit}: ${String(r.out).trim().slice(0, 300)}` };
    try {
      return { data: JSON.parse(r.out) };
    } catch {
      return { err: `gh ${argv.slice(0, 2).join(' ')} printed no JSON` };
    }
  };
  const v = gh(['pr', 'view', br, '--repo', slug, '--json', 'number,state,headRefName,headRefOid,mergeCommit,files']);
  if (v.err) return { skip: `${name}: ${v.err}` };
  const pr = v.data;
  if (!pr || !Number.isInteger(pr.number)) return { skip: `${name}: gh pr view returned no PR number` };
  const prId = `${slug}#${pr.number}`;
  const base = { kind: 'check', source: 'runner', name, pr: prId, exit: 0 };
  if (name !== 'github.checks_green') {
    return {
      ...base,
      head: String(pr.headRefName ?? ''),
      state: String(pr.state ?? ''),
      merge_sha: String(pr.mergeCommit?.oid ?? ''),
      files: (Array.isArray(pr.files) ? pr.files : []).map((f) => String(f?.path ?? '')).filter(Boolean),
    };
  }
  const all = gh(['pr', 'checks', String(pr.number), '--repo', slug, '--json', 'name,state,bucket']);
  if (all.err) return { skip: `${name}: ${all.err}` };
  // gh has no `required` JSON field: the required set is `--required`. It exits non-zero when none are required.
  const req = exec(['gh', 'pr', 'checks', String(pr.number), '--repo', slug, '--required', '--json', 'name']);
  let required = new Set();
  if (req.exit === 0) {
    try {
      required = new Set(JSON.parse(req.out).map((c) => c.name));
    } catch {
      return { skip: `${name}: gh pr checks --required printed no JSON` };
    }
  } else if (!/no required checks/i.test(String(req.out))) return { skip: `${name}: gh pr checks --required exited ${req.exit}` };
  const list = Array.isArray(all.data) ? all.data : [];
  return {
    ...base,
    sha: String(pr.headRefOid ?? ''),
    checks: list.map((c) => ({ name: String(c.name ?? ''), conclusion: String(c.bucket || c.state || ''), required: required.has(c.name) })),
  };
}
