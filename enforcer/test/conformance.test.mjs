import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, plan, table, harnessProblem, main, STEPS } from '../src/conformance.mjs';
const BIN = fileURLToPath(new URL('../bin/enforcer', import.meta.url));

const r = spawnSync(process.execPath, [BIN, 'conformance', '--help'], { encoding: 'utf8' });
assert.equal(r.status, 0);
assert.match(r.stdout, /PROTOCOL/);
const p = plan('codex');
assert.equal(p.nodes.length, STEPS.length);
assert.equal(p.edges.length, STEPS.length - 1);
assert.ok(p.nodes.some((n) => n.data.acceptance.some((a) => a.check === 'repo.tests')));
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
console.log('ok - conformance');
