// `enforcer skills source show|set|sync|rm <graph>`: a graph's skill source (SKILL_SOURCE_CONTRACT §5), thin wrappers
// over GET/PUT/DELETE /graphs/{g}/skill-source and POST /graphs/{g}/skill-source/sync. Each prints the commit and the
// skill slugs; an error prints the server's code and detail.
import { apiFetch, TIMEOUTS } from '../lib/api/client.mjs';
import { resolveConfig } from './config.mjs';
import { headers as graphHeaders } from './preflight.mjs';
import { safeIdent } from './dispatch/ident.mjs';

export const SKILLS_HELP = `usage: enforcer skills source show <graph>
       enforcer skills source set <graph> --repo owner/name [--ref x] [--path skills] [--include a,b]
       enforcer skills source sync <graph>
       enforcer skills source rm <graph>
  a graph's skill source: the server reads every <path>/<slug>/SKILL.md from a public GitHub repo at <ref> and puts
  those skills first on each node's claim card. set and rm need graph admin; sync needs editor.
`;

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const SUBS = ['show', 'set', 'sync', 'rm'];

/** argv after `skills` -> {sub, graph, body?}; throws Error with a usage message. */
export function parseSkillsArgs(argv) {
  const [area, sub, ...rest] = argv;
  if (area !== 'source') throw new Error(`unknown command ${JSON.stringify(area ?? '')}; expected: skills source <${SUBS.join('|')}> <graph>`);
  if (!SUBS.includes(sub)) throw new Error(`unknown subcommand ${JSON.stringify(sub ?? '')}; expected one of ${SUBS.join(', ')}`);
  let graph = null;
  const body = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (['--repo', '--ref', '--path', '--include'].includes(a)) {
      if (sub !== 'set') throw new Error(`${a} is only for set`);
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--repo') {
        if (!REPO.test(v)) throw new Error(`--repo must be owner/name on github.com (not a URL): ${JSON.stringify(v)}`);
        body.repo = v;
      } else if (a === '--include') {
        const list = v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        const bad = list.filter((x) => !SLUG.test(x));
        if (!list.length || bad.length) throw new Error(`--include takes skill slugs a,b (^[a-z][a-z0-9-]{0,63}$)${bad.length ? `: ${bad.join(', ')}` : ''}`);
        body.include = list;
      } else body[a.slice(2)] = v;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    if (graph) throw new Error(`one graph only (got ${graph} and ${a})`);
    graph = a;
  }
  if (!graph) throw new Error('a graph id is required');
  if (!safeIdent(graph)) throw new Error(`graph id ${JSON.stringify(graph)} is not a valid id`);
  if (sub === 'set' && !body.repo) throw new Error('set needs --repo owner/name');
  return sub === 'set' ? { sub, graph, body } : { sub, graph };
}

class SourceError extends Error {
  constructor(status, body) {
    const e = body?.error;
    const code = (e && typeof e === 'object' ? e.code : e) || body?.code || null;
    const detail = (typeof body?.detail === 'string' && body.detail) || (e && typeof e === 'object' && e.message) || '';
    super(`HTTP ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.code = code;
  }
}

async function call(base, h, method, path, body, fetchImpl) {
  const res = await apiFetch(
    base.replace(/\/+$/, '') + path,
    { method, headers: { ...h, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    { timeoutMs: TIMEOUTS.cli, ...(fetchImpl ? { fetchImpl } : {}) },
  );
  let b = null;
  try {
    b = await res.json();
  } catch {}
  if (!res.ok) throw new SourceError(res.status, b);
  return b?.data ?? b ?? {};
}

/** A 404/405 that is not the server's `skill_source_not_found`: this server has no skill-source routes. */
const missingRoute = (e) => e instanceof SourceError && (e.status === 405 || (e.status === 404 && e.code !== 'skill_source_not_found'));

/** The `show` text for a GET /skill-source answer. */
export function describe(graph, d) {
  const src = d?.source !== undefined ? d.source : d?.repo ? d : null;
  if (!src) return `${graph}: no skill source\n`;
  const skills = (d.skills ?? src.skills ?? []).map((s) => s?.slug).filter(Boolean);
  const L = [
    `${graph}: skills from ${src.repo}@${src.ref ?? '?'} path ${src.path ?? 'skills'}${src.include?.length ? ` include ${src.include.join(',')}` : ''}`,
    `commit ${src.resolved_commit ?? '?'}${src.synced_at ? ` (synced ${src.synced_at})` : ''}`,
  ];
  if (src.last_error) L.push(`last sync failed${src.last_error_at ? ` at ${src.last_error_at}` : ''}: ${src.last_error} (cards keep the commit above)`);
  L.push(`skills (${skills.length}): ${skills.join(', ') || 'none'}`);
  return L.join('\n') + '\n';
}

/** `enforcer skills ...`. Returns the exit code: 0 ok, 1 the server refused or could not be reached, 2 usage. */
export async function main(
  argv,
  { env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), fetchImpl = undefined } = /** @type {any} */ ({}),
) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    (argv.length ? out : err)(SKILLS_HELP);
    return argv.length ? 0 : 2;
  }
  let p;
  try {
    p = parseSkillsArgs(argv);
  } catch (e) {
    err(`enforcer skills: ${e.message}\n${SKILLS_HELP}`);
    return 2;
  }
  const base = resolveConfig({ env }).graphUrl;
  const h = await graphHeaders(env);
  const g = p.graph;
  try {
    if (p.sub === 'rm') {
      await call(base, h, 'DELETE', `/graphs/${g}/skill-source`, undefined, fetchImpl);
      out(`${p.graph}: skill source removed\n`);
      return 0;
    }
    // api-used: sends repo,ref,path,include
    if (p.sub === 'set') await call(base, h, 'PUT', `/graphs/${g}/skill-source`, p.body, fetchImpl);
    if (p.sub === 'sync') {
      const d = await call(base, h, 'POST', `/graphs/${g}/skill-source/sync`, {}, fetchImpl); // api-used: reads data.changed,data.throttled,data.from,data.to
      if (d.changed) out(`${p.graph}: synced, ${String(d.from ?? '?').slice(0, 7)} -> ${String(d.to ?? '?').slice(0, 7)}\n`);
      else out(`${p.graph}: unchanged${d.throttled ? ' (synced in the last 60 s; not re-read)' : ''}\n`);
    }
    out(describe(g, await call(base, h, 'GET', `/graphs/${g}/skill-source`, undefined, fetchImpl))); // api-used: reads data.source,data.skills
    return 0;
  } catch (e) {
    if (p.sub === 'show' && e instanceof SourceError && e.status === 404 && e.code === 'skill_source_not_found') {
      out(`${p.graph}: no skill source\n`);
      return 0;
    }
    if (missingRoute(e) && p.sub === 'show') {
      out(`${p.graph}: no skill source (this server has no skill-source routes)\n`);
      return 0;
    }
    if (missingRoute(e)) {
      err(`enforcer skills source ${p.sub}: this server has no skill-source routes (${e.message})\n`);
      return 1;
    }
    err(`enforcer skills source ${p.sub} ${p.graph}: ${e.message}\n`);
    return 1;
  }
}
