// The one list of command shapes an acceptance line may run as. Acceptance lines come from the graph, and graph content
// can be written by other people, so a line is NOT run because it "looks read-only": it runs only when it fully matches
// one of ACCEPTANCE_SHAPES below, argument by argument. Every caller that runs acceptance lines uses this module:
// `enforcer evidence run` (src/evidence-run.mjs), `enforcer plan check` (src/plan-check.mjs), the report hook
// (src/graph/hooks/attach.mjs, through runEvidence) and the dispatcher's landing completion (src/dispatch/land-complete.mjs).
//
// The rules (documented in docs/graph/README.md, "Which acceptance lines run"):
//   - no shell: the line is split into argv here and spawned directly (shell: false);
//   - no shell metacharacters anywhere outside a single-quoted token: ; | & < > $ ` ( ) { } newline, double quotes,
//     backslash. A whole token in single quotes is a literal (a grep pattern, a go -run regex); it never reaches a shell;
//   - every path argument resolves inside the checkout (symlinks followed), `cd` is never allowed;
//   - each shape names its flags; any other flag is refused (no `-e`, no `-exec`, no `-o`, no `--output`);
//   - an allowed line runs with a minimal environment and a temporary HOME that is removed afterwards;
//   - one exception to "no $": a count threshold `test $(<count>) -ge|-gt|-le|-lt|-eq|-ne <integer>`, where <count> is
//     `grep -c ... <one path>` or `wc -l|-c|-w|-m <one path>` (or `wc ... < <one path>`). Nothing reaches a shell: the
//     inner command must itself match a shape, runs as argv, and the comparison is done here (COUNT_TEST, runCount).
// Anything else is reported as SKIP_REASON and the judge reads the worker's own captured output instead.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SKIP_REASON = 'not run: not an allowed command shape';

