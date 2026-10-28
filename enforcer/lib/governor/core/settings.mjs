// The knobs, described.
//
// v3 inherited 26 settings and exactly one way to change any of them:
// /enforcer-governor:limit, which sets the per-agent cap. The other 25 — daily
// and monthly ceilings, per-client caps, burn and fan-out thresholds, whether
// the soft mark asks or stops — are real, enforced, and reachable only by
// hand-editing JSON. That is not a missing feature, it is a regression: v1's
// console existed to turn exactly these dials, and every control carried its
// own explanation behind a "?" because six standing paragraphs read as a wall.
// v2 deleted the console and replaced it with nothing.
//
// So this file is the console's content without its pixels: what each setting
// is, in what unit, what it does, and what a sane value looks like. It is used
// three ways — to render /config, to validate /set, and as the only place a
// new setting has to be described.
//
// Validation is not decoration here. These values are compared against spend
// on every tool call, and the failure that matters is silent: a soft mark of
// 75 instead of 0.75 means the warn never fires, and nothing tells you.

export const GROUPS = ['limits', 'rates', 'checks', 'attribution', 'identity'];

const num = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return `not a number: ${v}`;
  if (n < min || n > max) return `must be between ${min} and ${max}`;
  return null;
};
const bool = () => (v) => (['true', 'false', 'on', 'off', 'yes', 'no', '1', '0'].includes(String(v).toLowerCase()) ? null : `expected true or false, got ${v}`);
const oneOf =
  (...ok) =>
  (v) =>
    ok.includes(String(v)) ? null : `expected one of ${ok.join(', ')}`;

export const parseValue = (spec, raw) => {
  if (spec.type === 'boolean') return ['true', 'on', 'yes', '1'].includes(String(raw).toLowerCase());
  if (spec.type === 'number') return Number(raw);
  return String(raw);
};

