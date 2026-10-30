// Named repository checks: an acceptance row `{"check": "repo.<name>"}` runs the argv the repository itself declares
// in `.enforcer/checks.json` at the checkout root, never a shell and never text the plan wrote.
//
//   { "test": ["npm", "test"], "lint": ["npm", "run", "lint"], "env": { "PATH": "node_modules/.bin" } }
//
// Every key but `env` is a check name whose value must be a non-empty array of strings (anything else refuses the
// whole manifest). `env.PATH` is optional: a `:`-separated list of directories, each inside the checkout or under
// $HOME/.cache, put in front of PATH. The argv runs in the checkout with the allowlist's minimal environment and a
// temporary HOME (spawnAllowed), and the result is a record `{kind:'check', source:'runner', name, exit, output}` with
// the last 4 KB of output. Only the runner writes such records: the report hook strips `source: runner` from any
// evidence a worker supplied (src/graph/evidence.mjs stripRunner).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnAllowed } from './acceptance-allowlist.mjs';
import { githubCheckName } from './github-checks.mjs';

export const MANIFEST = join('.enforcer', 'checks.json');
export const OUTPUT_TAIL = 4096;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The check name of an acceptance row `{check: "repo.<name>"}`, or null for any other row. */
export function checkName(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.check !== 'string') return null;
  const m = /^repo\.(.+)$/.exec(row.check.trim());
  return m && NAME_RE.test(m[1]) ? m[1] : null;
}

/** True for an acceptance row that is a manifest check. */
export const isCheckRow = (row) => checkName(row) !== null || githubCheckName(row) !== null;

/** A short label for an acceptance row (string or check row) for notes and logs. */
export const rowLabel = (row) => (typeof row === 'string' ? row : isCheckRow(row) ? `check ${row.check}` : JSON.stringify(row));

const inside = (dir, root) => {
  const rel = relative(resolve(root), dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Read and validate `.enforcer/checks.json` under `root`. Returns {checks, pathPrefix} or {error}. */
export function loadManifest(root, { env = process.env } = {}) {
  const file = join(root, MANIFEST);
  if (!existsSync(file)) return { error: `no ${MANIFEST} in the checkout` };
  let m;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `${MANIFEST} is not valid JSON: ${e.message}` };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: `${MANIFEST} must be an object of {name: argv[]}` };
  const checks = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'env') continue;
    if (!NAME_RE.test(k)) return { error: `${MANIFEST}: bad check name ${JSON.stringify(k)}` };
    if (!Array.isArray(v) || !v.length || !v.every((a) => typeof a === 'string' && a.length && !a.includes('\0')))
      return { error: `${MANIFEST}: check ${JSON.stringify(k)} must be a non-empty array of strings (argv, no shell)` };
    checks[k] = v.slice();
  }
  let pathPrefix = '';
  if (m.env !== undefined) {
    if (!m.env || typeof m.env !== 'object' || Array.isArray(m.env) || Object.keys(m.env).some((k) => k !== 'PATH'))
      return { error: `${MANIFEST}: env may only hold PATH` };
    if (m.env.PATH !== undefined) {
      if (typeof m.env.PATH !== 'string') return { error: `${MANIFEST}: env.PATH must be a string` };
      const cache = join(env.HOME || env.USERPROFILE || homedir(), '.cache');
      const dirs = m.env.PATH.split(delimiter).filter(Boolean);
      const abs = [];
      for (const d of dirs) {
        const a = resolve(root, d);
        if (!inside(a, root) && !inside(a, cache))
          return { error: `${MANIFEST}: env.PATH entry ${JSON.stringify(d)} is outside the checkout and $HOME/.cache` };
        abs.push(a);
      }
      pathPrefix = abs.join(delimiter);
    }
  }
  return { checks, pathPrefix };
}

/** Run the named check from the manifest under `root`. Returns the runner record or {skip: reason}.
 *  @param {string} name
 *  @param {{root?: string, env?: any, timeoutMs?: number, run?: any}} opts */
export function runCheck(name, { root, env = process.env, timeoutMs = 600000, run } = {}) {
  const man = loadManifest(root, { env });
  if (man.error) return { skip: man.error };
  const argv = man.checks[name];
  if (!argv) return { skip: `${MANIFEST} has no check ${JSON.stringify(name)}` };
  const runEnv = man.pathPrefix ? { ...env, PATH: env.PATH ? man.pathPrefix + delimiter + env.PATH : man.pathPrefix } : env;
  const r = spawnAllowed(argv, { cwd: root, env: runEnv, timeoutMs, ...(run ? { run } : {}) });
  const out = String(r.out || '');
  return { kind: 'check', source: 'runner', name: `repo.${name}`, argv, exit: r.exit, output: out.length > OUTPUT_TAIL ? out.slice(-OUTPUT_TAIL) : out };
}