/** Characters that mean something to a shell. Refused outside a single-quoted token. */
export const META = /[;|&<>$`(){}\n\r"'\\]/;

/** Split a command into argv without a shell. Returns {argv} or {error}. A trailing `2>&1` is dropped (output is
 *  always captured from both streams). A token wholly inside single quotes is taken literally. */
export function tokenize(cmd) {
  const s = String(cmd)
    .trim()
    .replace(/[ \t]+2>&1$/, '');
  if (/[\n\r\0]/.test(s)) return { error: 'newline in the command' };
  const argv = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') {
      i++;
      continue;
    }
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return { error: 'unclosed quote' };
      if (end + 1 < s.length && s[end + 1] !== ' ' && s[end + 1] !== '\t') return { error: 'quote joined to other text' };
      argv.push(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== ' ' && s[j] !== '\t') j++;
    const tok = s.slice(i, j);
    if (META.test(tok)) return { error: `shell metacharacter in ${JSON.stringify(tok.slice(0, 40))}` };
    argv.push(tok);
    i = j;
  }
  return argv.length ? { argv } : { error: 'empty command' };
}

const outside = (rel) => rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);

/** True when `p` names a path inside the checkout `root` (following symlinks of whatever exists). */
export function inRepo(p, root, base = root) {
  if (typeof p !== 'string' || !p || p.startsWith('-') || META.test(p)) return false;
  const abs = resolve(base, p);
  if (outside(relative(resolve(root), abs))) return false;
  try {
    const real = realpathSync(abs);
    if (outside(relative(realpathSync(root), real))) return false;
  } catch {
    /* a path that does not exist yet cannot escape through a symlink */
  }
  return true;
}

/** A plain argument: no metacharacter, no whitespace, not empty. */
const plain = (t) => typeof t === 'string' && t.length > 0 && !META.test(t) && !/\s/.test(t);
/** A literal pattern (grep, git grep): anything but a newline, and not an option. */
const pattern = (t) => typeof t === 'string' && t.length > 0 && !t.startsWith('-') && !/[\n\r\0]/.test(t);
const paths = (list, root, base) => list.every((p) => inRepo(p, root, base));

const NPM_SCRIPTS = new Set(['test', 'lint', 'format:check', 'typecheck']);
const GO_BOOL = /^-(v|race|short|cover|failfast|json)$/;
const GO_VALUED = { '-count': /^\d+$/, '-p': /^\d+$/, '-run': /^[^-\n].*$/, '-tags': /^[A-Za-z0-9_,.]+$/, '-timeout': /^\d+[a-z]*$/ };

/** `go [-C <dir>] test|vet <flags and packages>`: packages are `./...`-style paths inside the checkout. */
function goShape(a, root, sub, allowFlags) {
  if (a[0] !== 'go') return false;
  let i = 1,
    dir = root;
  if (a[1] === '-C') {
    if (!inRepo(a[2], root)) return false;
    dir = resolve(root, a[2]);
    i = 3;
  }
  if (a[i] !== sub) return false;
  let pkgs = 0;
  for (i++; i < a.length; i++) {
    const t = a[i];
    if (t.startsWith('-')) {
      if (!allowFlags) return false;
      if (GO_BOOL.test(t)) continue;
      const eq = t.indexOf('=');
      const name = eq > 0 ? t.slice(0, eq) : t;
      const re = GO_VALUED[name];
      if (!re) return false;
      const value = eq > 0 ? t.slice(eq + 1) : a[++i];
      if (value === undefined || !re.test(value)) return false;
      continue;
    }
    if (!(t === '.' || t.startsWith('./')) || !inRepo(t.replace(/\/\.\.\.$/, '') || '.', root, dir)) return false;
    pkgs++;
  }
  return pkgs > 0;
}

/** `<tool> [flags matching re] <paths>`; `min` paths at least. */
const flagged = (tool, re, min) => (a, root) => {
  if (a[0] !== tool) return false;
  let i = 1;
  while (i < a.length && a[i].startsWith('-')) if (!re.test(a[i++])) return false;
  return a.length - i >= min && paths(a.slice(i), root);
};

/** grep's max-count, the one valued flag a grep shape takes: `-m N`, `-mN` or `--max-count=N`. Returns the number of
 *  tokens it uses at `a[i]` (0 when it is not one). */
function maxCount(a, i) {
  if (/^-m\d+$/.test(a[i]) || /^--max-count=\d+$/.test(a[i])) return 1;
  if (a[i] === '-m' && /^\d+$/.test(a[i + 1] ?? '')) return 2;
  return 0;
}

/** `grep|git grep [flags] [-m N] <pattern> [--] <paths>` */
function grepShape(a, root, lead, re, minPaths) {
  for (let k = 0; k < lead.length; k++) if (a[k] !== lead[k]) return false;
  let i = lead.length;
  while (i < a.length && a[i].startsWith('-') && a[i] !== '--') {
    const m = maxCount(a, i);
    if (m) {
      i += m;
      continue;
    }
    if (!re.test(a[i++])) return false;
  }
  if (!pattern(a[i])) return false;
  i++;
  if (a[i] === '--') i++;
  return a.length - i >= minPaths && paths(a.slice(i), root);
}

/**
 * THE allow list. Each entry: `name`, the `usage` it documents, and `match(argv, root)`, true only when every argument
 * fits. Frozen: callers read it, nobody extends it at run time.
 */
export const ACCEPTANCE_SHAPES = Object.freeze(
  [
    {
      name: 'node --test',
      usage: 'node --test <path under the repo>...',
      match: (a, root) => a[0] === 'node' && a[1] === '--test' && a.length > 2 && paths(a.slice(2), root),
    },
    {
      name: 'node script',
      usage: 'node <script .js|.mjs|.cjs under the repo> [plain args]',
      match: (a, root) => a[0] === 'node' && /\.[cm]?js$/.test(a[1] ?? '') && inRepo(a[1], root) && a.slice(2).every(plain),
    },
    {
      name: 'npm test',
      usage: 'npm [--prefix <dir>] test | npm [--prefix <dir>] run <test|lint|format:check|typecheck>',
      match: (a, root) => {
        if (a[0] !== 'npm') return false;
        let i = 1;
        if (a[1] === '--prefix') {
          if (!inRepo(a[2], root)) return false;
          i = 3;
        }
        const rest = a.slice(i);
        return (rest.length === 1 && rest[0] === 'test') || (rest.length === 2 && rest[0] === 'run' && NPM_SCRIPTS.has(rest[1]));
      },
    },
    {
      // pnpm takes the same read-only scripts as npm; `pnpm generate`, `pnpm build` or any other script stays refused.
      name: 'pnpm test',
      usage: 'pnpm [-C <dir>] [--filter <package>] <test|lint|format:check|typecheck> | pnpm [-C <dir>] [--filter <package>] run <same>',
      match: (a, root) => {
        if (a[0] !== 'pnpm') return false;
        let i = 1;
        for (;;) {
          if (a[i] === '-C' || a[i] === '--dir') {
            if (!inRepo(a[i + 1], root)) return false;
            i += 2;
          } else if (a[i] === '--filter' || a[i] === '-F') {
            if (!plain(a[i + 1]) || a[i + 1].startsWith('-')) return false;
            i += 2;
          } else break;
        }
        const rest = a.slice(i);
        return (rest.length === 1 && NPM_SCRIPTS.has(rest[0])) || (rest.length === 2 && rest[0] === 'run' && NPM_SCRIPTS.has(rest[1]));
      },
    },
    {
      name: 'go test',
      usage: 'go [-C <dir>] test <./pkg/...> [-v -race -short -cover -failfast -json -count -p -run -tags -timeout]',
      match: (a, root) => goShape(a, root, 'test', true),
    },
    { name: 'go vet', usage: 'go [-C <dir>] vet <./pkg/...>', match: (a, root) => goShape(a, root, 'vet', false) },
    { name: 'ls', usage: 'ls [-1aAlRdhFtrS] [relative path]...', match: flagged('ls', /^-[1aAlRdhFtrS]+$/, 0) },
    { name: 'cat', usage: 'cat <relative path>...', match: flagged('cat', /^-n$/, 1) },
    { name: 'head', usage: 'head [-n N | -N] <relative path>...', match: (a, root) => headTail('head', a, root) },
    { name: 'tail', usage: 'tail [-n N | -N] <relative path>...', match: (a, root) => headTail('tail', a, root) },
    { name: 'wc', usage: 'wc [-l|-c|-w|-m] <relative path>...', match: flagged('wc', /^-[lcwm]+$/, 1) },
    {
      name: 'test',
      usage: 'test -f|-d|-e|-s <relative path> | test $(grep -c <literal> <path>) -ge N | test $(wc -l|-c <path>) -le N',
      match: (a, root) => a.length === 3 && a[0] === 'test' && /^-[fdes]$/.test(a[1]) && inRepo(a[2], root),
    },
    {
      name: 'grep',
      usage: 'grep [-cnilEFwvxrhHqo] [-m N] <literal> <relative path>...',
      match: (a, root) => grepShape(a, root, ['grep'], /^-[cnilEFwvxrhHqo]+$/, 1),
    },
    {
      name: 'git grep',
      usage: 'git grep [-nciElwvFIhq] [-m N] <literal> [--] [relative path]...',
      match: (a, root) => grepShape(a, root, ['git', 'grep'], /^-[nciElwvFIhq]+$/, 0),
    },
    {
      name: 'git merge-base --is-ancestor',
      usage: 'git merge-base --is-ancestor <sha> <ref>',
      match: (a) =>
        a.length === 5 &&
        a[0] === 'git' &&
        a[1] === 'merge-base' &&
        a[2] === '--is-ancestor' &&
        /^[0-9a-f]{7,64}$/.test(a[3]) &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(a[4]),
    },
    {
      name: 'gh pr view',
      usage: 'gh pr view <n> [-R <owner/repo>] [--json <fields>]',
      match: (a) => {
        if (a[0] !== 'gh' || a[1] !== 'pr' || a[2] !== 'view' || !/^\d+$/.test(a[3] ?? '')) return false;
        for (let i = 4; i < a.length; i += 2) {
          const v = a[i + 1] ?? '';
          if ((a[i] === '-R' || a[i] === '--repo') && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) continue;
          if (a[i] === '--json' && /^[A-Za-z]+(,[A-Za-z]+)*$/.test(v)) continue;
          return false;
        }
        return true;
      },
    },
  ].map((s) => Object.freeze(s)),
);

function headTail(tool, a, root) {
  if (a[0] !== tool) return false;
  let i = 1;
  if (a[1] === '-n' && /^\d+$/.test(a[2] ?? '')) i = 3;
  else if (/^-\d+$/.test(a[1] ?? '')) i = 2;
  return a.length > i && paths(a.slice(i), root);
}

/** The count threshold: `test $(<count>) <op> <integer>`. The inner command may not hold a parenthesis, `$` or a
 *  backtick, so nothing nests. */
export const COUNT_TEST = /^test\s+\$\(\s*([^()$`]+?)\s*\)\s+(-eq|-ne|-gt|-ge|-lt|-le)\s+(\d{1,15})$/;
/** argv[0] of a count threshold: a NUL cannot come out of tokenize, so no line can name it directly. */
export const COUNT_ARGV0 = '\0count';
const COUNT_OPS = {
  '-eq': (a, b) => a === b,
  '-ne': (a, b) => a !== b,
  '-gt': (a, b) => a > b,
  '-ge': (a, b) => a >= b,
  '-lt': (a, b) => a < b,
  '-le': (a, b) => a <= b,
};

