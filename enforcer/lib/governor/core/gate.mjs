// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// The gate. Composes the two layers, and owns the one thing v1 and v2 only
// ever expressed in comments: THEY FAIL IN OPPOSITE DIRECTIONS, ON PURPOSE.
//
//   capability  needs no state  ->  FAIL CLOSED
//   economics   needs state     ->  FAIL OPEN
//
// Both halves of that are load-bearing. Failing closed on spend would mean a
// governor that blocks real work over a missing file of its own, which has
// failed at something more important than enforcing. Failing open on
// capability made `rm ~/.enforcer-governor/state.json` a way to switch off
// every rule — and, worse, it was the state the tool sat in by default: on the
// machine this was found on, the v1 hook ran before all 19 tool calls of a
// session and enforced nothing, because the daemon it asked was not running.
// Every call returned "allow (not checked)" and nobody noticed.
//
// Everything the gate needs is injected. That is not ceremony: it means the
// whole decision path is testable without a lock, a disk, or a clock, and it
// is the seam where the cost source is swapped for the harness's own figure
// without any of the logic below knowing.

import { Verdict, ECONOMICS, CAPABILITY, POLICY } from './verdict.mjs';
import { isOn, isOff } from './bool.mjs';
import { evaluate as capability, DEFAULT_RULES, resolveRules } from './capability.mjs';
import { evaluate as worker } from './worker.mjs';
import { checksOff } from './policy.mjs';

/**
 * Fold the tenant's answer (central.mjs) into the local capability verdict.
 *
 * The asymmetry is the design, so it is spelled out as a table rather than
 * left to be inferred from branches:
 *
 *                 local deny   local ask       local rewrite
 *   tenant deny   deny         deny            deny
 *   tenant ask    deny         ask (tenant's)  ask (tenant's)
 *   tenant allow  deny         no objection    rewrite
 *   silent        deny         ask             rewrite
 *   unreachable   deny         ask             rewrite
 *
 * A tenant can make anything stricter and can waive a confirmation. It cannot
 * lift a local hard deny, and it cannot skip a rewrite, which already runs
 * what was asked in a safer form. Losing the tenant's answer changes nothing.
 */
export function compose(cap, central) {
  if (!cap || !central) return cap;
  const base = { rule: cap.rule, ruleId: cap.ruleId, checked: [...cap.checked, POLICY], policy: central.opinion };
  if (central.opinion === 'deny') {
    return Verdict.deny(central.reason || "your organisation's rules do not allow it", { ...base, source: POLICY, code: 'tenant_policy' });
  }
  if (central.opinion === 'ask' && cap.action !== 'deny') {
    return Verdict.ask(central.reason || "your organisation's rules ask a person to confirm it", { ...base, source: POLICY, code: 'tenant_policy' });
  }
  if (central.opinion === 'allow' && cap.action === 'ask') {
    return null; // the tenant waived the confirmation; economics still runs
  }
  // silent, unreachable, or an allow that may not lift this verdict: the local
  // answer stands, and the receipt records that the tenant was asked.
  const checked = central.opinion === 'unreachable' ? cap.checked : base.checked;
  return new Verdict({ ...cap, checked, policy: central.opinion });
}

/**
 * @param ev    {{action,tool,input,agent,cwd,model,task}}  what the agent wants to do
 * @param cfg   config (rulesOn / budgetOn / rules ...)
 * @param deps  {{ withState, economics }}
 *   withState(fn) -> { ok, value }   run fn under the lock; never throws
 *   economics(state, ev, cfg) -> Verdict|null   Layer B; null means no opinion
 * @returns {Verdict}
 */
