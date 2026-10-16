#!/usr/bin/env node
// Ambient spend, always in the chrome. This is the one piece of this plugin a
// developer benefits from rather than tolerates: the governor stops being a
// dashboard you have to open and becomes a number you glance at.
//
// It now has a second job. Claude Code hands the status line — and ONLY the
// status line — its own cost figure, which can reflect an organisation's
// contracted rates and is therefore better than anything we can compute. The
// hooks never see it. So this records what it is given, and the gate reads it
// back on the next tool call. That is how the good number reaches the decision
// without a daemon standing between them.
//
// Nothing in this repo wires this up, and that is not an oversight: a plugin
// cannot declare a status line. `statusLine` is not a plugin.json field, and a
// plugin's settings.json honours only `agent` and `subagentStatusLine`. So it
// is wired by hand — see Install in the README. Without that paste the
// governor still enforces; it just meters from the transcript instead.
import { readFileSync } from 'node:fs';
import { loadState, loadConfig } from '../src/store.mjs';
import { DEFAULTS, priceOf, dollarsForTokens } from '../src/policy.mjs';
import { recordHarnessCost } from '../adapters/claude-code/meter.mjs';
import { agentOf } from '../adapters/claude-code/events.mjs';

let ev = {};
try {
  ev = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {}
const cfg = { ...DEFAULTS, ...loadConfig() };
// The same id the hooks keep this session's state under (agentOf).
const id = agentOf({ session_id: ev.session_id });

// Do this first and unconditionally. Even on a session the governor has never
// judged, the figure is worth keeping: the first tool call of the next turn is
// better off reading it than re-deriving it.
recordHarnessCost(ev.session_id, ev.cost);

const a = (loadState().agents || {})[id];
if (!a) process.exit(0);

// Prefer what the harness says it cost over what we worked out it cost.
const derived = dollarsForTokens(a.tokens || 0, priceOf(a.model, cfg.model).in);
const spent = ev.cost && typeof ev.cost.total_cost_usd === 'number' ? ev.cost.total_cost_usd : derived;
const cap = a.budget ? dollarsForTokens(a.budget, priceOf(a.model, cfg.model).in) : 0;
const pct = cap ? spent / cap : 0;
// Only the last state earns a colour. A status line that is always shouting
// stops being read, and the point of this one is the moment it changes.
const mark = a.status === 'grounded' ? '\x1b[31m■\x1b[0m' : a.escalated ? '\x1b[33m■\x1b[0m' : pct >= cfg.soft ? '\x1b[33m·\x1b[0m' : '\x1b[2m·\x1b[0m';
process.stdout.write(cap ? `${mark} $${spent.toFixed(2)}/$${cap.toFixed(0)}` : `${mark} $${spent.toFixed(2)}`);