/** The inner command of a count threshold, as argv, when it is `grep -c ... <one path>` or `wc -l|-c|-w|-m <one path>`;
 *  `wc <flag> < <path>` is read as `wc <flag> <path>`. Else null. */
function countInner(inner, root) {
  const redirect = /^wc\s+(-[lcwm])\s+<\s*(\S+)$/.exec(inner.trim());
  const t = tokenize(redirect ? `wc ${redirect[1]} ${redirect[2]}` : inner);
  if (t.error) return null;
  const a = t.argv;
  if (a[0] === 'wc') return a.length === 3 && /^-[lcwm]$/.test(a[1]) && inRepo(a[2], root) ? a : null;
  // no -r: grep -c over one file prints one bare number
  if (a[0] !== 'grep' || !grepShape(a, root, ['grep'], /^-[cnilEFwvxhHo]+$/, 1)) return null;
  let i = 1,
    counts = false;
  while (a[i].startsWith('-') && a[i] !== '--') {
    const m = maxCount(a, i);
    if (!m && a[i].includes('c')) counts = true;
    i += m || 1;
  }
  i++; // the pattern
  if (a[i] === '--') i++;
  return counts && a.length - i === 1 ? a : null;
}

/** Decide one command: {argv, shape} when it fully matches a shape, else {skip: SKIP_REASON + why}. */
export function allowedCommand(cmd, { root = process.cwd(), env = process.env } = {}) {
  const c = COUNT_TEST.exec(String(cmd).trim());
  if (c) {
    const inner = countInner(c[1], root);
    if (!inner) return { skip: `${SKIP_REASON} (count threshold: only grep -c or wc -l|-c|-w|-m on one path)` };
    return { argv: [COUNT_ARGV0, c[2], c[3], ...inner], shape: 'count threshold' };
  }
  const t = tokenize(cmd);
  if (t.error) return { skip: `${SKIP_REASON} (${t.error})` };
  const shape = ACCEPTANCE_SHAPES.find((s) => s.match(t.argv, root));
  if (!shape) return { skip: `${SKIP_REASON} (${t.argv[0]})` };
  if (shape.name === 'gh pr view' && !ghToken(env)) return { skip: 'no GH_TOKEN for gh' };
  return { argv: t.argv, shape: shape.name };
}