export function gate(ev, cfg = {}, deps = {}) {
  const rules = resolveRules(cfg);

  // Layer A runs first and runs unconditionally. "You may not do this"
  // outranks "you have budget left" — a cheap command is still the destructive
  // one, and the rule that stops it must not depend on the bookkeeping being
  // healthy. It is also why this call sits ABOVE the state load rather than
  // inside its success branch.
  // deps.central is the tenant's answer for the rule that matched, fetched by
  // the hook BEFORE this runs — the gate stays synchronous and network-free.
  //
  // The graph-worker rules (worker.mjs) go first: they are the only rules that
  // can ALLOW, and a headless force-push must be refused rather than rewritten
  // into a prompt nobody will answer. A tenant can still refuse what they allow.
  if (!isOff(cfg.rulesOn)) {
    // The tenant is asked about the WORKER rule id (deps.workerCentral), not only
    // the capability rule that matched: otherwise a tenant could never veto a push.
    const w = compose(worker(ev), deps.workerCentral !== undefined ? deps.workerCentral : deps.central);
    // A worker allow does not skip the capability rules, and a worker shape
    // refusal yields to a capability code that names the harm (a credentials
    // file in the command). Nobody can answer an ask headless, so it is a deny.
    if (w && (w.action === 'allow' || w.code === 'delivery_shape')) {
      const c = compose(capability(rules, ev), deps.central);
      // The worker rule already judged this delete (inside the worker's own worktree), so the
      // capability rule's blanket fs.delete_tree ask is the one opinion it overrides.
      const own = w.code === 'worktree_delete_allowed' && c && c.ruleId === 'fs.delete_tree';
      if (c && c.action !== 'allow' && !own) {
        return ev.worker?.headless && c.action === 'ask' ? new Verdict({ ...c, action: 'deny' }) : c;
      }
    }
    // A worker allow must also clear the spend latches: a paused, grounded or
    // human-stopped agent cannot push, open a pull request or land.
    if (w && w.action === 'allow' && typeof deps.withState === 'function') {
      const held = deps.withState((state, reading) => deps.economics(state, { ...ev, ...(reading || {}) }, cfg));
      const e = held.ok ? held.value : null;
      if (e && e.action !== 'allow') {
        return ev.worker?.headless && e.action === 'ask' ? new Verdict({ ...e, action: 'deny' }) : e;
      }
    }
    if (w) return w;
  }
  const cap = compose(capability(rules, ev), deps.central);
  if (cap && cap.action !== 'allow') return cap;
  const waived = deps.central?.opinion === 'allow' && !cap;

  // Spend off does NOT mean capability off, hence this sitting below
  // the call above rather than at the top of the function, which is where v2
  // had it. There it returned early when spend and the old loop check were off
  // and took the capability rules down with it, whatever `rulesOn` said. The
  // README has always described three independent switches ("rulesOn the
  // capability rules ... all three off is fully inert"), so the code and the
  // documented contract disagreed, and the code was the wrong one: turning off
  // spend tracking silently gave up `curl | sh` and `rm -rf` as well. Nothing
  // in the suite pinned it, which is why it survived.
  if (checksOff(cfg)) {
    return Verdict.allow('decision checks are switched off', {
      code: 'checks_off',
      source: ECONOMICS,
      checked: [CAPABILITY, ECONOMICS],
      policy: waived ? 'allow' : null,
    });
  }

  // withState hands back a `reading` alongside the state: what this session has
  // cost so far. It is passed IN rather than computed here on purpose — that is
  // the seam where the harness's own total_cost_usd replaces our arithmetic
  // without a single check in economics.mjs knowing the difference.
  const held =
    typeof deps.withState === 'function' ? deps.withState((state, reading) => deps.economics(state, { ...ev, ...(reading || {}) }, cfg)) : { ok: false };

  // The blind path. Capability already had its say above and found nothing, so
  // the honest answer is "allowed, and I did not look at the money" — recorded
  // as such via checked[], not buried in a sentence a reader has to parse.
  if (!held.ok) {
    return Verdict.allow('Enforcer could not read its own records, so it did not check spending for this action. Nothing was blocked.', {
      source: ECONOMICS,
      checked: [CAPABILITY],
      policy: waived ? 'allow' : null,
    });
  }

  const econ = held.value;
  if (econ) return econ;
  return Verdict.allow('in budget', { source: ECONOMICS, checked: [CAPABILITY, ECONOMICS], policy: waived ? 'allow' : null });
}
