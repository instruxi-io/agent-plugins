// Structural checks on skills/graph/SKILL.md and agents/graph-worker.md (port of check_skill.py).
//
// The skill is loaded into every graph worker's context, so it must name real tools with real
// parameters, and keep the worker rule that the per-agent evidence capture depends on: whoever does
// the work claims and reports it. A coordinator that claimed and reported 18 nodes for its subagents
// had all 18 judged `rejected / unsupported_by_evidence`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const skill = read('skills/graph/SKILL.md');
const agentText = read('agents/graph-worker.md');

// Params for the tools the loop documents; null: the skill may name the tool but not document its params.
const TOOLS = {
  graph_next_work: ['graph', 'runner', 'for', 'node', 'upstream_depth'],
  graph_heartbeat: ['graph', 'node_id', 'run_id'],
  graph_report: ['graph', 'node_id', 'run_id', 'status', 'report', 'error', 'pr', 'data', 'outputs', 'evidence'],
  graph_remember: ['graph', 'node_id', 'body', 'source', 'data', 'evidence'],
  graph_plan_status: null,
  graph_review: null,
  graph_decide: null,
  graph_reset: null,
  graph_query: null,
  graph_access: null,
  graph_epochs: null,
  graph_lifecycle: null,
  graph_my_validations: null,
  graph_judge: null,
  graph_share: null,
  graph_unshare: null,
};

const RULES = [
  '## The worker rule',
  'Claim your own node with `graph_next_work`',
  'Never claim by id',
  'Report before you return',
  'Never report a node you did not claim',
  'Evidence is captured, not written',
  'files_base_url',
  'NOT MET — STALE',
  '## Done means merged',
  '## Coordinating subagents',
  '## Following the route',
  'override reason',
  '`node` parameter',
  'MCP 0.9.5',
  'user` beats `planner` beats `rule` beats `jev`',
  'Load the `enforcer:graph`',
  'Never call `graph_report` for a worker',
  '## When a person must answer',
  'AskUserQuestion',
  '! graphwatch decide <graph>',
  '! graphwatch resolve <graph>',
];

test('skill: frontmatter names the skill, description within 1024 chars', () => {
  assert.ok(skill.startsWith('---\n'), 'no frontmatter');
  const fm = skill.split('---\n')[1];
  assert.match(fm, /^name: graph$/m);
  const d = fm.match(/^description: (.+)$/m);
  assert.ok(d && d[1].length > 0 && d[1].length <= 1024, 'description missing or over 1024 chars');
});

test('skill: names only real graph tools, with their real params', () => {
  const named = new Set(skill.match(/\bgraph_[a-z_]+\b/g));
  assert.deepEqual(
    [...named].filter((n) => !(n in TOOLS)),
    [],
    'not real tools',
  );
  const documented = [...skill.matchAll(/\*\*`(graph_[a-z_]+)`\*\* \(([^)]*)\)/g)];
  assert.ok(documented.length >= 4, "the loop no longer lists each tool's params");
  for (const [, tool, params] of documented) {
    const used = [...params.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const real = TOOLS[tool] || [];
    assert.ok(used.length > 0 && used.every((u) => real.includes(u)), `${tool}: not real params: ${used.filter((u) => !real.includes(u))}`);
  }
});

test('skill: keeps the worker rule, evidence, stale-acceptance, merge and coordinator rules', () => {
  assert.deepEqual(
    RULES.filter((r) => !skill.includes(r)),
    [],
  );
});

test('skill: the enforcer-files upload command it gives exists and takes --dir', () => {
  assert.ok(skill.includes('files.mjs" upload <log> --dir graph-evidence'), 'upload command changed');
  assert.match(read('bin/files.mjs'), /upload <path> .*\[--dir <directory>\]/);
});