/** The operator's GitHub token for the read-only `gh pr view` shape, or ''. */
const ghToken = (env) => env?.GH_TOKEN || env?.GITHUB_TOKEN || '';

/** Add the flags a Go test needs for `--- PASS: <Name>` to appear, as argv (the string form is evidence-run's goTestFlags). */
export function goTestArgv(argv, literals = []) {
  const at = argv[0] === 'go' ? argv.indexOf('test') : -1;
  if (at < 0) return argv;
  const names = [...new Set(literals.flatMap((l) => [...l.matchAll(/--- PASS: ([A-Za-z0-9_]+)/g)].map((m) => m[1])))];
  if (!names.length) return argv;
  const has = (f) => argv.some((t) => t === f || t.startsWith(f + '='));
  const add = [];
  if (!has('-tags')) add.push('-tags', 'integration');
  if (!has('-v') && !has('-test.v')) add.push('-v');
  if (!has('-run')) add.push('-run', `^(${names.join('|')})$`);
  return [...argv.slice(0, at + 1), ...add, ...argv.slice(at + 1)];
}

const PASS_ENV = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'GOPATH',
  'GOCACHE',
  'GOMODCACHE',
  'GOROOT',
  'GOFLAGS',
  'GOPROXY',
  'GOTOOLCHAIN',
]);

/** The minimal environment an allowed line runs with: PATH, locale, the Go cache locations, and `home` as HOME. No
 *  credential, no token, no NODE_OPTIONS reaches the command. */
