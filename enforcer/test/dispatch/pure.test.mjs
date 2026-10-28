// `node --test test/dispatch/pure.test.mjs`: the dispatcher's pure logic, ported from the Python dispatcher's suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { modelFor } from '../../src/dispatch/model.mjs';
import { select, lapsed, mergeTarget, affinityOrder, sessionUsable, warmKey } from '../../src/dispatch/select.mjs';
import {
  summarize,
  decisionRecords,
  denialClass,
  skillsOf,
  judgeLines,
  rejectionOf,
  failedOutcome,
  remediationPrompt,
  harnessLimitText,
  limitResetAt,
  DECISION_PREFIX,
  DELIVER_SKILL,
} from '../../src/dispatch/summarize.mjs';
import { triageDecision, unsafeIdent } from '../../src/dispatch/triage.mjs';
import { pruneWorktrees, liveWorkerKeys, ghPrState } from '../../src/dispatch/prune.mjs';
import { countTurns } from '../../src/dispatch/stream.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dispatch');
const node = (key, type = 'task', data = {}, extra = {}) => ({
  id: 'id-' + key,
  key,
  type,
  status: 'active',
  title: key,
  work_state: 'looking_for_work',
  data,
  ...extra,
});
const keys = (ns) => ns.map((n) => n.key);
const tmp = () => mkdtempSync(join(tmpdir(), 'dpure-'));

// ---- TierToModel
test('tiers map to models', () => {
  assert.equal(modelFor(node('a', 'task', { tier: 'mechanical' })), 'sonnet');
  assert.equal(modelFor(node('a', 'task', { tier: 'standard' })), 'sonnet');
  assert.equal(modelFor(node('a', 'task', { tier: 'deep' })), 'opus');
  assert.equal(modelFor(node('a')), 'sonnet');
  assert.equal(modelFor(node('a', 'task', { tier: 'unheard-of' })), 'sonnet');
});
test('cap applies to planner tier', () => {
  assert.equal(modelFor(node('a', 'task', { tier: 'deep', tier_source: 'planner' }), 'sonnet'), 'sonnet');
  assert.equal(modelFor(node('a', 'task', { tier: 'deep', tier_source: 'rule' }), 'sonnet'), 'sonnet');
});
test('user tier wins over cap', () => {
  assert.equal(modelFor(node('a', 'task', { tier: 'deep', tier_source: 'user' }), 'sonnet'), 'opus');
  assert.equal(modelFor(node('a', 'task', { tier: 'mechanical', tier_source: 'user' }), 'opus'), 'sonnet');
});
test('explicit model wins', () => {
  assert.equal(modelFor(node('a', 'task', { tier: 'deep', tier_source: 'user', model: 'haiku' }), 'sonnet'), 'haiku');
  const n = node('a', 'task', { tier: 'mechanical' });
  n.model = 'opus';
  assert.equal(modelFor(n), 'opus');
});

// ---- ContestedResources
test('select never puts two on one value', () => {
  const { chosen, skipped } = select([node('a', 'task', { resources: ['r1'] }), node('b', 'task', { resources: ['r1', 'r2'] }), node('c')], new Set(), 3);
  assert.deepEqual(keys(chosen), ['a', 'c']);
  assert.equal(skipped[0][0].key, 'b');
  assert.match(skipped[0][1], /r1/);
});
test('select blocks on a resource held elsewhere', () => {
  const { chosen } = select([node('a', 'task', { resources: 'r1' }), node('b')], new Set(['r1']), 3);
  assert.deepEqual(keys(chosen), ['b']);
});
test('select bounds slots', () => {
  const { chosen, skipped } = select(
    [...'abcd'].map((k) => node(k)),
    new Set(),
    2,
  );
  assert.equal(chosen.length, 2);
  assert.deepEqual(
    skipped.map(([, why]) => why),
    ['no free worker slot', 'no free worker slot'],
  );
});
test('select skips busy keys', () => {
  const { chosen } = select([node('a'), node('b')], new Set(), 3, { a: {} });
  assert.deepEqual(keys(chosen), ['b']);
});
test('select allows one land per repo', () => {
  const m1 = node('m1', 'merge', { repo: 'r', pr: '1' });
  const m2 = node('m2', 'merge', { repo: 'r', pr: '2' });
  const m3 = node('m3', 'merge', { repo: 's', pr: '3' });
  assert.deepEqual(keys(select([m1, m2, m3], new Set(), 9).chosen), ['m1', 'm3']);
});
test('lapsed is true only for a running node past its lease', () => {
  const future = new Date(Date.now() + 300000).toISOString();
  const past = new Date(Date.now() - 300000).toISOString();
  const live = node('x', 'task', { resources: ['live'] }, { status: 'running', lease_expires_at: future });
  const dead = node('y', 'task', { resources: ['dead'] }, { status: 'running', lease_expires_at: past });
  assert.ok(lapsed(dead) && !lapsed(live));
  assert.ok(!lapsed(node('z')));
});