test('agent: graph-worker has name, sonnet, tool allowlist for all three server prefixes, no api_write', () => {
  const m = agentText.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'no frontmatter');
  const fm = m[1];
  assert.match(fm, /^name: graph-worker$/m);
  assert.match(fm, /^description: .{20,}/m);
  assert.match(fm, /^model: sonnet$/m);
  const tl = fm.match(/^tools: (.+)$/m);
  assert.ok(tl, 'tools allowlist');
  const names = tl[1].split(',').map((x) => x.trim());
  for (const tool of ['graph_next_work', 'graph_heartbeat', 'graph_report']) {
    for (const pre of ['plugin_enforcer_enforcer', 'enforcer', 'enforcer-graph']) assert.ok(names.includes(`mcp__${pre}__${tool}`), `missing ${pre} ${tool}`);
  }
  assert.deepEqual(
    names.filter((n) => n.includes('api_write')),
    [],
    'agent must not be allowed enforcer_api_write',
  );
  const body = agentText.slice(m[0].length);
  for (const pat of ['gh pr create', 'land-pr', 'git push']) assert.ok(!body.includes(pat), `agent must not carry delivery commands: ${pat}`);
  assert.match(body, /Deliver as your skills say/);
  assert.match(body, /[Ll]oad\s+and\s+follow\s+them\s+in\s+order/);
  assert.match(body, /[Rr]eport\s+what\s+you\s+produced/);
  for (const line of body.split('\n')) if (line.includes('api_write')) assert.match(line, /[Nn]ever|bypass|not /, `api_write without a prohibition: ${line}`);
});

const MAX_BRIEF_FILES = 5;
const MAX_BRIEF_BYTES = 30 * 1024;
const POINTER = /\b(see|per|as in|refer to|read)\b[^.\n]{0,30}\b(plan|contract)\b[^.\n]{0,20}\b(section|part|§|doc|document)/i;

/** Problems in a plan's nodes ({key, description, data:{brief}}); `size` maps a brief path to bytes (0 when absent). */
function planProblems(nodes, size) {
  const out = [];
  for (const n of nodes) {
    const key = n.key || '?',
      d = n.description || '';
    if (POINTER.test(d) || /\bplan section\b|§\s*\d/i.test(d)) out.push(`${key}: description points at a plan section; the description is the spec`);
    const brief = n.data?.brief || [];
    if (brief.length > MAX_BRIEF_FILES) out.push(`${key}: brief names ${brief.length} files (max ${MAX_BRIEF_FILES})`);
    let total = 0;
    for (const b of brief) {
      const s = size(b.split(' (')[0]);
      if (s > MAX_BRIEF_BYTES) out.push(`${key}: ${b} is ${s} bytes, over the ${MAX_BRIEF_BYTES} limit for one document`);
      total += s;
    }
    if (total > MAX_BRIEF_BYTES) out.push(`${key}: brief totals ${total} bytes (max ${MAX_BRIEF_BYTES})`);
  }
  return out;
}

test("plan: a node that says 'see plan section' or a brief over 5 files / 30 KB is rejected; skill and agent state the budget", () => {
  const sizes = { 'big.md': MAX_BRIEF_BYTES + 1, 'f1.md': 1 };
  const size = (p) => sizes[p] ?? (/^f\d\.md$/.test(p) ? 1 : 0);
  assert.deepEqual(planProblems([{ key: 'a', description: 'Add X to Y. Bump Z to 3.', data: { brief: ['agents/graph-worker.md'] } }], size), []);
  const six = Array.from({ length: 6 }, (_, i) => `f${i}.md`);
  const bad = {
    sees: { key: 'sees', description: 'Implement the lobby. See plan section 4.2 for details.' },
    six: { key: 'six', description: 'ok', data: { brief: six } },
    big: { key: 'big', description: 'ok', data: { brief: ['big.md'] } },
    sum: { key: 'sum', description: 'ok', data: { brief: ['big.md', 'f1.md'] } },
  };
  for (const [name, node] of Object.entries(bad)) assert.ok(planProblems([node], size).length > 0, `sample node ${name} was not rejected`);
  assert.deepEqual(planProblems([{ key: 'five', description: 'ok', data: { brief: six.slice(0, 5) } }], size), []);
  for (const need of ['at most 5 files and 30 KB', '`scout`', 'WORKER_BRIEF.md', '8 KB', 'description IS its spec'])
    assert.ok(skill.includes(need), `SKILL.md missing: ${need}`);
  for (const need of ['maxTurns: 80', 'WORKER_BRIEF.md', 'turn 12', 'turn 20', 'ONLY']) assert.ok(agentText.includes(need), `graph-worker.md missing: ${need}`);
  assert.ok(skill.includes('`git push -u origin graph/<key>`'), 'SKILL.md must say to push alone');
  assert.match(skill, /never chained/);
});
