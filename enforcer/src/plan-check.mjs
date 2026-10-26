// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// `enforcer plan check <graph> [--repo-root dir]`: run each open node's acceptance commands and flag lines
// whose quoted output never appears. Per line: ok | MISMATCH (ran, literal absent; shows the real last line) | SKIPPED.
// Each result is printed as soon as it is known, with a running count on stderr. Exit 1 on MISMATCH (with --strict, also on any SKIPPED line). Each SKIPPED line gets a WARN with a hint; the run ends with a summary line.
// Only lines that fully match a shape in src/acceptance-allowlist.mjs run (no shell), in the node's repo checkout,
// 300 s each (--timeout), with a minimal env and a temporary HOME.
// Options: --repo-root <dir>, --only <node key>, --timeout <seconds>.
import { literalIn } from './literal-match.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/api/client.mjs';
import { headers, allNodes, acceptanceLint } from './preflight.mjs';
import { resolveConfig } from './config.mjs';
import { substitute } from './evidence-run.mjs'; // the one place that knows the acceptance-line rules
import { safeIdent } from './dispatch/ident.mjs';
import { ACCEPTANCE_SHAPES, allowedCommand, goTestArgv, removeTree, spawnAllowed } from './acceptance-allowlist.mjs';

/** The shared allow list (src/acceptance-allowlist.mjs); removeTree moved there with the runner. */
export { ACCEPTANCE_SHAPES, removeTree };
const CLOSED = new Set(['done', 'cancelled', 'succeeded']);

/** "<command> prints|exits ... <quoted literal>" -> {cmd, exit, literals} or null. */
export function parseLine(line) {
  const m = /^(.*?)\s+(prints|exits)\s+(.*)$/s.exec(line.trim());
  if (!m) return null;
  let cmd = m[1].trim();
  if (/^`[^`]*`$/.test(cmd)) cmd = cmd.slice(1, -1);
  const after = m[2] + ' ' + m[3];
  const literals = [];
  for (const q of after.matchAll(/`([^`]+)`|"((?:[^"\\]|\\.)+)"|'([^']+)'/g)) literals.push(q[1] ?? q[2] ?? q[3]);
  const ex = /\bexits\s+(\d+)/.exec(after);
  if (!literals.length && !ex) return null;
  return { cmd, exit: ex ? Number(ex[1]) : null, literals };
}

/** Why a command cannot run here, or null when it can. `root` is the checkout its paths must stay inside. */
export function skipReason(cmd, root = process.cwd()) {
  if (/<[^<>\s][^<>]*>/.test(cmd)) return 'placeholder in command';
  return allowedCommand(cmd, { root }).skip ?? null;
}

const PLACEHOLDERS = ['<graph>', '<n> or <pr> (in gh pr view)', '<key>', '<node-key>', '<node-id>', '<test db>'];

