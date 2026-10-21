// The governor's decision, harness-neutral. Takes the common event
//   {hook_event_name, tool_name, tool_input, tool_response?, session_id, cwd,
//    transcript_path?, model?}
// decides, writes the tamper-evident log (through the core), and returns a
// plain answer. A harness shim translates the answer into its own vocabulary;
// nothing below the shim knows what that vocabulary is.
//
// Answer: { decision: 'allow'|'deny'|'ask'|null, reason, updatedInput?, notice?, record, line }
//   decision null = no objection (the harness's own flow decides); `notice` is
//   a message for the person. `reason` is the plain sentence a person reads;
//   `line` is the machine record. The shim puts `line` first only where no
//   person reads the reason (a headless session), so nobody is shown JSON.
import { toolEvent } from '../adapters/claude-code/events.mjs';
import { priceOf } from '../src/policy.mjs';
import { governor } from '../adapters/claude-code/index.mjs';
import { decisionRecord, decisionLine } from '../core/codes.mjs';

const up = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const SAVED = 'A record of this decision was saved.';
const GOV = '/enforcer:governor';

export async function decide(ev) {
  const event = toolEvent(ev);
  const { verdict, spend } = await governor().before(event);
  const spent = spend.tokens,
    budget = spend.budget;
  const record = decisionRecord(verdict, { tool: event.name, run_id: event.runId });
  const line = decisionLine(record);
  const answer = (decision, reason, extra = {}) => ({ decision, reason, record, line, ...extra });

  const perM = priceOf(spend.model || '').in;
  const usd = (t) => '$' + ((t / 1e6) * perM).toFixed(2);
  const used = budget ? `So far this AI has used ${usd(spent)} of its ${usd(budget)} spending limit.` : `So far this AI has used ${usd(spent)}.`;

  // A decision by the organisation's policy quotes the policy, as written.
  if (verdict.action === 'deny' && verdict.source === 'policy')
    return answer(
      'deny',
      `Your organisation's Enforcer policy blocked this action: ${verdict.reason}. Nothing was run. The AI can carry on with other work. ${SAVED}`,
    );
  if (verdict.action === 'ask' && verdict.source === 'policy')
    return answer('ask', `Your organisation's Enforcer policy asks you to confirm this action: ${verdict.reason}. Let it go ahead this once?`);

  // On a subscription the dollar figures are an estimate at standard prices, not a bill.
  const onPlan = event.billing === 'plan';
  const money = onPlan ? ' This is an estimate of what the work would cost; your subscription is not charged extra.' : '';
  const turnOff = onPlan ? ` To stop using spending limits on your subscription, type ${GOV} set budgetOn false.` : '';
  const resume = `To let it carry on, type ${GOV} resume.`;

  if (verdict.action === 'deny') {
    if (!verdict.stopsAgent)
      return answer('deny', `Enforcer blocked this action: ${verdict.reason}. Nothing was run. The AI can carry on with other work. ${SAVED}`);
    // Stopped by a person, or by a "no" to an earlier question: the way out is resume.
    if (record.code === 'agent_stopped' || record.code === 'ask_declined')
      return answer('deny', `Enforcer is holding the AI: ${verdict.reason}. ${resume} ${SAVED}`);
    return answer(
      'deny',
      `Enforcer stopped the AI because ${verdict.reason}. ${used}${money} To let it carry on, type ${GOV} limit followed by a higher dollar amount, for example ${GOV} limit 40.${turnOff} ${SAVED}`,
    );
  }

  if (verdict.action === 'ask')
    return answer(
      'ask',
      verdict.isCapability
        ? `Enforcer wants to check with you first. This action ${verdict.reason}. Let it go ahead this once?`
        : `Enforcer paused the AI to check with you: ${verdict.reason}. ${used}${money} If you say no, the AI stays paused until you type ${GOV} resume. Let it keep going?`,
    );

  // An affirmative grant: only the graph-worker rules allow.
  if (verdict.action === 'allow' && verdict.source === 'capability') return answer('allow', `Enforcer allowed this: ${verdict.reason}.`);

  // A rewrite is put to the person as an ask carrying the rewritten input.
  if (verdict.action === 'rewrite')
    return answer('ask', `Enforcer changed this command to make it safer. ${up(verdict.reason)}. Run the safer version?`, {
      updatedInput: verdict.input,
      notice: `Enforcer changed this command to make it safer. ${up(verdict.reason)}.`,
    });

  // Advice never changes the decision.
  if (verdict.advice)
    return {
      decision: null,
      notice: `Enforcer tip: ${verdict.advice.why}. To switch, type /model ${verdict.advice.suggest}. This is only a suggestion; nothing was blocked. ${used}${money}`,
      record,
      line,
    };

  // The one silent pass that speaks is the blind one.
  if (!verdict.checked.includes('economics')) return { decision: null, notice: verdict.reason, record, line };
  return { decision: null, record, line };
}
