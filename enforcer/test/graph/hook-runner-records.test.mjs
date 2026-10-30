// A dispatched worker's report carries runner records for its {"check": ...} rows. The claim card's top-level
// `acceptance` lists only the judged lines; the check rows are on node.data.acceptance. The hook used to save the
// top-level list, so it ran no check row and every check came back no_runner_record (conformance 7d162fcc, 2026-10-30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'hook-runner-records-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_PLUGIN_DATA = join(home, 'data');
delete process.env.ENFORCER_STATE_DIR;
delete process.env.GRAPH_EVIDENCE_MODE;
const { trackRun, cardAcceptance } = await import('../../src/graph/hooks/track-run.mjs');
const { decide } = await import('../../src/graph/hooks/attach.mjs');
const { loadRun } = await import('../../src/graph/run.mjs');

const file = 'smoke/conformance-claude-1.md';
const grepLine = `\`git grep -c 'harness: claude' -- ${file}\` prints \`${file}:1\``;

// A worktree of a repo shaped like enforcer-smoke: the nested checks manifest `enforcer conformance` writes, one smoke file.
function smokeRepo() {
  const repo = join(home, 'enforcer-smoke-wt');
  mkdirSync(join(repo, '.enforcer'), { recursive: true });
  mkdirSync(join(repo, 'smoke'), { recursive: true });
  writeFileSync(join(repo, '.enforcer', 'checks.json'), JSON.stringify({ checks: { tests: { argv: ['node', '-e', "console.log('ok: smoke')"] } } }));
  writeFileSync(join(repo, file), 'harness: claude\nprotocol: 1\n');
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'smoke');
  return repo;
}

// The claim card exactly as the server sent it to the 7d162fcc worker, trimmed to the fields that matter.
const card = {
  state: 'claimed',
  graph_id: 'g-conf',
  node: { node_id: 'n-conf', key: 'conf-claude', type: 'task', data: { acceptance: [{ check: 'repo.tests' }, { check: 'github.pr_merged' }, grepLine] } },
  run: { run_id: 'r-conf', lease_expires_at: '2099-01-01T00:00:00Z' },
  acceptance: [grepLine],
  criteria: ['1. ' + grepLine, '[check] repo.tests on link ? — evaluated in code, not judged'],
};

test('cardAcceptance keeps the check rows the top-level acceptance drops, in node order', () => {
  assert.deepEqual(cardAcceptance(card), [{ check: 'repo.tests' }, { check: 'github.pr_merged' }, grepLine]);
  assert.deepEqual(cardAcceptance({ acceptance: ['`ls` exits 0'] }), ['`ls` exits 0']);
  assert.deepEqual(cardAcceptance({ node: { data: { acceptance: [] } }, acceptance: ['`ls` exits 0'] }), ['`ls` exits 0']);
  assert.deepEqual(cardAcceptance(null), []);
});

test('a dispatched worker report gets runner check records attached', async () => {
  const repo = smokeRepo();
  const sid = 'dispatched-worker-session';
  // PostToolUse on graph_next_work, the way Claude Code hands an MCP result to the hook.
  await trackRun({
    session_id: sid,
    cwd: repo,
    tool_name: 'mcp__enforcer__graph_next_work',
    tool_response: [{ type: 'text', text: JSON.stringify(card) }],
  });
  assert.deepEqual(loadRun(sid).acceptance, [{ check: 'repo.tests' }, { check: 'github.pr_merged' }, grepLine]);

  const out = await decide(
    {
      session_id: sid,
      cwd: repo,
      tool_name: 'mcp__enforcer__graph_report',
      tool_input: { graph: 'g-conf', node_id: 'n-conf', run_id: 'r-conf', status: 'succeeded', report: '1. MET' },
    },
    { upload: async () => null },
  );
  const ev = out.updatedInput.evidence;
  const runner = ev.filter((e) => e.kind === 'check' && e.source === 'runner');
  const tests = runner.find((e) => e.name === 'repo.tests');
  assert.ok(tests, 'repo.tests runner record attached: ' + JSON.stringify(ev));
  assert.equal(tests.exit, 0);
  assert.equal(tests.line, 1, 'the check row keeps its node line number');
  assert.match(tests.output, /ok: smoke/);
  const grep = ev.find((e) => e.kind === 'command' && String(e.cmd).startsWith('git grep'));
  assert.equal(grep.line, 3, 'the prose line is numbered as `enforcer evidence run` numbers it');
  // github.pr_merged cannot resolve a PR in a repo with no remote: it is noted, never silently dropped.
  assert.ok(
    runner.some((e) => e.name === 'github.pr_merged') || ev.some((e) => e.kind === 'note' && /acceptance line 2 /.test(e.text)),
    'github.pr_merged is attached or noted: ' + JSON.stringify(ev),
  );
});
