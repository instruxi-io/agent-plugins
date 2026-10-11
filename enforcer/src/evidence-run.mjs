// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// `enforcer evidence run <graph>:<node-key|id> [--graph <id>] [--cwd dir] [--only <index>] [--timeout <s>] [--test-db <url>]`
//
// One place for the rules every completion path (a worker before graph_report, the dispatcher's landing completion,
// a coordinator, `plan check`) re-learned the hard way before the judge accepted their evidence:
//   - run each `<command> prints|exits ...` acceptance line that fully matches a shape in src/acceptance-allowlist.mjs,
//     without a shell, with a minimal environment, a temporary HOME and a timeout; any other line is not run;
//   - the judge reads the evidence, not the repository, so quote the literal output: head and tail of the output, and
//     the line holding a quoted literal when the clip would drop it;
//   - Go tests need `-tags integration -run <Name> -v` so `--- PASS: <Name>` appears;
//   - substitute `<graph>` (and `<test db>`, `<key>`, `<node-id>`); a line with any other placeholder is skipped;
//   - run from --cwd (the checkout); `cd` is never allowed, a line names its directory (`npm --prefix`, `go -C`);
//   - retry a suite once when it collides with a concurrent run (port in use, locked database);
//   - skip the PR (gh) and prose lines: those are proved by the delivery step, not by a command here.
// Output: one JSON evidence item per command run ({kind:'command', cmd, exit, output, line_index}), skipped lines on
// stderr, then `literals found: <k>/<n>`. Exit 0 when every quoted literal was found, 1 when one was not, 2 on usage or
// a node that cannot be loaded. `line_index` is the 0-based position in the node's acceptance list.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCEPTANCE_SHAPES, allowedCommand, goTestArgv, spawnAllowed } from './acceptance-allowlist.mjs';
import { parseLine } from './plan-check.mjs';
import { literalIn, matchingLine } from './literal-match.mjs';
import { spawnSync } from 'node:child_process';
import { headers, allNodes } from './preflight.mjs';
import { resolveConfig } from './config.mjs';

/** The shared allow list (src/acceptance-allowlist.mjs): the only commands an acceptance line can run as. */
export { ACCEPTANCE_SHAPES };
export const COLLISION =
  /EADDRINUSE|address already in use|database is locked|SQLITE_BUSY|deadlock detected|could not obtain lock|resource temporarily unavailable|text file busy|ETXTBSY|port is already allocated|being accessed by other users/i;

/** The node's acceptance lines as an array of strings. */
export const acceptanceOf = (node) => {
  const a = node?.data?.acceptance;
  return (Array.isArray(a) ? a : a ? [a] : []).map(String);
};

