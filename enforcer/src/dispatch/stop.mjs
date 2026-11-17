// A run that stopped without success: classify why from text already on record, and the
// graph writes that carry it. No model is called. Suggested text is a prefix of an error
// line, a gate option, a question, or a report or observation line.
import { isPrivate } from './model.mjs';
import { nextStep } from './remediate.mjs';
import { LIMIT_RE } from './summarize.mjs';

export const SUMMARY_MAX = 300;

/** Closed set. `failed_after_n` is the residual when no earlier signal matches. */
export const STOP_WHYS = Object.freeze([
  'needs_decision',
  'needs_credential',
  'needs_human_action',
  'prereq',
  'harness_limit',
  'policy_denied',
  'failed_after_n',
]);

/**
 * Observation kinds the locked graph spec accepts. `dispatcher_note` is not one of them.
 * The note is posted as kind `summary` with source `dispatcher_note`.
 */
export const OBSERVATION_KINDS = Object.freeze(['finding', 'decision', 'summary', 'brief']);
export const OBSERVATION_KIND = 'summary';
export const OBSERVATION_SOURCE = 'dispatcher_note';

/**
 * What the locked graph spec does not do, so this client does not invent an endpoint for it.
 * Listed for the operator; the writes below use only routes that already exist.
 */
export const GRAPH_DEPENDENCIES = Object.freeze([
  'POST /graphs/{graphId}/nodes/{nodeId}/observations accepts kind finding, decision, summary, or brief. A dispatcher_note kind is not in that enum. The note is kind "summary", source "dispatcher_note", and data.stop is the same record as the run. A first-class kind is a graph schema change.',
  'POST /graphs/{graphId}/nodes/{nodeId}/runs/{runId}/complete (and PATCH on the run) accept data as an open object, so data.stop rides on the complete this dispatcher already performs. A run that has already ended is 409 run_already_ended. No existing route sets data on a closed run, and none sets it without closing the run. A harness-limit hold leaves the run to lapse; the stop is on the observation only.',
  'Needs-you (internal_work.TimelineNode.needs_person, the graph list filter) is an open gate or finished work waiting on arbitration. It does not read run.data.stop or a dispatcher_note observation. Showing this context there is graph-side.',
  "question.asked records node_id and key and never the question text. The text is read with the existing GET /graphs/{graphId}/questions?open=true. The question email stays the server's. Needs-you does not list open questions.",
  'POST observation may send a new body to the judgment model. A private node (server private or data.private) does not post that observation. The spec has no judgment-free observation write.',
]);

const CRED_RE = /needs-auth|invalid_grant|unauthori[sz]ed|\bcredentials?\b|\bapi[- ]?key\b|not signed in|sign in required|\b401\b/i;
const PREREQ_RE = /\bprerequisites?\b|\bprereq\b/i;
const HUMAN_RE = /needs a person|human action|landing blocked|a person must/i;
const POLICY_RE = /policy denied|permission denied|destructive_/i;
const LIMIT_EXTRA_RE = /\berror_max_turns\b|\bmax[_ ]turns\b|\bover[_ ]cap\b/i;
const DECISION_KINDS = new Set(['human_decision', 'decision']);
const PREREQ_KINDS = new Set(['prerequisite', 'prereq']);
const HUMAN_KINDS = new Set(['human_action', 'human', 'file']);

/** Collapse whitespace and cut to at most n characters. The cut is a prefix of that line. */
export function clipSummary(text, n = SUMMARY_MAX) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= n ? s : s.slice(0, n);
}

const str = (x) => (typeof x === 'string' && x.trim() ? x : '');

function needsRecord(input) {
  const direct = input.reportData?.needs;
  if (direct) return direct;
  for (const o of input.observations || []) if (o?.data?.needs) return o.data.needs;
  return null;
}

function needsKind(input) {
  const n = needsRecord(input);
  return n && typeof n === 'object' && typeof n.kind === 'string' ? n.kind : '';
}

function needsWhat(input) {
  const n = needsRecord(input);
  if (typeof n === 'string') return n;
  if (n && typeof n.what === 'string') return n.what;
  return '';
}

/** Gate / report / observation options, copied as strings. */
export function stopOptions(input) {
  const raw = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) if (typeof x === 'string' && x.trim()) raw.push(clipSummary(x));
  };
  push(input.options);
  push(input.node?.data?.options);
  push(input.reportData?.options);
  for (const o of input.observations || []) push(o?.data?.options);
  return [...new Set(raw)];
}

function linesOf(input) {
  const out = [];
  const push = (s) => {
    const t = str(s);
    if (t) out.push(t);
  };
  push(input.error);
  push(input.report);
  push(input.reportError);
  push(needsWhat(input));
  for (const o of input.observations || []) push(o?.body);
  push(input.question?.text);
  push(input.node?.data?.decision);
  push(input.node?.title);
  return out;
}

function summarySource(input, why, lines) {
  if (why === 'needs_decision' && str(input.question?.text)) return input.question.text;
  if (why === 'needs_decision' && str(input.node?.data?.decision)) return input.node.data.decision;
  if ((why === 'prereq' || why === 'needs_human_action') && needsWhat(input)) return needsWhat(input);
  if (str(input.error)) return input.error;
  if (str(input.report)) return input.report;
  if (str(input.reportError)) return input.reportError;
  return lines[0] || '';
}

