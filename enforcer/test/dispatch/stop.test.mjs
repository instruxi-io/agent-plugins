// `node --test test/dispatch/stop.test.mjs`: stop classification, the 300-character cut, the private path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUMMARY_MAX,
  STOP_WHYS,
  OBSERVATION_KINDS,
  OBSERVATION_KIND,
  OBSERVATION_SOURCE,
  GRAPH_DEPENDENCIES,
  classifyStop,
  clipSummary,
  planStopWrites,
  questionStopPlan,
  stopStep,
} from '../../src/dispatch/stop.mjs';

const spent = { attempts: 2, maxAttempts: 2 };
const node = { id: 'n1', key: 'k1', type: 'task', data: {} };

function stop(extra) {
  return classifyStop({ node, ...spent, ...extra });
}

test('each why is one of the closed set and comes from a line already on record', () => {
  const cases = [
    {
      why: 'needs_decision',
      input: { question: { id: 'q1', text: 'Which region should the bucket live in?', to: 'acct-7' } },
      summary: 'Which region should the bucket live in?',
      who: 'acct-7',
    },
    {
      why: 'needs_credential',
      input: { error: 'plugin:enforcer needs-auth', mcp: { 'plugin:enforcer:mcp': 'needs-auth' } },
      summary: 'plugin:enforcer needs-auth',
    },
    {
      why: 'needs_human_action',
      input: {
        error: 'landing blocked: conflict with the base',
        denialKind: 'salvage',
        denialCode: 'push_needs_approval_surface',
        reportData: { needs: { kind: 'human_action', what: 'landing blocked: conflict with the base' } },
      },
      summary: 'landing blocked: conflict with the base',
    },
    {
      why: 'prereq',
      input: {
        error: 'blocked on a prerequisite',
        observations: [{ body: 'blocked on a prerequisite', data: { needs: { kind: 'prerequisite', what: 'schema migration is not applied' } } }],
      },
      summary: 'schema migration is not applied',
    },
    {
      why: 'harness_limit',
      input: { error: "You've hit your weekly limit", harnessLimit: true },
      summary: "You've hit your weekly limit",
    },
    {
      why: 'policy_denied',
      input: { error: 'destructive_shell: permission denied', denialKind: 'denied', denialCode: 'destructive_shell' },
      summary: 'destructive_shell: permission denied',
    },
    {
      why: 'failed_after_n',
      input: {
        error: 'exited (code 1, result error, 3 turns) without reporting: assertion failed',
        tried: [{ run: 'run-1', harness: 'claude', model: 'sonnet', route: 'standard', error: 'assertion failed' }],
      },
      summary: 'exited (code 1, result error, 3 turns) without reporting: assertion failed',
    },
  ];
  assert.deepEqual(
    cases.map((c) => c.why),
    [...STOP_WHYS],
  );
  for (const c of cases) {
    const s = stop(c.input);
    assert.equal(s.why, c.why);
    assert.equal(s.summary, c.summary);
    assert.ok(s.summary.length <= SUMMARY_MAX);
    assert.ok(STOP_WHYS.includes(s.why));
    if (c.who) assert.equal(s.suggested_who, c.who);
    const plan = planStopWrites({ node, stop: s, runId: 'run-1', reason: 'left for a person: ' + s.summary, email: true });
    assert.equal(plan.model, null);
    assert.equal(plan.observation.source, OBSERVATION_SOURCE);
    assert.equal(plan.observation.body, s.summary);
    assert.deepEqual(plan.observation.data.stop, s);
    assert.equal(plan.complete.data.needs_person, true);
    assert.equal(plan.complete.data.stop, s);
    assert.ok(OBSERVATION_KINDS.includes(plan.observation.kind));
    assert.equal(plan.observation.kind, OBSERVATION_KIND);
  }
});

test('a gate decision and its options are copied, not rewritten', () => {
  const s = classifyStop({
    node: { type: 'gate', key: 'ship', title: 'Ship it', data: { decision: 'Ship to prod?', options: ['approve', 'reject'] } },
    ...spent,
  });
  assert.equal(s.why, 'needs_decision');
  assert.equal(s.summary, 'Ship to prod?');
  assert.deepEqual(s.options, ['approve', 'reject']);
  assert.equal(s.needs, 'Ship to prod?');
});

