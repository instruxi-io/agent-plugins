// The headless graph-worker policy, as governor rules.
//
// A graph worker is a `claude -p` session the dispatcher starts in a git
// worktree on branch graph/<key>. It has to push that branch, open a pull
// request from it and land it with land-pr.sh, and there is nobody to answer a
// permission prompt. Until 2.9 this policy lived in jev-hooks' bash gate, while
// two other PreToolUse hooks decided independently and a refusal was a
// sentence the dispatcher grepped. Here it is one set of rules with machine
// codes (codes.mjs), and the governor is the plugin that allows or denies it.
//
//   headless (no approval surface)      a person is present
//   ───────────────────────────────     ────────────────────────────────
//   push graph/<key>, alone   allow     ask   graph_push_confirm
//   gh pr create on graph/    allow     ask   graph_pr_confirm
//   land-pr.sh on graph/      allow     ask   graph_land_confirm
//   force-push                deny      (left to git.force_push: rewrite)
//   push to a default branch  deny      ask   push_default_branch
//   edit plugin/gov settings  deny      ask   settings_write
//
// Pure, like capability.mjs: the caller resolves the context first (whether
// the session is headless, which branch the worktree has checked out) and
// passes it on the event. Nothing here reads a file, the environment or git.
//
// ev.worker = { headless: boolean, branch: string|null }
//   branch: the checked-out branch of the directory the command runs in
//   (cwd, or `git -C <dir>`), null when it is not a git worktree.

import { Verdict, CAPABILITY } from './verdict.mjs';
import { allow as ALLOW, deny as DENY } from './headless-worker-profile.mjs';
import { rulesetOf, WORKER_RULESET } from './compliance.mjs';

export const WORKER_RULES = Object.freeze([
  { id: 'graph.push', name: 'push a graph/<key> branch' },
  { id: 'graph.pr_create', name: 'open a pull request from a graph/<key> branch' },
  { id: 'graph.land', name: 'land a graph/<key> pull request with land-pr.sh' },
  { id: 'git.push_default_branch', name: 'push to a default branch' },
  { id: 'git.force_push', name: 'force-push without a lease' },
  { id: 'governor.settings', name: 'edit plugin or governor settings' },
  { id: 'graph.protected_paths', name: 'a headless worker editing CI workflows, release or deploy scripts, or secret files' },
  { id: 'fs.delete_tree', name: "delete a tree inside the worker's own worktree" },
]);
const RULE = Object.fromEntries(WORKER_RULES.map((r) => [r.id, r]));

export const DEFAULT_BRANCHES = DENY.defaultBranches;
const GRAPH = ALLOW.pushBranch;
const isGraph = (b) => typeof b === 'string' && GRAPH.test(b);

// Plugin and governor settings: Claude Code's settings files, installed plugin
// code (its hooks are part of the gate), and the governor's own home.
// Claude Code's settings and plugin directory, named here as a fragment so the
// literal is not spread through the package (hooks/claude/paths.mjs owns the name).
const DOT = '.' + 'claude';
const SETTINGS_PATTERN = '\\' + DOT + '\\/settings(\\.local)?\\.json|\\' + DOT + '\\/plugins\\/';
export const SETTINGS_PATHS = DENY.settingsPaths;
export const SETTINGS = new RegExp('(^|[\\s"\'=\\/])(' + SETTINGS_PATHS + ')');
// A shell command that changes a file, as opposed to reading it.
// The only commands that may name a settings path: a single plain read.
const PLAIN_READ = /^(cat|less|head|tail|jq|grep)(\s|$)/;
const MUTATES =
  /(^|[^0-9&<])>{1,2}(?!&)|\btee\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\b(cp|mv|rm|ln|chmod|chown|truncate|install|unlink)\s|\bjq\b[^|]*>|\bwriteFile|\bperl\s+-[a-zA-Z]*i/;