test('select prefers nodes sharing the previous resource', () => {
  // affinity: a node whose (repo, model) has an idle warm session goes first, the rest keep the server's order
  const cands = [node('x1', 'task', { repo: 'x' }), node('y1', 'task', { repo: 'y' }), node('y2', 'task', { repo: 'y' }), node('z')];
  const m = () => 'sonnet';
  assert.deepEqual(keys(affinityOrder(cands, new Map([[warmKey('y', 'sonnet'), 1]]), m)), ['y1', 'x1', 'y2', 'z']);
  assert.deepEqual(keys(affinityOrder(cands, new Map([[warmKey('y', 'opus'), 1]]), m)), ['x1', 'y1', 'y2', 'z']);
  assert.deepEqual(keys(affinityOrder(cands, new Map(), m)), ['x1', 'y1', 'y2', 'z']);
  // and selection keeps that order while never doubling a resource
  const a = node('a', 'task', { resources: ['r1'] });
  const b = node('b', 'task', { resources: ['r1'] });
  const c = node('c', 'task', { resources: ['r2'] });
  assert.deepEqual(keys(select(affinityOrder([c, a, b], new Map(), m), new Set(), 3).chosen), ['c', 'a']);
});
test('session usable caps nodes and age', () => {
  const s = { nodes: 0, born: 1000 };
  assert.deepEqual(sessionUsable(s, 5, 7200, 1001), [true, '']);
  s.nodes = 5;
  assert.equal(sessionUsable(s, 5, 7200, 1001)[0], false);
  s.nodes = 1;
  const [ok, why] = sessionUsable(s, 5, 7200, 1000 + 7200);
  assert.equal(ok, false);
  assert.match(why, /120m old/);
});

// ---- MergeTarget
test('merge target forms', () => {
  assert.deepEqual(mergeTarget(node('m', 'merge', { pr: 'https://github.com/o/r/pull/7' })), ['7', 'o/r']);
  assert.deepEqual(mergeTarget(node('m', 'merge', { pr: 'o/r#8' })), ['8', 'o/r']);
  assert.deepEqual(mergeTarget(node('m', 'merge', { pr: 9 })), ['9', null]);
  assert.deepEqual(mergeTarget(node('m', 'merge', { branch: 'feat/x' })), ['feat/x', null]);
  assert.equal(mergeTarget(node('m', 'merge')), null);
  assert.equal(mergeTarget(node('t', 'task', { pr: '1' })), null);
});