function whoOf(input) {
  if (str(input.question?.to)) return input.question.to.trim();
  const a = input.node?.assignee;
  if (a && typeof a === 'object') {
    if (str(a.account_id)) return a.account_id.trim();
    if (str(a.group_slug)) return a.group_slug.trim();
  }
  if (str(a)) return a.trim();
  if (str(input.node?.data?.suggested_who)) return input.node.data.suggested_who.trim();
  return null;
}

function triedOf(input) {
  const rows = Array.isArray(input.tried) ? input.tried : [];
  return rows.map((t) => ({
    run: t?.run ?? null,
    harness: t?.harness ?? null,
    model: t?.model ?? null,
    route: t?.route ?? null,
    error: t?.error == null || t.error === '' ? null : clipSummary(String(t.error)),
  }));
}

function needsOf(input, summary) {
  const n = needsRecord(input);
  if (n && typeof n === 'object') {
    const what = clipSummary(typeof n.what === 'string' && n.what.trim() ? n.what : summary);
    const kind = typeof n.kind === 'string' && n.kind.trim() ? n.kind.trim() : null;
    return kind ? { kind, what } : { what };
  }
  if (typeof n === 'string' && n.trim()) return clipSummary(n);
  return summary;
}

/**
 * Pick a stop reason. Earlier rows win, so a usage limit is not also "failed after N".
 * Every match is a flag the caller already set or a line in `blob`.
 */
export function pickWhy(input, blob) {
  const limit = input.harnessLimit || input.overCap || LIMIT_RE.test(blob) || LIMIT_EXTRA_RE.test(blob);
  if (limit) return 'harness_limit';
  const kind = input.denialKind || '';
  const code = String(input.denialCode || '');
  if (kind === 'denied' || kind === 'triage' || code.startsWith('destructive_') || POLICY_RE.test(blob)) return 'policy_denied';
  const mcp = input.mcp && typeof input.mcp === 'object' ? input.mcp : {};
  const needsAuth = Object.values(mcp).some((v) => String(v) === 'needs-auth');
  if (needsAuth || CRED_RE.test(blob)) return 'needs_credential';
  const nk = needsKind(input);
  const node = input.node || {};
  const asked = !!(input.question && (str(input.question.text) || input.question.id));
  if (asked || node.type === 'gate' || DECISION_KINDS.has(nk) || /\bhuman decision\b/i.test(blob)) return 'needs_decision';
  if (PREREQ_KINDS.has(nk) || PREREQ_RE.test(blob)) return 'prereq';
  if (kind === 'salvage' || code === 'push_needs_approval_surface' || HUMAN_KINDS.has(nk) || HUMAN_RE.test(blob)) return 'needs_human_action';
  return 'failed_after_n';
}

/**
 * The structured stop. `summary`, `needs`, `options`, and `suggested_who` are copied from
 * `input` (error, report, observations, question, gate options, assignee). Nothing is composed.
 */
export function classifyStop(input = {}) {
  const lines = linesOf(input);
  const why = pickWhy(input, lines.join('\n'));
  if (!STOP_WHYS.includes(why)) throw new Error(`stop why ${why} is not in ${STOP_WHYS.join('|')}`);
  const summary = clipSummary(summarySource(input, why, lines));
  return {
    why,
    summary,
    tried: triedOf(input),
    needs: needsOf(input, summary),
    options: stopOptions(input),
    suggested_who: whoOf(input),
  };
}

/**
 * Remediation relaunches. A denial that must not relaunch, or attempts spent, is a stop:
 * classify locally. `--no-triage` still classifies; it does not launch a model either.
 * `denialKind` salvage | denied | triage forces the stop on this attempt.
 */
export function stopStep({ attempts, maxAttempts, noTriage = false, triaged = false, denialKind = null }) {
  if (denialKind === 'salvage' || denialKind === 'denied' || denialKind === 'triage') return 'stop';
  const step = nextStep({ attempts, maxAttempts, noTriage, triaged });
  return step === 'remediate' ? 'remediate' : 'stop';
}

/**
 * The two existing writes. `model` is always null: this record is not a prompt.
 * A private node gets the run complete (the email path already posts the error there)
 * and no observation, because that route may judge the body.
 * `email` keeps data.needs_person and data.reason on the complete the give-up path already sends.
 * @param {{ node?: object, stop?: { summary?: string }, runId?: string|null, reason?: string|null, email?: boolean }} [opts]
 */
export function planStopWrites({ node, stop, runId = null, reason = null, email = false } = /** @type {any} */ ({})) {
  const complete = runId
    ? {
        status: 'failed',
        ...(reason ? { error: reason } : {}),
        data: {
          runner: 'graph-dispatch',
          ...(email ? { needs_person: true, reason } : {}),
          stop,
        },
      }
    : null;
  if (isPrivate(node)) return { complete, observation: null, model: null, withheld: 'private' };
  if (!stop?.summary) return { complete, observation: null, model: null, withheld: 'no-text' };
  return {
    complete,
    observation: {
      kind: OBSERVATION_KIND,
      source: OBSERVATION_SOURCE,
      body: stop.summary,
      data: { dispatcher_note: true, stop },
    },
    model: null,
    withheld: null,
  };
}

/**
 * An open question. The server has already emailed. A private node produces no payload
 * and the question text is not copied into the result.
 */
export function questionStopPlan(node, question, extra = {}) {
  if (isPrivate(node)) return { complete: null, observation: null, model: null, withheld: 'private', stop: null };
  const stop = classifyStop({ node, question, ...extra });
  return { ...planStopWrites({ node, stop, runId: null, email: false }), stop };
}