/** One specific, actionable hint for a line that will not be run. `note` is the checkLine skip reason. */
export function skipHint(line, note, root = process.cwd()) {
  const p = parseLine(line);
  if (/no "prints\|exits/.test(note) || !p) return 'Write it as `<command> prints \\`<literal line of real output>\\`` or `<command> exits 0`.';
  if (/placeholder/.test(note)) return `Supported placeholders: ${PLACEHOLDERS.join(', ')}.`;
  if (/not an allowed command shape/.test(note)) {
    const word = p.cmd.trim().split(/\s+/).slice(0, 2).join(' ');
    const first = word.split(' ')[0];
    const near =
      ACCEPTANCE_SHAPES.find((s) => s.name === word) ??
      ACCEPTANCE_SHAPES.find((s) => s.name.split(/[ ,]+/).includes(first) || s.usage.startsWith(first + ' ')) ??
      ACCEPTANCE_SHAPES.find((s) => s.name.startsWith(first));
    return near ? `Closest allowed shape: ${near.usage}.` : `Allowed shapes: ${ACCEPTANCE_SHAPES.map((s) => s.name).join(', ')}.`;
  }
  if (/no checkout/.test(note)) return 'Pass --repo-root <dir> pointing at the directory that holds the repo checkouts.';
  if (/timed out/.test(note)) return 'Raise --timeout <seconds> or pick a faster command.';
  return 'Quote a literal line of real output the command prints.';
}

export function checkLine(line, cwd, env, { timeoutMs = 300000, graph = '' } = {}) {
  const p = parseLine(line);
  if (!p) return { state: 'SKIPPED', note: 'no "prints|exits <literal>" form' };
  const sub = substitute(p.cmd, { graph });
  if (!sub.skip) p.cmd = sub.cmd; // `<graph>` filled in, as `enforcer evidence run` does
  if (/<[^<>\s][^<>]*>/.test(p.cmd)) return { state: 'SKIPPED', note: 'placeholder in command' };
  if (!cwd || !existsSync(cwd)) return { state: 'SKIPPED', note: `no checkout at ${cwd}` };
  const ok = allowedCommand(p.cmd, { root: cwd, env });
  if (ok.skip) return { state: 'SKIPPED', note: ok.skip };
  const r = spawnAllowed(goTestArgv(ok.argv, p.literals), { cwd, env, timeoutMs });
  if (r.timedOut) return { state: 'SKIPPED', note: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (r.error) return { state: 'SKIPPED', note: `could not run: ${r.error.message}` };
  const out = r.out;
  const last =
    out
      .split('\n')
      .map((s) => s.trimEnd())
      .filter(Boolean)
      .at(-1) ?? '(no output)';
  const missing = p.literals.filter((l) => !literalIn(out, l));
  if (p.exit !== null && r.exit !== p.exit) return { state: 'MISMATCH', note: `exit ${r.exit}, expected ${p.exit}; last line: ${last}` };
  if (missing.length) return { state: 'MISMATCH', note: `output never contains ${missing.map((l) => JSON.stringify(l)).join(', ')}; last line: ${last}` };
  return { state: 'ok', note: '' };
}

/** Server-side advisory lint (one ruleset, enforcer-graph POST /graphs/{id}/acceptance/lint). Never fatal: [] on any failure. */
export async function serverLint(base, graph, h, acceptance) {
  try {
    const b = await request(
      `${base}/graphs/${encodeURIComponent(graph)}/acceptance/lint`,
      {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify({ acceptance }),
      },
      { retries: 0 },
    );
    return Array.isArray(b?.warnings) ? b.warnings : Array.isArray(b?.data?.warnings) ? b.data.warnings : [];
  } catch {
    return [];
  }
}

/** Returns {code, lines}. `onLine(text, {done, total})` is called with each line as soon as it is known. */
export async function planCheck({
  graph,
  repoRoot = join(homedir(), 'apps'),
  env = process.env,
  only = null,
  timeoutMs = 300000,
  strict = false,
  allowLintWarnings = false,
  onLine = () => {},
} = {}) {
  const base = resolveConfig({ env }).graphUrl;
  const h = await headers(env);
  const nodes = (await allNodes(base, graph, h)).filter((n) => !CLOSED.has(n.status) && (!only || n.key === only));
  const accOf = (n) => {
    const a = n.data?.acceptance;
    return Array.isArray(a) ? a : a ? [a] : [];
  };
  const total = nodes.reduce((k, n) => k + accOf(n).length, 0);
  const lines = [];
  let bad = 0,
    ok = 0,
    skipped = 0;
  const emit = (text) => {
    lines.push(text);
    onLine(text, { done: lines.filter((l) => !l.startsWith('WARN ')).length, total });
  };
  for (const n of nodes) {
    const accs = accOf(n);
    const warns = accs.length ? await serverLint(base, graph, h, accs.map(String)) : [];
    for (const [i, a] of accs.entries()) {
      await new Promise((r) => setImmediate(r)); // let the previous line reach the reader before the next command blocks
      if (n.data?.repo && !safeIdent(n.data.repo)) {
        skipped++;
        emit(`SKIPPED ${n.key}: ${String(a).replace(/\s+/g, ' ').slice(0, 100)} -- data.repo is not a safe name`);
        emit(`WARN ${n.key}: data.repo ${JSON.stringify(String(n.data.repo))} does not match ^[A-Za-z0-9._-]+$; line ${i} was not run`);
        continue;
      }
      const cwd = n.data?.repo ? join(repoRoot, n.data.repo) : repoRoot;
      const r = checkLine(String(a), cwd, env, { timeoutMs, graph });
      if (r.state === 'MISMATCH') bad++;
      else if (r.state === 'ok') ok++;
      else skipped++;
      emit(`${r.state} ${n.key}: ${String(a).replace(/\s+/g, ' ').slice(0, 100)}${r.note ? ' -- ' + r.note : ''}`);
      if (r.state === 'SKIPPED')
        emit(`WARN ${n.key}: line ${i} will not be run (${r.note}); the judge will see only the worker's own output. ${skipHint(String(a), r.note, cwd)}`);
      for (const w of warns.filter((w) => w.index === i)) emit(`WARN ${n.key}: [${w.code}] ${w.hint ?? ''}`.trimEnd());
    }
  }
  try {
    const found = await acceptanceLint(base, graph, h, nodes);
    for (const f of found) emit(`${allowLintWarnings ? 'WARN' : 'LINT'} ${f}`);
    if (found.length && !allowLintWarnings) bad += found.length;
  } catch (e) {
    emit(`WARN acceptance lint unavailable: ${e.message}`);
  }
  try {
    const ctx = await request(`${base}/graphs/${encodeURIComponent(graph)}/context`, { headers: h }, { retries: 0 });
    const d = ctx?.data ?? ctx;
    if (!d?.pack?.sha256)
      emit(`WARN graph ${graph}: no context pack; workers start without the graph's shared context (build it, or ignore for a one-off plan)`);
  } catch {}
  emit(`plan check: ${ok} runnable, ${skipped} will not be run, ${bad} mismatch`);
  return { code: bad || (strict && skipped) ? 1 : 0, lines, ok, skipped, mismatch: bad };
}

export async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valued = new Set(['--repo-root', '--only', '--timeout']);
  const graph = argv.find((a, i) => !a.startsWith('-') && !valued.has(argv[i - 1]));
  if (!graph) {
    process.stderr.write('usage: enforcer plan check <graph> [--repo-root dir] [--only <node key>] [--timeout <seconds>] [--strict] [--allow-lint-warnings]\n');
    return 2;
  }
  const secs = opt('--timeout') === undefined ? 300 : Number(opt('--timeout'));
  if (!(secs > 0)) {
    process.stderr.write('enforcer plan check: --timeout must be a positive number of seconds\n');
    return 2;
  }
  try {
    const { code } = await planCheck({
      graph,
      only: opt('--only') ?? null,
      timeoutMs: secs * 1000,
      strict: argv.includes('--strict'),
      allowLintWarnings: argv.includes('--allow-lint-warnings'),
      ...(opt('--repo-root') ? { repoRoot: opt('--repo-root') } : {}),
      onLine: (text, { done, total }) => {
        process.stdout.write(text + '\n');
        if (!text.startsWith('WARN ') && !text.startsWith('plan check:')) process.stderr.write(`[${done}/${total}]\n`);
      },
    });
    return code;
  } catch (e) {
    process.stderr.write(`enforcer plan check: ${e.message}\n`);
    return 2;
  }
}