// ---- StreamSummary / JudgeLines
test('summarize reads the run id and report from a stream', () => {
  const card = JSON.stringify({ state: 'claimed', run: { run_id: '11111111-2222-3333-4444-555555555555' } });
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__plugin_enforcer_enforcer__graph_next_work' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: card }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    { type: 'result', subtype: 'success', permission_denials: [], total_cost_usd: 0.1 },
  ];
  const f = join(tmp(), 's.jsonl');
  writeFileSync(f, lines.map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n');
  const s = summarize(f);
  assert.equal(s.run_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(s.reported, false);
  assert.deepEqual([s.turns, s.result, s.denials], [2, 'success', 0]);
});
test('judge lines list a rejected verdict lowest first', () => {
  const v = {
    state: 'rejected',
    score: 0.4,
    confidence: 0.9,
    criteria: [
      { text: 'b', probability: 0.9 },
      { text: 'a'.repeat(200), probability: 0.1 },
    ],
  };
  const out = judgeLines('k', v);
  assert.equal(out[0], 'JUDGE k score=0.4 conf=0.9');
  assert.equal(out[1], '  0.10 ' + 'a'.repeat(120));
  assert.equal(out[2], '  0.90 b');
});
test('judge lines are silent for a verified verdict', () => {
  assert.deepEqual(judgeLines('k', { state: 'verified', criteria: [] }), []);
});

// ---- decisions and denials
const rec = (code, decision = 'deny') => DECISION_PREFIX + JSON.stringify({ decision, code });
test('decision records parse from a stderr line and the stream', () => {
  assert.equal(decisionRecords('noise\n' + rec('force_push') + '\ntail')[0].code, 'force_push');
  assert.deepEqual(decisionRecords(DECISION_PREFIX + '{broken'), []);
  const log = join(tmp(), 's.jsonl');
  writeFileSync(log, rec('push_needs_approval_surface') + '\n' + rec('destructive_git') + '\n');
  assert.deepEqual(
    summarize(log).decisions.map((r) => r.code),
    ['push_needs_approval_surface', 'destructive_git'],
  );
});
test('denial class per code', () => {
  const cls = (...recs) => denialClass({ decisions: recs })[0];
  const r = (c, d = 'deny') => ({ decision: d, code: c });
  assert.equal(cls(r('push_needs_approval_surface')), 'salvage');
  assert.equal(cls(r('destructive_delete')), 'triage');
  assert.equal(cls(r('destructive_git')), 'triage');
  assert.equal(cls(r('graph_run_not_open')), 'remediation');
  assert.equal(cls(r('force_push')), 'denied');
  assert.equal(cls(r('destructive_git'), r('push_needs_approval_surface')), 'triage');
  assert.equal(cls(r('graph_push_allowed', 'allow')), null);
  assert.equal(cls(), null);
});

// ---- skills_of
test('skills of reads the claim card', () => {
  assert.deepEqual(skillsOf('{"skills":[{"key":"close-books"},{"name":"deliver-via-github-pr"},"x"]}'), ['close-books', 'deliver-via-github-pr', 'x']);
  assert.deepEqual(skillsOf('not json'), []);
});
test('skills of reads the claimed node', () => {
  const wrapped = JSON.stringify({ state: 'claimed', graph_id: 'g', node: { key: 'k', skills: [{ slug: 'deliver-via-github-pr' }, 'other'] } });
  assert.deepEqual(skillsOf(wrapped), ['deliver-via-github-pr', 'other']);
});
test('skills of prefers the slug over the display name', () => {
  const card = JSON.stringify({
    state: 'claimed',
    graph_id: 'g',
    node: { key: 'k', type: 'bug' },
    skills: [{ slug: 'deliver-via-github-pr', name: 'Deliver via GitHub pull request', version: 1, body: '# x' }],
  });
  assert.deepEqual(skillsOf(card), ['deliver-via-github-pr']);
  assert.ok(skillsOf(card).includes(DELIVER_SKILL));
});
test('skills of reads attached skill rows', () => {
  const card = JSON.stringify({
    node_id: 'e5395ade',
    key: 'portal-vendor-bot',
    skills: [
      { node_id: 'e5395ade', position: 0, config: {}, skill: { id: '674fd6aa', slug: 'deliver-via-github-pr', version: 1, name: 'Deliver via GitHub PR' } },
    ],
  });
  assert.deepEqual(skillsOf(card), ['deliver-via-github-pr']);
  assert.deepEqual(skillsOf(JSON.stringify({ state: 'claimed', node: JSON.parse(card) })), ['deliver-via-github-pr']);
});

// ---- usage limits
test('limit reset time is parsed from the message', () => {
  const now = Date.UTC(2026, 9, 5, 13, 42) / 1000;
  const t = limitResetAt("You've hit your weekly limit · resets Oct 7, 8pm (America/New_York)", now);
  // 8pm EDT on Oct 7 2026 is 00:00Z Oct 8
  assert.equal(t, Date.UTC(2026, 9, 8, 0, 0) / 1000);
  assert.equal(limitResetAt('rate limited, try again later'), null);
  assert.ok(harnessLimitText({ result_text: "You've hit your weekly limit", error_text: null }));
  assert.equal(harnessLimitText({ result_text: 'the suite is red', error_text: null }), null);
});
test('a reported success mentioning rate limit is not a limit', () => {
  const s = { result_text: 'handled the rate limit and 429s', error_text: null, reported: true, result: 'success', is_error: false, num_turns: 40, turns: 40 };
  assert.equal(harnessLimitText(s), null);
  assert.ok(harnessLimitText({ ...s, reported: false, is_error: true, num_turns: 1, result_text: "You've hit your weekly limit" }));
});
test('limit hold is capped at 8 days', () => {
  const now = Date.UTC(2026, 0, 1) / 1000;
  assert.ok(limitResetAt('hit your weekly limit resets Dec 30, 8pm (UTC)', now) - now <= 8 * 86400);
  const past = limitResetAt('resets Jan 1, 1am (UTC)', now + 7200);
  assert.ok(past - (now + 7200) < 86400);
});
test('limit Feb 29 does not throw', () => {
  limitResetAt('resets Feb 29, 8pm (UTC)', Date.UTC(2026, 9, 5) / 1000);
});
test('limit multi-slash zone parses', () => {
  const now = Date.UTC(2026, 9, 5) / 1000;
  const t = limitResetAt('resets Oct 7, 8pm (America/Argentina/Buenos_Aires)', now);
  assert.equal(t, Date.UTC(2026, 9, 7, 23, 0) / 1000); // UTC-3
  assert.notEqual(limitResetAt('resets Oct 7, 8pm (UTC)', now), null);
});

// ---- failure outcome and remediation
test('failed outcome', () => {
  const base = {
    reported: true,
    report_status: 'succeeded',
    report_error: null,
    rejection: null,
    card_rejection: '{"reasons": ["old"]}',
    result: 'success',
    turns: 3,
    result_text: null,
  };
  assert.equal(failedOutcome(base, 0), null);
  assert.deepEqual(failedOutcome({ ...base, report_status: 'failed', report_error: 'E' }, 0), { error: 'E', rejection: '{"reasons": ["old"]}' });
  const o = failedOutcome({ ...base, rejection: '{"state": "rejected"}' }, 0);
  assert.match(o.error, /verdict rejected/);
  assert.equal(o.rejection, '{"state": "rejected"}');
  assert.match(failedOutcome({ ...base, reported: false }, 1).error, /without reporting/);
  assert.equal(rejectionOf('{"verification": {"state": "verified"}}', 'verification'), null);
});
test('remediation prompt carries the error, the rejection and the base prompt', () => {
  const p = remediationPrompt('g', node('a'), '/w', 'graph/a', [{ error: 'boom', rejection: null }]);
  assert.match(p, /^REMEDIATION LAUNCH \(attempt 2 this session\)/);
  assert.match(p, /Previous error: boom/);
  assert.match(p, /last_rejection: none on record/);
  assert.match(p, /Graph g, node id-a \(key `a`\)\./);
  assert.match(p, /Your git worktree is \/w on branch graph\/a/);
});

// ---- triage decision
const prereq = (n) => triageDecision({ triage: { action: 'prerequisite', reason: 'r', nodes: [{ key: 'k', title: 't', ...n }] } });
test('triage decision allowlists type and data', () => {
  let [t, why] = prereq({ type: 'merge' });
  assert.ok(t, why);
  assert.ok(!('type' in t.nodes[0]));
  assert.ok(t.dropped.some((d) => d.includes("type 'merge'")));
  [t] = triageDecision({ triage: { action: 'revise', reason: 'r', type: 'merge', description: 'd' } });
  assert.ok(!('type' in t));
  [t] = prereq({ data: { pr: 'other/repo#1', model: 'opus', max_turns: 999, tier: 'fast', repo: 'r' } });
  assert.deepEqual(t.nodes[0].data, { tier: 'fast', repo: 'r' });
  assert.equal(t.dropped.length, 3);
});
test('triage repo ../x is refused', () => {
  const [t, why] = prereq({ data: { repo: '../x' } });
  assert.equal(t, null);
  assert.match(why, /data\.repo/);
  assert.ok(unsafeIdent({ key: 'k', data: { repo: '../x' } }).includes('../x'));
});
test('triage key with a slash is refused', () => {
  const [t, why] = prereq({ key: 'a/b' });
  assert.equal(t, null);
  assert.match(why, /key/);
  assert.ok(unsafeIdent({ key: 'a/b' }));
  assert.equal(unsafeIdent({ key: 'ok-1.x', data: { repo: 'claude-plugins' } }), '');
});
test('invalid triage decision applies nothing', () => {
  assert.match(triageDecision({ triage: { action: 'rewrite-everything', reason: 'x' } })[1], /data\.triage\.action/);
  assert.equal(triageDecision({ triage: { action: 'gate', reason: 'r' } })[0], null);
  assert.equal(triageDecision({})[0], null);
  assert.equal(triageDecision({ triage: { action: 'revise', reason: 'r' } })[0], null);
  const [g] = triageDecision({ triage: { action: 'gate', reason: 'r', decision: 'May we?' } });
  assert.equal(g.action, 'gate');
});

// ---- harness parsers
test('summarize parses the claude e2e fixture', () => {
  const s = summarize(join(FX, 'claude-e2e.jsonl'), 'claude');
  assert.equal(s.result, 'success');
  assert.equal(s.turns, 23);
  assert.equal(s.reported, true);
  assert.equal(s.run_id, '5a1c33f4-e7bd-4f6b-8b52-2ce6a3c92754');
  assert.equal(s.session_id, 'd0273637-f02b-49c2-b9e0-cc0606713480');
  assert.ok(s.usage.output_tokens > 0);
});
test('summarize parses the grok json fixture', () => {
  const path = join(FX, 'grok-ok.json');
  const s = summarize(path, 'grok');
  assert.equal(s.result, 'success');
  assert.equal(s.result_text, 'ok');
  assert.equal(s.turns, 1);
  assert.equal(s.session_id, '01a10cc3-aed8-7b31-8e22-591b628266ee');
  assert.equal(s.usage.output_tokens, 27);
  assert.ok(Math.abs(s.cost - 0.00798252) < 1e-9);
  assert.equal(s.error_text, null);
  assert.equal(countTurns(path, 'grok'), 1);
});
test('summarize parses the grok stream fixture', () => {
  const s = summarize(join(FX, 'grok-stream.jsonl'), 'grok');
  assert.equal(s.reported, true);
  assert.equal(s.run_id, '5a1c33f4-e7bd-4f6b-8b52-2ce6a3c92754');
  assert.equal(s.result, 'success');
});
test('the codex parser ignores a stream with no codex events', () => {
  assert.equal(summarize(join(FX, 'grok-ok.json'), 'codex').turns, 0);
});

// ---- prune
const run = (args, cwd, cmd = 'git') => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function repoWithOrigin() {
  const t = tmp();
  const o = join(t, 'origin.git');
  run(['init', '-q', '--bare', '-b', 'main', o], t);
  const root = join(t, 'root');
  mkdirSync(root);
  const src = join(root, 'r');
  run(['clone', '-q', o, src], t);
  run(['config', 'user.email', 't@t'], src);
  run(['config', 'user.name', 't'], src);
  run(['commit', '-q', '--allow-empty', '-m', 'i'], src);
  run(['push', '-q', 'origin', 'HEAD:refs/heads/main'], src);
  run(['remote', 'set-head', 'origin', 'main'], src);
  return { t, root, src };
}
const addTree = (root, src, key) => run(['worktree', 'add', join(root, `r-${key}`), '-b', `graph/${key}`, 'origin/main'], src);
const names = (pairs) => pairs.map(([p]) => basename(p));
const quiet = () => {};

test('prune keeps dirty and unmerged', () => {
  const { root, src } = repoWithOrigin();
  for (const k of ['merged', 'dirty', 'unmerged']) addTree(root, src, k);
  writeFileSync(join(root, 'r-dirty', 'x.txt'), 'wip');
  writeFileSync(join(root, 'r-unmerged', 'u.txt'), 'u');
  run(['add', '-A'], join(root, 'r-unmerged'));
  run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'u'], join(root, 'r-unmerged'));
  let text = '';
  const { removed, kept } = pruneWorktrees(root, {
    yes: true,
    registry: {},
    prState: () => null,
    out: (s) => {
      text += s;
    },
    minAge: 0,
  });
  assert.deepEqual(names(removed), ['r-merged']);
  assert.ok(!existsSync(join(root, 'r-merged')));
  assert.deepEqual(Object.fromEntries(kept.map(([p, w]) => [basename(p), w])), { 'r-dirty': 'uncommitted changes', 'r-unmerged': 'unmerged commits' });
  assert.match(text, /Review 2 branches/);
  assert.ok(existsSync(join(root, 'r-dirty')));
  // an open PR keeps it; a merged PR frees it
  const open = pruneWorktrees(root, { registry: {}, prState: () => 'OPEN', out: quiet, minAge: 0 });
  assert.ok(open.kept.map(([, w]) => w).includes('open PR'));
  const merged = pruneWorktrees(root, { yes: true, registry: {}, prState: () => 'MERGED', out: quiet, minAge: 0 });
  assert.deepEqual(names(merged.removed), ['r-unmerged']);
});