export function isolatedEnv(env, home, { gh = false } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (v !== undefined && PASS_ENV.has(k.toUpperCase())) out[k] = v;
  const realHome = env?.HOME || env?.USERPROFILE || homedir();
  // the Go module and build caches stay where they were: they hold downloaded code and build output, not credentials
  if (!('GOMODCACHE' in out)) out.GOMODCACHE = join(env?.GOPATH || join(realHome, 'go'), 'pkg', 'mod');
  if (!('GOFLAGS' in out)) out.GOFLAGS = '-modcacherw';
  // only the read-only `gh pr view` shape gets the operator's token and gh config dir; nothing else does
  if (gh) {
    if (ghToken(env)) out.GH_TOKEN = ghToken(env);
    if (env?.GH_CONFIG_DIR) out.GH_CONFIG_DIR = env.GH_CONFIG_DIR;
  }
  return { ...out, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, GIT_PAGER: 'cat', PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1' };
}

/** Remove a temp tree for good: Go writes its module cache 0444 inside 0555 directories, which rm cannot unlink
 *  until the tree is made writable. Never throws. */
export function removeTree(dir) {
  const attempt = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      return !existsSync(dir);
    } catch {
      return false;
    }
  };
  if (attempt()) return true;
  const walk = (d) => {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(d, n);
      try {
        const st = lstatSync(f);
        if (st.isDirectory()) walk(f);
        else if (!st.isSymbolicLink()) chmodSync(f, 0o600);
      } catch {
        /* best effort */
      }
    }
  };
  walk(dir);
  return attempt();
}

/** Run a count threshold: the inner command (an allowed grep -c / wc), then the comparison. Exit 0 when it holds, 1 when
 *  it does not, 2 when the inner command failed or printed no number. The output keeps the inner command's own output
 *  and adds the comparison, so the judge reads the number. */
export function runCount(argv, opts) {
  const [, op, limit, ...inner] = argv;
  const r = spawnAllowed(inner, opts);
  if (r.timedOut || r.error) return r;
  const out = r.out.trim();
  // grep -c exits 1 when it counts 0; only an exit above 1 (grep) or any non-zero exit (wc) is a failure
  const failed = inner[0] === 'grep' ? r.exit > 1 : r.exit !== 0;
  const m = /^\s*(\d+)/.exec(out);
  if (failed || !m) return { exit: 2, out: `${out}\ncount: ${failed ? `${inner[0]} exited ${r.exit}` : 'no number in the output'}` };
  const n = Number(m[1]);
  const holds = COUNT_OPS[op](n, Number(limit));
  return { exit: holds ? 0 : 1, out: `${out}\ncount ${n} ${op} ${limit}: ${holds ? 'true' : 'false'}` };
}

/** The program and arguments to spawn for an allowed argv: `node` is this Node, `npm` on Windows is npm-cli.js. */
export function binFor(argv) {
  if (argv[0] === 'node') return [process.execPath, argv.slice(1)];
  if (argv[0] === 'npm' && process.platform === 'win32') {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return [process.execPath, [cli, ...argv.slice(1)]];
  }
  return [argv[0], argv.slice(1)];
}

/** Run an allowed argv without a shell, in `cwd`, with isolatedEnv and a fresh temporary HOME that is removed after.
 *  Returns {exit, out, timedOut, error}. `run` is spawnSync (a test passes a spy).
 *  @param {string[]} argv
 *  @param {{cwd?: string, env?: any, timeoutMs?: number, run?: any}} [opts]
 *  @returns {{exit: number, out: string, timedOut?: boolean, error?: any}} */
export function spawnAllowed(argv, { cwd, env = process.env, timeoutMs = 600000, run = spawnSync } = {}) {
  if (argv[0] === COUNT_ARGV0) return runCount(argv, { cwd, env, timeoutMs, run });
  const home = mkdtempSync(join(tmpdir(), 'enforcer-accept-'));
  try {
    const [bin, args] = binFor(argv);
    const r = run(bin, args, {
      cwd,
      env: isolatedEnv(env, home, { gh: argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view' }),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      detached: process.platform !== 'win32', // its own process group, so a timeout can kill the grandchildren too
      timeout: timeoutMs,
      maxBuffer: 64 << 20,
    });
    if (r.error?.code === 'ETIMEDOUT') {
      if (process.platform !== 'win32' && r.pid) {
        try {
          process.kill(-r.pid, 'SIGKILL');
        } catch {
          /* the group is already gone */
        }
      }
    }
    if (r.error?.code === 'ETIMEDOUT') return { exit: 124, out: `timed out after ${Math.round(timeoutMs / 1000)} s`, timedOut: true };
    if (r.error) return { exit: 127, out: String(r.error.message), error: r.error };
    return { exit: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    removeTree(home);
  }
}