/** Add the flags a Go test line needs for `--- PASS: <Name>` to appear. */
export function goTestFlags(cmd, literals) {
  if (!/\bgo test\b/.test(cmd)) return cmd;
  const names = [...new Set(literals.flatMap((l) => [...l.matchAll(/--- PASS: ([A-Za-z0-9_]+)/g)].map((m) => m[1])))];
  if (!names.length) return cmd;
  const add = [];
  if (!/(^|\s)-tags[ =]/.test(cmd)) add.push('-tags integration');
  if (!/(^|\s)-(test\.)?v(\s|$)/.test(cmd)) add.push('-v');
  if (!/(^|\s)-run[ =]/.test(cmd)) add.push(`-run '^(${names.join('|')})$'`);
  return add.length ? cmd.replace(/\bgo test\b/, () => `go test ${add.join(' ')}`) : cmd;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The default pull request lookup: `gh pr list -R <repo> --head graph/<key> --state all --json number --limit 1`, fixed
 *  argv, no shell. Returns the number or null. */
export function ghPrLookup(repo, nodeKey, { run = spawnSync } = {}) {
  const r = run('gh', ['pr', 'list', '-R', repo, '--head', `graph/${nodeKey}`, '--state', 'all', '--json', 'number', '--limit', '1'], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  if (r.error || r.status !== 0) return null;
  try {
    const n = JSON.parse(r.stdout || '[]')?.[0]?.number;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The pull request number for `<n>` / `<pr>`: an explicit value (the `--pr` flag, then ENFORCER_EVIDENCE_PR) wins; else
 *  the owner/repo is taken from the line's own `-R <owner/repo>` (validated) and looked up by branch.
 *  Returns {n} or {skip: reason}. */
export function resolvePr(cmd, { nodeKey, pr, env = process.env, lookup = ghPrLookup }) {
  const explicit = pr ?? env.ENFORCER_EVIDENCE_PR;
  if (explicit !== undefined && explicit !== '') {
    return /^\d+$/.test(String(explicit)) ? { n: String(explicit) } : { skip: `invalid pull request number ${JSON.stringify(String(explicit))}` };
  }
  const m = /(?:^|\s)(?:-R|--repo)\s+(\S+)/.exec(cmd);
  if (!m || !REPO_RE.test(m[1])) return { skip: 'no valid -R <owner/repo> on the line to look up the pull request' };
  if (!nodeKey || !/^[A-Za-z0-9_.-]+$/.test(String(nodeKey))) return { skip: 'no node key to look up the pull request' };
  const n = lookup(m[1], nodeKey);
  return n ? { n: String(n) } : { skip: `no pull request for graph/${nodeKey} yet` };
}

/** Substitute placeholders. Returns {cmd, resolvedPr?} or {skip: reason}. */
export function substitute(cmd, { graph, nodeKey, nodeId, testDb, pr, env, lookup }) {
  const values = { graph, 'test db': testDb, key: nodeKey, 'node-key': nodeKey, 'node-id': nodeId };
  let skip = null,
    resolvedPr = false;
  const out = cmd.replace(/<([^<>\s][^<>]*)>/g, (all, name) => {
    const k = name.trim();
    if ((k === 'n' || k === 'pr') && /^gh\s+pr\s+view\s/.test(cmd.trim())) {
      const r = resolvePr(cmd, { nodeKey, pr, env, lookup });
      if (r.n) {
        resolvedPr = true;
        return r.n;
      }
      skip ??= r.skip;
      return all;
    }
    const v = values[k];
    if (v) return v;
    skip ??= values[k] === undefined && !(k in values) ? `placeholder ${all}` : `no value for ${all}`;
    return all;
  });
  return skip ? { skip } : { cmd: out, resolvedPr };
}

/** Prepare one acceptance line: {cmd, argv, cwd, literals, exit} to run, or {skip}. Pure. `cwd` is the checkout every
 *  path in the line must resolve inside. */
export function prepareLine(line, { cwd, graph, nodeKey, nodeId, testDb, pr, env, lookup }) {
  let p = parseLine(line);
  if (!p) {
    // `<command> prints the file` quotes nothing, but the command's output is still the evidence
    const m = /^(.*?)\s+prints\s+/s.exec(line.trim());
    if (!m) return { skip: 'no "prints|exits <literal>" form' };
    p = { cmd: m[1].trim().replace(/^`([^`]*)`$/, '$1'), exit: null, literals: [] };
  }
  let cmd = p.cmd;
  const sub = substitute(cmd, { graph, nodeKey, nodeId, testDb, pr, env, lookup });
  if (sub.skip) return { skip: sub.skip };
  cmd = sub.cmd;
  if (/(^|[\s;&|(])(\S*bin\/enforcer|enforcer)\s+evidence\s+run\b/.test(cmd)) return { skip: 'would run itself' };
  if (!sub.resolvedPr && (/(^|[\s;&|(])gh\s/.test(cmd) || /\bpull request\b/i.test(line))) return { skip: 'PR line: proved by the delivery step' };
  const ok = allowedCommand(cmd, { root: cwd, env });
  if (ok.skip) return { skip: ok.skip };
  return { cmd: goTestFlags(cmd, p.literals), argv: goTestArgv(ok.argv, p.literals), cwd, literals: p.literals, exit: p.exit };
}

const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Head and tail of the output, plus the line holding any quoted literal the clip dropped. */
export function clipEvidence(out, literals = []) {
  const text = out.trim();
  let clipped = text.length > 3000 ? text.slice(0, 1200) + '\n...\n' + text.slice(-1800) : text;
  if (clipped !== text) {
    for (const l of literals) {
      const hit = matchingLine(text, l);
      if (!hit || clipped.includes(hit)) continue;
      if (hit) clipped += `\n[match] ${hit.slice(0, 300)}`;
    }
  }
  return clipped;
}

/** Run a prepared line (no shell, minimal env, temporary HOME); retry once on a collision. */
export function runPrepared(p, { env = process.env, timeoutMs = 600000, retryDelayMs = 2000, run } = {}) {
  const once = () => spawnAllowed(p.argv, { cwd: p.cwd, env, timeoutMs, ...(run ? { run } : {}) });
  let r = once(),
    retried = false;
  if (r.exit !== 0 && !r.timedOut && COLLISION.test(r.out)) {
    retried = true;
    sleep(retryDelayMs);
    r = once();
  }
  return { exit: r.exit, out: r.out, retried };
}

/** Run a node's acceptance lines. Returns {items, skipped, found, total, retried}. */
export function runEvidence(
  node,
  {
    cwd = process.cwd(),
    graph = '',
    only = null,
    env = process.env,
    timeoutMs,
    retryDelayMs,
    pr,
    lookup,
    testDb = env.ENFORCER_TEST_DB || env.TEST_DATABASE_URL || '',
    run,
  } = /** @type {any} */ ({}),
) {
  const items = [],
    skipped = [],
    retried = [];
  let found = 0,
    total = 0;
  acceptanceOf(node).forEach((line, i) => {
    if (only !== null && i !== only) return;
    const p = prepareLine(line, { cwd, graph, nodeKey: node.key, nodeId: node.node_id ?? node.id, testDb, pr, env, lookup });
    if (p.skip) {
      skipped.push({ line_index: i, reason: p.skip });
      return;
    }
    if (!existsSync(p.cwd)) {
      skipped.push({ line_index: i, reason: `no directory ${p.cwd}` });
      return;
    }
    const r = runPrepared(p, { env, timeoutMs, retryDelayMs, run });
    if (r.retried) retried.push(i);
    total += p.literals.length;
    found += p.literals.filter((l) => literalIn(r.out, l)).length;
    items.push({ kind: 'command', cmd: p.cmd, exit: r.exit, output: clipEvidence(r.out, p.literals), line_index: i });
  });
  return { items, skipped, found, total, retried };
}

/** Find a node by key or id in a graph. */
export async function loadNode(graph, ref, env = process.env) {
  const base = resolveConfig({ env }).graphUrl;
  const nodes = await allNodes(base, graph, await headers(env));
  const node = nodes.find((n) => n.key === ref || n.node_id === ref || n.id === ref);
  if (!node) throw new Error(`no node ${ref} in graph ${graph}`);
  return node;
}

const USAGE = 'usage: enforcer evidence run <graph>:<node-key|id> [--graph <id>] [--cwd dir] [--only <index>] [--timeout <seconds>] [--test-db <url>]\n';

export async function main(argv, env = process.env) {
  if (argv[0] !== 'run') {
    process.stderr.write(USAGE);
    return 2;
  }
  const rest = argv.slice(1);
  const valued = new Set(['--graph', '--cwd', '--only', '--timeout', '--test-db', '--pr']);
  const opt = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const target = rest.find((a, i) => !a.startsWith('-') && !valued.has(rest[i - 1]));
  if (!target) {
    process.stderr.write(USAGE);
    return 2;
  }
  let graph = opt('--graph'),
    ref = target;
  const m = /^([^:]+):(.+)$/.exec(target);
  if (m && !graph) [, graph, ref] = m;
  if (!graph) {
    process.stderr.write('enforcer evidence run: name the graph as <graph>:<node> or --graph <id>\n' + USAGE);
    return 2;
  }
  const secs = opt('--timeout') === undefined ? 600 : Number(opt('--timeout'));
  const only = opt('--only') === undefined ? null : Number(opt('--only'));
  if (!(secs > 0) || (only !== null && !(Number.isInteger(only) && only >= 0))) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const node = await loadNode(graph, ref, env);
    const r = runEvidence(node, {
      cwd: resolve(opt('--cwd') ?? '.'),
      graph,
      only,
      env,
      ...(opt('--pr') ? { pr: opt('--pr') } : {}),
      timeoutMs: secs * 1000,
      ...(opt('--test-db') ? { testDb: opt('--test-db') } : {}),
    });
    for (const it of r.items) process.stdout.write(JSON.stringify(it) + '\n');
    for (const s of r.skipped) process.stderr.write(`SKIPPED line ${s.line_index}: ${s.reason}\n`);
    for (const i of r.retried) process.stderr.write(`line ${i} collided with a concurrent run and was retried once\n`);
    process.stdout.write(`literals found: ${r.found}/${r.total}\n`);
    return r.found < r.total ? 1 : 0;
  } catch (e) {
    process.stderr.write(`enforcer evidence run: ${e.message}\n`);
    return 2;
  }
}