test('prune keeps a live worker worktree', () => {
  const { t, root, src } = repoWithOrigin();
  addTree(root, src, 'live');
  addTree(root, src, 'fresh');
  // live: listed in pids.json; fresh: modified within the hour (default min_age)
  const { removed } = pruneWorktrees(root, { yes: true, registry: {}, prState: () => null, out: quiet, liveKeys: new Set(['live']), minAge: 0 });
  assert.deepEqual(names(removed), ['r-fresh']);
  assert.ok(existsSync(join(root, 'r-live')));
  addTree(root, src, 'fresh2');
  const young = pruneWorktrees(root, { yes: true, registry: {}, prState: () => null, out: quiet });
  assert.deepEqual(young.removed, []);
  assert.ok(existsSync(join(root, 'r-fresh2')));
  const d = join(t, 'dispatch', 'g');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'pids.json'), JSON.stringify({ workers: { live: 1 } }));
  assert.deepEqual([...liveWorkerKeys(join(t, 'dispatch'))], ['live']);
});

test('prune deletes the merged branch so a re-claim starts clean', () => {
  const { root, src } = repoWithOrigin();
  addTree(root, src, 'm');
  const { removed } = pruneWorktrees(root, { yes: true, registry: {}, prState: () => null, out: quiet, minAge: 0 });
  assert.equal(removed.length, 1);
  assert.equal(run(['branch', '--list', 'graph/m'], src).trim(), '');
  addTree(root, src, 'm'); // adds off the base cleanly
});

test('prune: an old merged PR with a different head is not a match', () => {
  const { t, root, src } = repoWithOrigin();
  addTree(root, src, 'o');
  const head = run(['rev-parse', 'graph/o'], src).trim();
  const bin = join(t, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "$GH_FAKE"\n', { mode: 0o755 });
  const old = { PATH: process.env.PATH, GH_FAKE: process.env.GH_FAKE };
  process.env.PATH = bin + ':' + old.PATH;
  try {
    process.env.GH_FAKE = JSON.stringify([{ state: 'MERGED', headRefOid: '0'.repeat(40) }]);
    assert.equal(ghPrState('graph/o', src), null);
    process.env.GH_FAKE = JSON.stringify([
      { state: 'MERGED', headRefOid: '0'.repeat(40) },
      { state: 'MERGED', headRefOid: head },
    ]);
    assert.equal(ghPrState('graph/o', src), 'MERGED');
  } finally {
    process.env.PATH = old.PATH;
    if (old.GH_FAKE === undefined) delete process.env.GH_FAKE;
    else process.env.GH_FAKE = old.GH_FAKE;
  }
});