// The skill's own land-pr.sh invocation finds the script with a substitution;
// it is one command, so it is folded to its name before the shape is checked.
const LAND_LOOKUP = /^"?\$\(\s*ls\s+-d\s+([^()|;&\s]*\/land-pr\.sh)\s*\|\s*tail\s+-1\s*\)"?/;
// Where land-pr.sh may live: the plugin's own bin/, or its install cache.
const CACHE_LAND = ALLOW.landerCache;
// ...spelled with the user's absolute home, as `ls` prints it.
const CACHE_ABS = ALLOW.landerCacheAbs;
const trustedLand = (path, root) => {
  if (typeof path !== 'string' || /\.\./.test(path)) return false;
  if (CACHE_LAND.test(path.replace(/\*/g, 'x')) || CACHE_ABS.test(path)) return true;
  const r = typeof root === 'string' && root ? root.replace(/\/+$/, '') : null;
  return path === '$CLAUDE_PLUGIN_ROOT/bin/land-pr.sh' || path === '${CLAUDE_PLUGIN_ROOT}/bin/land-pr.sh' || (!!r && path === r + '/bin/land-pr.sh');
};
const META = /[;&|`\n<>]|\$\(/;

// These rules as data -- the rule list and the profile they read -- versioned by content for the receipt.
const WORKER_DATA = Object.freeze({ rules: WORKER_RULES, allow: ALLOW, deny: DENY });
const verdict = (action, ruleId, code, reason) => {
  const of = { source: CAPABILITY, rule: RULE[ruleId].name, ruleId, checked: [CAPABILITY], code, ruleset: rulesetOf(WORKER_RULESET, WORKER_DATA) };
  return action === 'allow' ? Verdict.allow(reason, of) : action === 'deny' ? Verdict.deny(reason, of) : Verdict.ask(reason, of);
};

function commandOf(ev) {
  if (typeof ev.input?.command === 'string') return ev.input.command;
  if (typeof ev.raw?.command === 'string') return ev.raw.command;
  const a = String(ev.action || '');
  return a.replace(/^Bash:/, '').split('\n')[0];
}
const isShell = (ev) => ev.tool === 'shell' || ev.tool === 'Bash' || ev.name === 'Bash';
const isFileWrite = (ev) =>
  ['edit', 'write', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.tool) || ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.name);

/** Split a command into words; quotes group, nothing is expanded. */
export function words(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `git [-C dir] push ...`: the push's own words, or null when it is not one. */
export function pushArgs(cmd) {
  const w = words(cmd.trim());
  let i = 0;
  if (w[i] !== 'git') return null;
  i++;
  if (w[i] === '-C') i += 2;
  if (w[i] !== 'push') return null;
  return w.slice(i + 1);
}
export function gitDir(cmd) {
  const w = words(cmd.trim());
  return w[0] === 'git' && w[1] === '-C' ? w[2] : null;
}

const mentionsDelivery = (cmd) => /\bgit\s+(-C\s+\S+\s+)?push\b|\bgh\s+pr\s+create\b|land-pr\.sh|(^|\s)enforcer\s+land\b/.test(cmd);
// Everything a headless worker could deliver or exfiltrate through. Anything
// here that is not an exactly recognised shape is refused.
const mentionsDeliveryWide = (cmd) =>
  /(^|[^\w.-])git\b[^|;&\n]*?\s(push|remote)\b|(^|[^\w.-])gh\b[^|;&\n]*?\b(pr\s+(create|merge)|api)\b|land-pr\.sh|(^|\s)enforcer\s+land\b/.test(cmd) ||
  mentionsDelivery(cmd);
const shape = (why) => verdict('deny', 'graph.push', 'delivery_shape', `a headless worker may only run the exact recognised delivery commands: ${why}`);

const PR_FLAGS = new Set(ALLOW.prCreateFlags);
const prShapeOk = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fill') continue;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      if (!PR_FLAGS.has(a.slice(0, eq))) return false;
      continue;
    }
    if (!PR_FLAGS.has(a)) return false;
    if (i + 1 >= args.length) return false;
    i++;
  }
  return true;
};
const landShapeOk = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\d+$/.test(a)) continue;
    if (/^--timeout=\d+$/.test(a)) continue;
    if (a === '-R' && /^[\w.-]+\/[\w.-]+$/.test(args[i + 1] || '')) {
      i++;
      continue;
    }
    if (a === '--timeout' && /^\d+$/.test(args[i + 1] || '')) {
      i++;
      continue;
    }
    return false;
  }
  return true;
};

function push(args, ctx) {
  const { headless, branch } = ctx;
  let force = false,
    other = false;
  const pos = [];
  for (const a of args) {
    if (a === '-u' || a === '--set-upstream') continue;
    if (a === '--force-with-lease' || a.startsWith('--force-with-lease=')) continue; // the skill's rebase path
    if (a === '-f' || a === '--force' || (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) && !a.startsWith('--'))) {
      force = true;
      continue;
    }
    if (a.startsWith('-')) {
      other = true;
      continue;
    }
    if (a.startsWith('+')) force = true;
    pos.push(a.replace(/^\+/, ''));
  }
  if (headless && pos[0] !== undefined && pos[0] !== 'origin') return shape('push to origin only');
  const [, refspec, ...extra] = pos;
  const src = refspec?.includes(':') ? refspec.split(':')[0] : refspec;
  const dst = (refspec?.includes(':') ? refspec.split(':')[1] : refspec)?.replace(/^refs\/heads\//, '');
  const toDefault = dst && DEFAULT_BRANCHES.includes(dst);

  if (force && headless) return verdict('deny', 'git.force_push', 'force_push', 'a headless worker may not force-push');
  if (force) return null; // git.force_push rewrites it to --force-with-lease
  if (toDefault)
    return headless
      ? verdict('deny', 'git.push_default_branch', 'push_default_branch', `a headless worker may not push to ${dst}`)
      : verdict('ask', 'git.push_default_branch', 'push_default_branch', `would upload your changes straight to the shared ${dst} branch (git push)`);
  if (!isGraph(dst))
    return headless ? verdict('deny', 'graph.push', 'push_needs_approval_surface', 'only `git push -u origin graph/<key>` may run with nobody to ask') : null;
  if (!headless) return verdict('ask', 'graph.push', 'graph_push_confirm', `would upload the branch ${dst} to the shared online copy (git push)`);
  if (other || extra.length)
    return verdict('deny', 'graph.push', 'push_needs_approval_surface', 'only `git push -u origin graph/<key>` may run with nobody to ask');
  if (!isGraph(branch)) return verdict('deny', 'graph.push', 'outside_worktree', 'the working directory is not a worktree on a graph/<key> branch');
  if (dst !== branch || (src && src !== 'HEAD' && src !== branch))
    return verdict('deny', 'graph.push', 'branch_mismatch', `the worktree has ${branch} checked out, not ${dst}`);
  return verdict('allow', 'graph.push', 'graph_push_allowed', `headless worker pushing its own branch ${branch}`);
}

function prCreate(args, ctx) {
  const { headless, branch } = ctx;
  if (headless && !prShapeOk(args)) return shape('pull request creation takes only --title --body --base --head --fill');
  const h = args.indexOf('--head') >= 0 ? args[args.indexOf('--head') + 1] : args.find((a) => a.startsWith('--head='))?.slice(7);
  const head = h || branch;
  if (!isGraph(branch) && !isGraph(h))
    return headless ? verdict('deny', 'graph.pr_create', 'outside_worktree', 'the working directory is not a worktree on a graph/<key> branch') : null;
  if (!headless) return verdict('ask', 'graph.pr_create', 'graph_pr_confirm', `would open a request to merge the branch ${head} (a pull request)`);
  if (!isGraph(branch)) return verdict('deny', 'graph.pr_create', 'outside_worktree', 'the working directory is not a worktree on a graph/<key> branch');
  if (head !== branch) return verdict('deny', 'graph.pr_create', 'branch_mismatch', `the worktree has ${branch} checked out, not ${head}`);
  return verdict('allow', 'graph.pr_create', 'graph_pr_allowed', `headless worker opening a pull request from ${branch}`);
}

function land(ctx) {
  const { headless, branch } = ctx;
  if (!isGraph(branch)) return headless ? verdict('deny', 'graph.land', 'outside_worktree', 'land-pr.sh runs from a worktree on a graph/<key> branch') : null;
  if (!headless)
    return verdict('ask', 'graph.land', 'graph_land_confirm', `would merge the branch ${branch} into the main project once its automatic checks pass`);
  return verdict('allow', 'graph.land', 'graph_land_allowed', `headless worker landing ${branch}`);
}

/**
 * The pinned lander, spelled exactly: `<land-pr.sh> <pr> [flags]` or
 * `node <cache>/bin/enforcer land <pr> [flags]`, with no shell metacharacters
 * and only the land flags. Recognised before the settings guard, which would
 * otherwise deny the plugin-cache path it names.
 */
function exactLander(cmd, root) {
  if (META.test(cmd)) return false;
  const w = words(cmd);
  if (/(^|\/)land-pr\.sh$/.test(w[0] || '') && trustedLand(w[0], root)) return /^\d+$/.test(w[1] || '') && landShapeOk(w.slice(1));
  if (w[0] === 'node' && w[2] === 'land' && /\/bin\/enforcer$/.test(w[1] || '') && trustedLand(w[1], root))
    return /^\d+$/.test(w[3] || '') && landShapeOk(w.slice(3));
  return false;
}

function settings(ev, ctx, cmd) {
  const path = isFileWrite(ev) ? String(ev.input?.path ?? ev.raw?.file_path ?? ev.raw?.notebook_path ?? '') : null;
  const hit = path != null ? SETTINGS.test(path) : SETTINGS.test(cmd) && !(PLAIN_READ.test(cmd.trim()) && !META.test(cmd) && !MUTATES.test(cmd));
  if (!hit) return null;
  return ctx.headless
    ? verdict('deny', 'governor.settings', 'settings_write', 'a headless worker may not change plugin or governor settings')
    : verdict('ask', 'governor.settings', 'settings_write', "would change Enforcer's own settings");
}

// The headless-worker deny profile. Node text is untrusted, so a worker that was talked into it still
// may not touch what ships or authenticates: CI workflows, release and deploy scripts, secret files.
// A node the dispatcher marked as a (gate-approved) release node (ev.worker.release) is exempt.
const PROTECTED = DENY.protectedPaths;
function protectedPaths(ev, ctx, cmd) {
  if (!ctx.headless || ev.worker?.release) return null;
  const hit = isFileWrite(ev)
    ? PROTECTED.test(String(ev.input?.path ?? ev.raw?.file_path ?? ev.raw?.notebook_path ?? ''))
    : MUTATES.test(cmd) && words(cmd.replace(/[;&|<>()]/g, ' ')).some((w) => PROTECTED.test(w));
  return hit
    ? verdict(
        'deny',
        'graph.protected_paths',
        'protected_path',
        'a headless worker may not change CI workflows, release or deploy scripts, or secret files; a release node may',
      )
    : null;
}

// A headless worker deleting a tree INSIDE its own worktree (build output, a temp dir) is
// housekeeping, not destruction: the worktree is disposable and the dispatcher prunes it anyway.
// Measured 2026-10-06: two workers finished their work, ran `rm -rf dist` in their worktree, got
// `ask` with nobody to answer, and exited without reporting. Only the plain shape qualifies: one
// `rm` with -r and -f flags, no metacharacters, every operand a relative path (or an absolute path
// under cwd) that resolves inside cwd and is neither cwd itself nor .git. Anything else keeps the
// capability rule's ask.
const RM_TREE = /^rm\s+((?:-[a-zA-Z]+\s+|--(?:recursive|force)\s+)+)(.+)$/;
function worktreeDelete(cmd, ev, ctx) {
  if (!ctx.headless || !isGraph(ctx.branch) || META.test(cmd)) return null;
  const m = RM_TREE.exec(cmd.trim());
  if (!m) return null;
  const flags = m[1];
  if (!/(^|\s)(-[a-zA-Z]*r|--recursive)/i.test(flags) || !/(^|\s)(-[a-zA-Z]*f|--force)/.test(flags)) return null;
  const cwd = typeof ev.cwd === 'string' && ev.cwd ? ev.cwd.replace(/\/+$/, '') : null;
  if (!cwd) return null;
  const ops = words(m[2]);
  if (!ops.length) return null;
  for (const op of ops) {
    if (op.startsWith('-') || op.startsWith('~') || op.includes('$') || op.includes('*') || op.includes('?')) return null;
    const parts = (op.startsWith('/') ? op : cwd + '/' + op).split('/').filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        if (!out.length) return null;
        out.pop();
      } else out.push(part);
    }
    const abs = '/' + out.join('/');
    if (abs === cwd || !abs.startsWith(cwd + '/') || /\/\.git(\/|$)/.test(abs)) return null;
  }
  return verdict('allow', 'fs.delete_tree', 'worktree_delete_allowed', `headless worker deleting ${ops.join(' ')} inside its own worktree`);
}

/**
 * Evaluate the graph-worker rules.
 * @returns {Verdict|null} null: none of these rules has an opinion, and the
 *   capability rules and spend checks decide as they always did.
 */
export function evaluate(ev) {
  const ctx = { headless: !!ev.worker?.headless, branch: ev.worker?.branch ?? null };
  if (isFileWrite(ev)) return settings(ev, ctx, '') || protectedPaths(ev, ctx, '');
  if (!isShell(ev)) return null;
  const raw = commandOf(ev).trim();
  let folded = false;
  // the skill's `${CLAUDE_PLUGIN_ROOT:?message}` guard expands as the plain variable
  const cmd = raw
    .replace(/\$\{CLAUDE_PLUGIN_ROOT:\?[^}]*\}/, '${CLAUDE_PLUGIN_ROOT}')
    .replace(LAND_LOOKUP, (m, p) => {
      if (!trustedLand(p, ev.worker?.pluginRoot)) return m;
      folded = true;
      return 'land-pr.sh';
    })
    .replace(/\s+2>&1\s*$/, '')
    .trim();
  if (exactLander(cmd, ev.worker?.pluginRoot)) return land(ctx);
  // the lander chained to anything else: the delivery rule names it before the settings guard does
  if (ctx.headless && META.test(cmd) && /(^|\/)land-pr\.sh$/.test(words(cmd)[0] || '') && trustedLand(words(cmd)[0], ev.worker?.pluginRoot))
    return verdict('deny', 'graph.push', 'push_not_alone', 'a push, pull request or land must be the whole command, on its own');
  const s = settings(ev, ctx, cmd) || protectedPaths(ev, ctx, cmd);
  if (s) return s;
  const wd = worktreeDelete(raw, ev, ctx);
  if (wd) return wd;
  if (!(ctx.headless ? mentionsDeliveryWide(cmd) : mentionsDelivery(cmd))) return null;
  if (META.test(cmd))
    return ctx.headless ? verdict('deny', 'graph.push', 'push_not_alone', 'a push, pull request or land must be the whole command, on its own') : null;

  const w = words(cmd);
  const args = pushArgs(cmd);
  if (args) return push(args, ctx);
  if (w[0] === 'gh' && w[1] === 'pr' && w[2] === 'create') return prCreate(w.slice(3), ctx);
  if (w[0] === 'enforcer' && w[1] === 'land') {
    if (ctx.headless && !(/^\d+$/.test(w[2] || '') && landShapeOk(w.slice(2)))) return shape('enforcer land takes a pull request number and --timeout');
    return land(ctx);
  }
  const lp = /(^|\/)land-pr\.sh$/.test(w[0] || '') ? 0 : w[0] === 'bash' && /(^|\/)land-pr\.sh$/.test(w[1] || '') ? 1 : -1;
  if (lp >= 0) {
    if (ctx.headless) {
      const trusted = (folded && lp === 0 && w[0] === 'land-pr.sh') || trustedLand(w[lp], ev.worker?.pluginRoot);
      if (!trusted) return shape('land-pr.sh must resolve under the plugin root');
      if (!landShapeOk(w.slice(lp + 1))) return shape('land-pr.sh takes a pull request number and --timeout');
    }
    return land(ctx);
  }
  return ctx.headless ? shape('not a recognised push, pull request or land') : null;
}

/**
 * Whether the session has nobody to answer a prompt. The dispatcher marks its
 * workers with JEV_HOOKS_HEADLESS=1 (or ENFORCER_HEADLESS=1); `claude -p`
 * reports the sdk-cli entrypoint. Takes the environment as an argument so the core
 * stays free of process state.
 */
export function headlessFrom(env = {}) {
  return env.ENFORCER_HEADLESS === '1' || env.JEV_HOOKS_HEADLESS === '1' || String(env.CLAUDE_CODE_ENTRYPOINT || '') === 'sdk-cli';
}