test('summary and tried errors are cut to 300 characters', () => {
  const raw = 'e'.repeat(301);
  assert.equal(clipSummary(raw).length, SUMMARY_MAX);
  assert.equal(clipSummary(raw), 'e'.repeat(300));
  assert.equal(clipSummary('e'.repeat(300)).length, 300);
  const s = stop({
    error: raw,
    tried: [{ run: 'r', harness: 'grok', model: 'qwen', route: 'local', error: raw }],
  });
  assert.equal(s.why, 'failed_after_n');
  assert.equal(s.summary.length, 300);
  assert.equal(s.summary, raw.slice(0, 300));
  assert.equal(s.tried[0].error.length, 300);
  assert.equal(s.tried[0].error, raw.slice(0, 300));
  assert.deepEqual(
    { run: s.tried[0].run, harness: s.tried[0].harness, model: s.tried[0].model, route: s.tried[0].route },
    { run: 'r', harness: 'grok', model: 'qwen', route: 'local' },
  );
  const q = 'Q' + 'u'.repeat(300);
  const asked = classifyStop({ question: { text: q, to: 'who-1' } });
  assert.equal(asked.why, 'needs_decision');
  assert.equal(asked.summary.length, 300);
  assert.equal(asked.summary, q.slice(0, 300));
});

test('a private node keeps data.stop on the run and sends nothing to an observation or a model', () => {
  const secret = 'token sk-live-' + 'x'.repeat(290);
  const priv = { id: 'n', key: 'secret-node', private: true, data: { private: true } };
  const s = classifyStop({
    node: priv,
    error: secret,
    ...spent,
    tried: [{ run: 'r1', harness: 'claude', model: 'qwen', route: 'local', error: secret }],
  });
  assert.equal(s.summary.length, 300);
  assert.equal(s.summary, secret.slice(0, 300));
  for (const node of [priv, { key: 'p', data: { private: true } }, { key: 'p', private: true, data: {} }]) {
    const plan = planStopWrites({ node, stop: s, runId: 'r1', reason: 'left for a person: ' + s.summary, email: true });
    assert.equal(plan.observation, null);
    assert.equal(plan.model, null);
    assert.equal(plan.withheld, 'private');
    assert.equal(plan.complete.status, 'failed');
    assert.equal(plan.complete.data.needs_person, true);
    assert.equal(plan.complete.data.stop, s);
  }
  const q = questionStopPlan({ data: { private: true }, key: 'p' }, { id: 'q9', text: 'SECRET QUESTION TEXT', to: 'acct' });
  assert.equal(q.observation, null);
  assert.equal(q.model, null);
  assert.equal(q.stop, null);
  assert.equal(q.withheld, 'private');
  assert.equal(JSON.stringify(q).includes('SECRET'), false);
});

test('an open question is a dispatcher_note and not a second email', () => {
  const plan = questionStopPlan(node, { id: 'q2', text: 'Which client file is this for?', to: 'acct-2' });
  assert.equal(plan.stop.why, 'needs_decision');
  assert.equal(plan.stop.summary, 'Which client file is this for?');
  assert.equal(plan.stop.suggested_who, 'acct-2');
  assert.equal(plan.complete, null);
  assert.equal(plan.model, null);
  assert.equal(plan.observation.source, OBSERVATION_SOURCE);
  assert.equal(plan.observation.body, plan.stop.summary);
  assert.deepEqual(plan.observation.data.stop, plan.stop);
  assert.equal(plan.observation.data.needs_person, undefined);
});

test('attempts remaining remediate; a spent or denied attempt stops without a model', () => {
  assert.equal(stopStep({ attempts: 1, maxAttempts: 2 }), 'remediate');
  assert.equal(stopStep({ attempts: 2, maxAttempts: 2 }), 'stop');
  assert.equal(stopStep({ attempts: 2, maxAttempts: 2, noTriage: true }), 'stop');
  assert.equal(stopStep({ attempts: 1, maxAttempts: 2, denialKind: 'triage' }), 'stop');
  assert.equal(stopStep({ attempts: 1, maxAttempts: 2, denialKind: 'denied' }), 'stop');
  assert.equal(stopStep({ attempts: 1, maxAttempts: 2, denialKind: 'salvage' }), 'stop');
});

test('triage flags parse and the grace must be a number of minutes', async () => {
  const { parseDispatchArgs } = await import('../../src/dispatch/run.mjs');
  const a = parseDispatchArgs(['g', '--no-triage', '--triage-grace', '10', '--triage-model', 'haiku'], {});
  assert.equal(a.noTriage, true);
  assert.equal(a.triageGrace, 10);
  assert.equal(a.triageModel, 'haiku');
  assert.throws(() => parseDispatchArgs(['g', '--triage-grace', '-1'], {}), /triage-grace/);
});

test('the graph gaps are the missing schema, not a new route', () => {
  const text = GRAPH_DEPENDENCIES.join('\n');
  assert.match(text, /dispatcher_note/);
  assert.match(text, /finding, decision, summary, or brief/);
  assert.match(text, /Needs-you/);
  assert.match(text, /run_already_ended/);
  assert.match(text, /questions/);
  assert.match(text, /private/);
  assert.equal(OBSERVATION_KINDS.includes('dispatcher_note'), false);
});
