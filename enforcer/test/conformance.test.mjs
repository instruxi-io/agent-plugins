import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, plan, table, harnessProblem, main, STEPS, resultsOf } from '../src/conformance.mjs';
const BIN = fileURLToPath(new URL('../bin/enforcer', import.meta.url));

const r = spawnSync(process.execPath, [BIN, 'conformance', '--help'], { encoding: 'utf8' });
assert.equal(r.status, 0);
assert.match(r.stdout, /PROTOCOL/);
const p = plan('codex', undefined, 42);
assert.equal(p.nodes.length, 1);
assert.equal(p.nodes[0].key, 'conf-codex');
assert.equal(p.nodes[0].data.repo, 'enforcer-smoke');
assert.equal(p.nodes[0].data.harness, 'codex');
assert.equal(p.nodes[0].data.tier, 'standard');
const acc = p.nodes[0].data.acceptance;
assert.deepEqual(acc.slice(0, 2), [{ check: 'repo.tests' }, { check: 'github.pr_merged' }]);
assert.match(acc[2], /git grep -c 'harness: codex' -- smoke\/conformance-codex-42.md` prints `smoke\/conformance-codex-42.md:1`/);
const all = resultsOf(
  {
    verdict: {
      state: 'verified',
      checks: [
        { check: 'repo.tests', passed: true },
        { check: 'github.pr_merged', passed: true },
      ],
    },
  },
  [{ status: 'succeeded', heartbeat_at: 'x', evidence: [{}] }],
);
assert.deepEqual(
  Object.values(all),
  STEPS.map(() => true),
);
assert.equal(resultsOf({}, []).claim, false);
assert.match(harnessProblem('grok', { problem: () => 'no credentials' }), /not signed in: no credentials/);
assert.match(harnessProblem('vim'), /unknown harness/);
const lines = [];
const code = await main(['--harnesses', 'codex'], { out: (s) => lines.push(s), problem: () => 'signed out' });
assert.equal(code, 1);
const o = lines.join('\n');
assert.match(o, new RegExp(`PROTOCOL ${PROTOCOL}`));
assert.match(o, /codex: not signed in: signed out/);
assert.match(table([{ harness: 'x', results: { claim: true } }]), /pass/);

// The filing body carries the slug the server requires (POST /graphs: name and slug, 400 `slug is required` otherwise).
const calls = [];
const fake = {
  call: async (method, path, body) => {
    calls.push({ method, path, body });
    return { data: { id: 'g-1' } };
  },
  createNode: async () => ({}),
  createEdge: async () => ({}),
};
const filed = [];
await main(['--harnesses', 'claude'], { out: (s) => filed.push(s), problem: () => null, api: fake });
const create = calls.find((c) => c.method === 'POST' && c.path === '/graphs');
assert.ok(create, 'conformance creates its graph');
assert.match(create.body.slug, /^conformance-claude-\d+$/);
assert.equal(create.body.slug, create.body.name);
assert.match(filed.join('\n'), /claude: filed graph g-1/);
// Each run writes its own file, so a second run on the same repo still has a change to land.
const a = plan('claude', undefined, 111);
const b = plan('claude', undefined, 222);
assert.notEqual(a.nodes[0].data.acceptance[2], b.nodes[0].data.acceptance[2]);
assert.match(a.nodes[0].description, /smoke\/conformance-claude-111\.md/);
console.log('ok - conformance');

// Runner-check rows are not prose: the preflight lint skips them (it used to stringify them to "[object Object]").
const { acceptanceLint } = await import('../src/preflight.mjs');
assert.deepEqual(
  await acceptanceLint('http://unused.invalid', 'g', {}, [
    { key: 'k', type: 'task', status: 'open', data: { acceptance: [{ check: 'repo.tests' }, { check: 'github.pr_merged' }] } },
  ]),
  [],
);

// The real shape: the verdict is on the run, a succeeded run carries data.report and evidence.
const real = resultsOf({ status: 'verifying' }, [
  {
    status: 'succeeded',
    data: { report: 'r' },
    evidence: [{}],
    verification: {
      state: 'unverified',
      checks: [
        { check: 'repo.tests', passed: false },
        { check: 'github.pr_merged', passed: true },
      ],
    },
  },
]);
assert.deepEqual([real.claim, real.check, real.land, real.report, real.verified], [true, false, true, true, false]);
