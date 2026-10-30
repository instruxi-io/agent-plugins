// `enforcer conformance <harness>`: the graph every harness plugin must pass. Harness-neutral (shared code).
// Files a graph in the smoke repo (instruxi-io/enforcer-smoke) whose nodes prove, for one harness:
// claim, heartbeat, a `repo.tests` runner check, landing on the card's branch, report, verified.
// `--status <graph>` reads the node verdicts back as a pass/fail table. Release gate: docs/CONFORMANCE.md.
import { API } from './dispatch/api.mjs';
import { authHeaders, signInProblem } from './credentials.mjs';
import { resolveConfig } from './config.mjs';

export const PROTOCOL = 1;
export const HARNESSES = Object.freeze(['claude', 'codex', 'grok', 'gemini']);
export const SMOKE_REPO = 'instruxi-io/enforcer-smoke';
export const CHECKS_JSON = { checks: { tests: { argv: ['node', '--test'] } } };

export const USAGE = `usage: enforcer conformance [--harnesses claude,codex,grok,gemini] [--repo owner/repo] [--dry-run] [--json]
       enforcer conformance --status <graph>   (pass/fail table from the node verdicts)

Files one conformance graph per harness in ${SMOKE_REPO} (targets PROTOCOL ${PROTOCOL}). Its nodes prove:
  claim       the harness claims the node through graph_next_work
  heartbeat   it keeps the lease with graph_heartbeat
  check       the \`repo.tests\` runner check (.enforcer/checks.json in the smoke repo) passes
  land        the work lands on the card's branch (fallback graph/<key> until claim-branch is rolled out)
  report      it reports with captured evidence
  verified    the judge's verdict is verified
A harness that is not signed in fails its column at once, with the reason. The release procedure needs
claude green before a release and every harness green before a tag is marked stable.
`;

export const STEPS = ['claim', 'heartbeat', 'check', 'land', 'report', 'verified'];

/** The nodes (and chain edges) one harness's graph carries. */
export function plan(harness, repo = SMOKE_REPO) {
  const accept = {
    claim: ['the run was claimed by this harness (run.runner names it)'],
    heartbeat: ['`graph_heartbeat` answered state ok at least once before the report'],
    check: [{ check: 'repo.tests' }],
    land: ['the change is on branch graph/<key> (or the card branch) in ' + repo],
    report: ['the report lists each criterion MET with the command that shows it'],
    verified: ['the judge verdict for the previous node is verified'],
  };
  const nodes = STEPS.map((s) => ({
    key: `conf-${harness}-${s}`,
    type: 'task',
    title: `conformance ${harness}: ${s}`,
    description: `Protocol ${PROTOCOL} conformance step "${s}" for the ${harness} plugin.`,
    data: { repo, harness, step: s, protocol: PROTOCOL, acceptance: accept[s] },
  }));
  const edges = nodes.slice(1).map((n, i) => ({ from_key: n.key, to_key: nodes[i].key, type: 'requires' }));
  return { nodes, edges };
}

/** Why this harness cannot run at all, else null. */
export function harnessProblem(harness, { problem = signInProblem } = {}) {
  if (!HARNESSES.includes(harness)) return `unknown harness "${harness}" (one of ${HARNESSES.join(', ')})`;
  const p = problem();
  return p ? `not signed in: ${p}` : null;
}

const cell = (ok) => (ok === true ? 'pass' : ok === false ? 'FAIL' : '-');

/** Render rows [{harness, reason, results: {step: bool|null}}] as a table. */
export function table(rows) {
  const head = ['harness', ...STEPS];
  const lines = [head, ...rows.map((r) => [r.harness, ...STEPS.map((s) => (r.reason ? 'FAIL' : cell(r.results?.[s])))])];
  const w = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  const out = lines.map((l) =>
    l
      .map((c, i) => c.padEnd(w[i]))
      .join('  ')
      .trimEnd(),
  );
  for (const r of rows) if (r.reason) out.push(`${r.harness}: ${r.reason}`);
  return out.join('\n');
}

const verdictOf = (n) => {
  if (n.status === 'done') return true;
  if (n.status === 'failed') return false;
  return null;
};

export async function main(
  argv,
  { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'), api, problem } = /** @type {any} */ ({}),
) {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const json = argv.includes('--json');
  const dry = argv.includes('--dry-run');
  const repo = opt('--repo') || SMOKE_REPO;
  const picked = (opt('--harnesses') || 'claude')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  out(`enforcer conformance: targets PROTOCOL ${PROTOCOL}`);

  const bad = picked.map((h) => [h, harnessProblem(h, { problem: problem || signInProblem })]);
  const client = api || (bad.some(([, p]) => p) && !opt('--status') ? null : new API(resolveConfig({}).graphUrl, { headers: authHeaders }));

  if (opt('--status')) {
    const g = opt('--status');
    const nodes = await (api || new API(resolveConfig({}).graphUrl, { headers: authHeaders })).nodes(g);
    const by = {};
    for (const n of nodes) {
      const m = /^conf-(.+?)-(\w+)$/.exec(n.key || '');
      if (m) (by[m[1]] ||= {})[m[2]] = verdictOf(n);
    }
    const rows = Object.entries(by).map(([harness, results]) => ({ harness, results }));
    out(json ? JSON.stringify({ protocol: PROTOCOL, rows }) : table(rows));
    return rows.length && rows.every((r) => STEPS.every((s) => r.results[s] === true)) ? 0 : 1;
  }

  const rows = [];
  for (const [harness, reason] of bad) {
    const row = { harness, reason, results: {} };
    if (!reason) {
      const p = plan(harness, repo);
      const stamp = Date.now();
      if (dry) {
        out(JSON.stringify(p));
      } else {
        try {
          const g = (
            await client.call('POST', '/graphs', {
              name: `conformance-${harness}-${stamp}`,
              slug: `conformance-${harness}-${stamp}`,
              mode: 'dag',
              data: { protocol: PROTOCOL, harness, repo, checks: CHECKS_JSON },
            })
          ).data;
          const id = Array.isArray(g) ? g[0].id : g.id;
          for (const n of p.nodes) await client.createNode(id, n);
          for (const e of p.edges) await client.createEdge(id, e);
          row.graph = id;
          out(`${harness}: filed graph ${id}; run its worker, then: enforcer conformance --status ${id}`);
        } catch (e) {
          row.reason = `could not file the graph: ${e.message}`;
        }
      }
    }
    rows.push(row);
  }
  out(json ? JSON.stringify({ protocol: PROTOCOL, rows }) : table(rows));
  return rows.some((r) => r.reason) ? 1 : 0;
}