export const SETTINGS = {
  // ── limits ────────────────────────────────────────────────────────────────
  dollars: {
    group: 'limits',
    type: 'number',
    unit: '$',
    check: num(0.01, 100000),
    describe: 'Spend cap per agent. The one number to get right.',
    hint: 'A long session runs $20-$80, so a cap that binds sits above that, not at it.',
  },
  soft: {
    group: 'limits',
    type: 'number',
    unit: 'fraction',
    check: num(0.05, 1),
    describe: 'Fraction of the cap where the governor speaks up.',
    hint: 'A FRACTION, not a percent: 0.75, never 75.',
  },
  softAction: {
    group: 'limits',
    type: 'string',
    check: oneOf('escalate', 'deny'),
    describe: 'At the soft mark: ask a human (escalate) or stop the agent (deny).',
    hint: 'escalate for interactive work, deny for anything unattended.',
  },
  dailyLimit: {
    group: 'limits',
    type: 'number',
    unit: '$/day',
    check: num(0, 1e6),
    describe: 'Total across every agent, per day. 0 is off.',
    hint: 'This is the one that bounds a team; the per-agent cap only bounds one session.',
  },
  weeklyLimit: { group: 'limits', type: 'number', unit: '$/week', check: num(0, 1e6), describe: 'Total across every agent, per week. 0 is off.' },
  monthlyLimit: { group: 'limits', type: 'number', unit: '$/month', check: num(0, 1e6), describe: 'Total across every agent, per month. 0 is off.' },

  // ── rates ─────────────────────────────────────────────────────────────────
  burnLimit: {
    group: 'rates',
    type: 'number',
    unit: '$/min',
    check: num(0, 1000),
    describe: 'Per agent. Asks rather than blocks. 0 is off.',
    hint: 'Ordinary work runs $0.10-$0.25 a minute, so the default sits ~8x above it.',
  },
  fleetBurnLimit: { group: 'rates', type: 'number', unit: '$/min', check: num(0, 1000), describe: 'Across every agent at once. 0 is off.' },
  fanoutLimit: {
    group: 'rates',
    type: 'number',
    unit: 'agents/min',
    check: num(0, 1000),
    describe: 'New agents started in a minute before asking. 0 is off.',
    hint: 'About the SHAPE of the arrival: an orchestrator spawning spawners is exponential.',
  },
  retryLimit: {
    group: 'rates',
    type: 'number',
    unit: 'errors/min',
    check: num(0, 1000),
    describe: 'Upstream errors in a minute before asking. 0 is off.',
    hint: 'A rate-limited call fails cheaply; the retry after it is what costs.',
  },

  // ── checks ────────────────────────────────────────────────────────────────
  budgetOn: { group: 'checks', type: 'boolean', check: bool(), describe: 'The spend and rate checks. Off by default.' },
  rulesOn: {
    group: 'checks',
    type: 'boolean',
    check: bool(),
    describe: 'The capability rules: what an agent may DO. Off by default.',
    hint: 'Independent of the others: spend off still leaves curl|sh and rm -rf guarded.',
  },
  shadow: {
    group: 'checks',
    type: 'boolean',
    check: bool(),
    describe: 'With the capability rules off, record on each receipt what they would have decided (`would`). On by default.',
    hint: 'Never blocks, never asks the tenant policy, never reads spend. Turn rulesOn on to enforce what it records.',
  },
  policyOn: {
    group: 'checks',
    type: 'boolean',
    check: bool(),
    describe: "Ask your organisation's Enforcer policy about actions a rule matched. Off by default.",
    hint: 'Only matched actions are asked, so ordinary tool calls never wait on the network. Signed out, it does nothing.',
  },
  allowEnvOff: {
    group: 'checks',
    type: 'boolean',
    check: bool(),
    describe: 'Let ENFORCER_GOVERNOR_RULES, _BUDGET or _POLICY=off turn a check off for one process tree. Off by default.',
    hint: 'An environment `on` always applies. A project can set environment variables for its sessions, so `off` needs this opt-in, and it is read only from config.json.',
  },
  policyTimeoutMs: {
    group: 'checks',
    type: 'number',
    unit: 'ms',
    check: num(100, 10000),
    describe: 'How long to wait for the policy before the local rule decides alone.',
    hint: 'The local rule is at least as strict, so a timeout never lets anything through.',
  },
  policyTtlSec: {
    group: 'checks',
    type: 'number',
    unit: 's',
    check: num(0, 3600),
    describe: 'How long a policy answer is reused for the same kind of action. 0 asks every time.',
    hint: 'A new policy version takes effect within this long on each machine.',
  },
  shipOn: {
    group: 'checks',
    type: 'boolean',
    check: bool(),
    describe: "Send this machine's receipts to your organisation's Enforcer control plane.",
    hint: 'In the background, with your Enforcer sign-in. Receipts stay in the local file either way.',
  },
  adviseModel: { group: 'checks', type: 'boolean', check: bool(), describe: 'Say when the model and the task look mismatched. Never changes a verdict.' },
  codexTelemetry: {
    group: 'checks',
    type: 'boolean',
    check: bool(),
    describe: "Send Codex's own OpenTelemetry (events and metrics, no prompt text) to Enforcer governance.",
    hint: 'On by default where the Enforcer plugin is installed in Codex. `enforcer governor telemetry codex off` turns it off and removes the settings.',
  },
  sweepDays: {
    group: 'checks',
    type: 'number',
    unit: 'days',
    check: num(0, 365),
    describe: "How long a finished session's working files are kept before they are tidied away.",
    hint: 'Spend and transcript position only; receipts and the record are never swept. 0 keeps everything.',
  },

  // ── attribution ───────────────────────────────────────────────────────────
  model: { group: 'attribution', type: 'string', describe: 'Which model prices dollars into tokens when the harness figure is unavailable.' },

  // ── identity ──────────────────────────────────────────────────────────────
  centralUrl: {
    group: 'identity',
    type: 'string',
    describe: 'Enforcer origin to sign in to and ask. The saved credential can override it.',
    hint: 'https://api.instruxi.dev unless your organisation runs its own.',
  },
  ingestUrl: { group: 'identity', type: 'string', describe: 'Control-plane origin receipts and telemetry are sent to. Empty uses centralUrl.' },
  operator: {
    group: 'identity',
    type: 'string',
    describe: 'The person an agent acts for. Stamped on every receipt.',
    hint: 'A receipt that cannot say who is evidence of nothing.',
  },
};

/** Settings that exist in DEFAULTS but are no longer wired to anything. */
export const RETIRED = {
  rerouteOn: 'reroute needed the v1 proxy, which v3 does not have',
  fallbackUrl: 'see rerouteOn',
  fallbackModel: 'see rerouteOn',
  fallbackHeaders: 'see rerouteOn',
  enforceModel: 'only ever worked on the proxy; never applied to Claude Code',
  loopOn: 'jev-hooks owns loop detection',
  loopLimit: 'jev-hooks owns loop detection',
  loopWindow: 'jev-hooks owns loop detection',
};

/** @returns {string|null} an error message, or null when the value is good. */
export function validate(key, raw) {
  const spec = SETTINGS[key];
  if (!spec) {
    if (RETIRED[key]) return `${key} was retired: ${RETIRED[key]}`;
    const near = Object.keys(SETTINGS).filter((k) => k.toLowerCase().includes(String(key).toLowerCase()));
    return `no setting called ${key}` + (near.length ? `. Did you mean ${near.join(' or ')}?` : '');
  }
  return spec.check ? spec.check(raw) : null;
}
