// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// Enforcer Governor  -  pure policy engine.
// No I/O, no deps. decide() is a pure function of (state, event, config).
// This is the whole brain: everything else is plumbing around it.
import { createHash } from 'node:crypto';
import { isOn, isOff } from './bool.mjs';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Published list prices, USD per million tokens. `in` = input, `out` = output,
// `cin` = cached input. Sources: each provider's own pricing page.
//
// We measure spend in EFFECTIVE TOKENS: input-token-equivalents at that model's
// own price. One effective token always costs `in` / 1e6 dollars, so dollars
// <-> tokens is a single multiply no matter which model or provider is running.
//
// The output multiplier is NOT a constant across providers. Anthropic prices
// output at 5x input on every current model, which is why a flat 5x worked
// while this only spoke to Claude. OpenAI is 6x on the 5.6 family, 8x on gpt-5,
// and 4x on gpt-4o -- so a flat 5x mis-bills every OpenAI model. Weights are
// therefore derived per model from the prices below.
export const MODELS = {
  // ── xAI ── Prices are the sub-200k tier; xAI doubles them past 200k, so a very
  // long context is metered low here rather than high, which is the safe
  // direction for a cap but worth knowing.
  'grok-4.6': { p: 'xai', label: 'Grok 4.6', in: 2, out: 6, cin: 0.5 },
  'grok-4.5': { p: 'xai', label: 'Grok 4.5', in: 2, out: 6, cin: 0.3 },
  'grok-4.3': { p: 'xai', label: 'Grok 4.3', in: 1.25, out: 2.5, cin: 0.2 },
  'grok-build-0.1': { p: 'xai', label: 'Grok Build', in: 1, out: 2, cin: 0.2 },
  // ── Anthropic ──  cache read 0.1x input unless `cin` says otherwise, cache
  // writes 1.25x (5-minute) and 2x (1-hour) input on every model.
  // Anthropic's pricing page (docs: about-claude/pricing), read 2026-10-18. The 5.5
  // family reads cache at 0.05x input and the 5.1 family at 0.025x. Haiku 5.5
  // is priced by prompt length: a request whose prompt (input, cache reads and
  // cache writes together) is over 100,000 tokens pays `long`, the whole
  // request, cache hits included. Unlisted, Haiku 5.5 fell back to Opus 5 and
  // was metered 50x high; Fable 5.1 fell to Opus 5 too, 2x LOW, the unsafe way.
  'claude-fable-5-1': { p: 'anthropic', label: 'Fable 5.1', in: 10, out: 50, cin: 0.25 },
  'claude-mythos-5-1': { p: 'anthropic', label: 'Mythos 5.1', in: 10, out: 50, cin: 0.25 },
  'claude-fable-5': { p: 'anthropic', label: 'Fable 5', in: 10, out: 50 },
  'claude-mythos-5': { p: 'anthropic', label: 'Mythos 5', in: 10, out: 50 },
  'claude-opus-5-5': { p: 'anthropic', label: 'Opus 5.5', in: 4, out: 20, cin: 0.2 },
  'claude-opus-5': { p: 'anthropic', label: 'Opus 5', in: 5, out: 25 },
  'claude-opus-4-8': { p: 'anthropic', label: 'Opus 4.8', in: 5, out: 25 },
  'claude-opus-4-7': { p: 'anthropic', label: 'Opus 4.7', in: 5, out: 25 },
  'claude-opus-4-6': { p: 'anthropic', label: 'Opus 4.6', in: 5, out: 25 },
  // Sonnet 5 was priced here at $3/$15 on the strength of an announced
  // increase for 2026-09-01. Anthropic have since confirmed the $2/$10
  // introductory rate is the standard rate and the increase will not happen,
  // so every Sonnet 5 figure we showed was 1.5x the real cost.
  'claude-sonnet-5-5': { p: 'anthropic', label: 'Sonnet 5.5', in: 2, out: 10, cin: 0.1 },
  'claude-sonnet-5': { p: 'anthropic', label: 'Sonnet 5', in: 2, out: 10 },
  'claude-sonnet-4-6': { p: 'anthropic', label: 'Sonnet 4.6', in: 3, out: 15 },
  'claude-haiku-5-5': {
    p: 'anthropic',
    label: 'Haiku 5.5',
    in: 0.1,
    out: 0.5,
    cin: 0.01,
    long: { above: 100_000, in: 0.5, out: 2.5, cin: 0.05 },
  },
  'claude-haiku-4-5': { p: 'anthropic', label: 'Haiku 4.5', in: 1, out: 5 },
  // ── OpenAI ──  cached input priced explicitly, no separate cache-write charge
  'gpt-5.6-sol': { p: 'openai', label: 'GPT-5.6 Sol', in: 5, out: 30, cin: 0.5 },
  'gpt-5.6-terra': { p: 'openai', label: 'GPT-5.6 Terra', in: 2, out: 12, cin: 0.2 },
  'gpt-5.6-luna': { p: 'openai', label: 'GPT-5.6 Luna', in: 0.2, out: 1.2, cin: 0.02 },
  'gpt-5.5-pro': { p: 'openai', label: 'GPT-5.5 Pro', in: 30, out: 180 },
  'gpt-5.5': { p: 'openai', label: 'GPT-5.5', in: 5, out: 30, cin: 0.5 },
  'gpt-5.4-mini': { p: 'openai', label: 'GPT-5.4 mini', in: 0.75, out: 4.5, cin: 0.075 },
  'gpt-5.4-nano': { p: 'openai', label: 'GPT-5.4 nano', in: 0.2, out: 1.25, cin: 0.02 },
  'gpt-5.4-pro': { p: 'openai', label: 'GPT-5.4 Pro', in: 30, out: 180 },
  'gpt-5.4': { p: 'openai', label: 'GPT-5.4', in: 2.5, out: 15, cin: 0.25 },
  'gpt-5.1': { p: 'openai', label: 'GPT-5.1', in: 1.25, out: 10, cin: 0.125 },
  'gpt-5-mini': { p: 'openai', label: 'GPT-5 mini', in: 0.25, out: 2, cin: 0.025 },
  'gpt-5-nano': { p: 'openai', label: 'GPT-5 nano', in: 0.05, out: 0.4, cin: 0.005 },
  'gpt-5-pro': { p: 'openai', label: 'GPT-5 Pro', in: 15, out: 120 },
  'gpt-5': { p: 'openai', label: 'GPT-5', in: 1.25, out: 10, cin: 0.125 },
  'gpt-4.1-mini': { p: 'openai', label: 'GPT-4.1 mini', in: 0.4, out: 1.6, cin: 0.1 },
  'gpt-4.1-nano': { p: 'openai', label: 'GPT-4.1 nano', in: 0.1, out: 0.4, cin: 0.025 },
  'gpt-4.1': { p: 'openai', label: 'GPT-4.1', in: 2, out: 8, cin: 0.5 },
  'gpt-4o-mini': { p: 'openai', label: 'GPT-4o mini', in: 0.15, out: 0.6, cin: 0.075 },
  'gpt-4o': { p: 'openai', label: 'GPT-4o', in: 2.5, out: 10, cin: 1.25 },
  'o4-mini': { p: 'openai', label: 'o4-mini', in: 1.1, out: 4.4, cin: 0.275 },
  'o3-mini': { p: 'openai', label: 'o3-mini', in: 1.1, out: 4.4, cin: 0.55 },
  o3: { p: 'openai', label: 'o3', in: 2, out: 8, cin: 0.5 },
  // ── Google ──  context-cache priced explicitly, no separate cache-write charge.
  // Two caveats baked into these numbers, both taken from Google's pricing page:
  // the Flash 3.7/3.6 rates are the ones in force through 2026-12-31 (they rise
  // in 2027), and the Pro rates are the <=200k-prompt tier (longer prompts cost
  // about double). Both are the common case; a long-prompt Pro session is
  // therefore under-counted, which is the direction that lets an agent run
  // slightly past its limit rather than being cut off early.
  'gemini-3.7-flash': { p: 'google', label: 'Gemini 3.7 Flash', in: 0.75, out: 3.75, cin: 0.075 },
  'gemini-3.6-flash': { p: 'google', label: 'Gemini 3.6 Flash', in: 0.75, out: 3.75, cin: 0.075 },
  'gemini-3.5-flash-lite': { p: 'google', label: 'Gemini 3.5 Flash-Lite', in: 0.3, out: 2.5, cin: 0.03 },
  'gemini-3.5-flash': { p: 'google', label: 'Gemini 3.5 Flash', in: 1.5, out: 9.0, cin: 0.15 },
  'gemini-3.1-flash-lite': { p: 'google', label: 'Gemini 3.1 Flash-Lite', in: 0.25, out: 1.5, cin: 0.025 },
  'gemini-3.1-pro': { p: 'google', label: 'Gemini 3.1 Pro', in: 2.0, out: 12.0, cin: 0.2 },
  'gemini-2.5-flash-lite': { p: 'google', label: 'Gemini 2.5 Flash-Lite', in: 0.1, out: 0.4, cin: 0.01 },
  'gemini-2.5-flash': { p: 'google', label: 'Gemini 2.5 Flash', in: 0.3, out: 2.5, cin: 0.03 },
  'gemini-2.5-pro': { p: 'google', label: 'Gemini 2.5 Pro', in: 1.25, out: 10.0, cin: 0.125 },
  // ── DeepSeek ──  peak-hour rates (off-peak is half), so an off-peak session
  // is metered high rather than low. Cache-hit input priced explicitly.
  'deepseek-v4-pro': { p: 'deepseek', label: 'DeepSeek V4 Pro', in: 1.32, out: 3.96, cin: 0.044 },
  'deepseek-flash': { p: 'deepseek', label: 'DeepSeek V4.1 Flash', in: 0.3, out: 1.2, cin: 0.006 },
  // ── Alibaba (Qwen) ──  Model Studio International list prices, smallest
  // context tier. The Mainland endpoint is cheaper, so it is metered high.
  'qwen3.8-max': { p: 'alibaba', label: 'Qwen3.8 Max', in: 2, out: 6 },
  'qwen3.8-flash': { p: 'alibaba', label: 'Qwen3.8 Flash', in: 0.15, out: 0.47 },
  'qwen3.7-max': { p: 'alibaba', label: 'Qwen3.7 Max', in: 2.5, out: 7.5 },
  'qwen3.7-plus': { p: 'alibaba', label: 'Qwen3.7 Plus', in: 0.4, out: 1.6 },
  'qwen3-coder-plus': { p: 'alibaba', label: 'Qwen3 Coder Plus', in: 1, out: 5 },
  'qwen3-coder-flash': { p: 'alibaba', label: 'Qwen3 Coder Flash', in: 0.3, out: 1.5 },
  'qwen-max': { p: 'alibaba', label: 'Qwen Max', in: 1.6, out: 6.4 },
  'qwen-plus': { p: 'alibaba', label: 'Qwen Plus', in: 0.4, out: 1.2 },
  'qwen-flash': { p: 'alibaba', label: 'Qwen Flash', in: 0.05, out: 0.4 },
};

// Longest key first, so 'gpt-5.6-sol' matches before the 'gpt-5' substring.
const KEYS = Object.keys(MODELS).sort((a, b) => b.length - a.length);

export const DEFAULT_MODEL = 'claude-opus-5';

// Look up a model from whatever string the agent reported. Unknown models fall
// back to the priciest in their family, so an unrecognised model is over- rather
// than under-charged and can never quietly run past its limit.
export function priceOf(model = '', fallback = DEFAULT_MODEL) {
  const m = String(model).toLowerCase();
  const key = KEYS.find((k) => m.includes(k));
  if (key) return { key, ...MODELS[key] };
  if (/^(gpt|o[134]\b|chatgpt)/.test(m)) return { key: 'gpt-5.5', ...MODELS['gpt-5.5'] };
  if (/(gemini|bard|palm)/.test(m)) return { key: 'gemini-3.1-pro', ...MODELS['gemini-3.1-pro'] };
  if (/(grok|xai)/.test(m)) return { key: 'grok-4.6', ...MODELS['grok-4.6'] };
  if (m.includes('deepseek')) return { key: 'deepseek-v4-pro', ...MODELS['deepseek-v4-pro'] };
  if (/(qwen|qwq)/.test(m)) return { key: 'qwen3.7-max', ...MODELS['qwen3.7-max'] };
  if (m.includes('claude')) return { key: DEFAULT_MODEL, ...MODELS[DEFAULT_MODEL] };
  return { key: fallback, ...(MODELS[fallback] || MODELS[DEFAULT_MODEL]) };
}

/**
 * The rates one request pays: the model's, or its `long` tier when the
 * request's prompt (input plus cache reads and writes) is over the tier's
 * threshold. Only Haiku 5.5 has one today. `cin` is filled in (0.1x input when
 * the table does not say), so a caller never has to know the default.
 */
export function rateFor(model, prompt = 0) {
  const m = priceOf(model);
  const r = m.long && prompt > m.long.above ? m.long : m;
  return { key: m.key, p: m.p, in: r.in, out: r.out, cin: r.cin ?? r.in * 0.1 };
}

// Cost weights relative to input=1, for turning raw usage into effective tokens.
export function weightsFor(model) {
  const m = priceOf(model);
  return {
    out: m.out / m.in,
    cacheRead: (m.cin ?? m.in * 0.1) / m.in,
    // Anthropic bills a 5-minute cache write at 1.25x input. OpenAI has no
    // separate cache-write charge, so those tokens are just ordinary input.
    cacheWrite: m.p === 'anthropic' ? 1.25 : 1,
  };
}

export const tokensForDollars = (usd, perM) => Math.round((usd / perM) * 1e6);
export const dollarsForTokens = (tok, perM) => (tok / 1e6) * perM;

// WHAT AN AGENT MAY DO, not just what it may spend.
//
// This is Enforcer's model applied to agents: authority is a capability set a
// human granted, every action is checked against it, and the decision is
// receipted. A destructive command is destructive whether or not there is
// budget left, so this is checked BEFORE any spend rule.
//
// action: 'deny' refuses outright; 'ask' hands the decision to the human via
// Claude Code's own permission prompt -- no bespoke approval UI needed.
export const DEFAULT_RULES = [
  { name: 'run a script downloaded from the internet', tool: 'Bash', match: '(curl|wget)[^|]*\\|\\s*(ba|z|fi)?sh', action: 'deny' },
  { name: 'delete a whole tree', tool: 'Bash', match: 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)', action: 'ask' },
  { name: 'rewrite git history', tool: 'Bash', match: 'push\\s+(--force|-f)\\b|reset\\s+--hard|filter-branch', action: 'ask' },
  {
    name: 'read or write credentials',
    tool: 'Bash',
    match:
      '(?:^|[\\s;&|(`])(?:cat|less|more|head|tail|cp|mv|scp|rsync|source|\\.|tee|sed|awk|cut|base64|curl|wget|printf|echo|vim?|nano)\\s+(?:[^|;&\\n]*?[\\s\'"=/])?(?:\\.env(?:\\.[\\w-]+)?|id_rsa\\w*|[\\w.-]+\\.pem|credentials\\.json|\\.aws/|\\.ssh/)(?=[\\s\'"|;&)]|$)|[<>]{1,2}\\s*[^|;&\\s]*(?:\\.env\\b|id_rsa|\\.pem\\b|credentials\\.json|\\.aws/|\\.ssh/)',
    action: 'ask',
  },
  // Any tool whose input names a credentials FILE as its path (Read/Edit/Write:
  // "file_path": "/app/.env") — the path key, not a mention in content.
  {
    name: 'read or write credentials',
    tool: '',
    match:
      '"(?:file_)?path"\\s*:\\s*"[^"]*(?:^|/)(?:\\.env(?:\\.[\\w-]+)?|id_rsa\\w*|[\\w.-]+\\.pem|credentials\\.json)"|"(?:file_)?path"\\s*:\\s*"[^"]*/\\.(?:aws|ssh)/',
    action: 'ask',
  },
  { name: 'publish or deploy', tool: 'Bash', match: 'npm\\s+publish|vercel\\s+.*--prod|kubectl\\s+(apply|delete)|terraform\\s+apply', action: 'ask' },
];

// First rule whose tool and pattern both match. An empty tool means any tool.
export function matchRule(rules, ev) {
  const text = String(ev.action || '');
  // Fall back to the prefix of the action ("Bash:...") when the caller did not
  // name the tool. A missing field used to make every capability rule quietly
  // miss, which fails in the one direction a guard must never fail in.
  const tool = String(ev.tool || text.split(':')[0] || '').toLowerCase();
  for (const r of rules || []) {
    if (r.tool && r.tool.toLowerCase() !== tool) continue;
    let re;
    try {
      re = new RegExp(r.match, 'i');
    } catch {
      continue;
    } // a bad pattern must not break the check
    if (re.test(text)) return r;
  }
  return null;
}

// ── Is this task worth the model that is answering it? ────────────────────
//
// Anthropic's own cost guidance names the two biggest causes of surprise
// spend: long sessions that are never cleared, and a top-tier model left as
// the default on work that does not need it.
//
// This is a HEURISTIC and is treated as one. A wrong downgrade produces worse
// work, which costs more than the money it saves, so the rule is: only speak
// up on a clear mechanical signal with NO reasoning signal, and stay silent on
// anything ambiguous. Silence is the safe default here, not a guess.
const MECHANICAL =
  /\b(?:re-?)?run(?:ning)? (?:the |all |every )?(?:\w+ )?(?:tests?|suite|build|linter)|npm (?:test|run build)|pytest|go test|cargo test|\blint(?:ing|er)?\b|prettier|gofmt|\btypos?\b|rename (?:the |this )?(?:variable|file|function|method)|bump the version|update the (?:changelog|readme|docs)|add a test for|fix the (?:formatting|indentation|imports?)/i;
const REASONING =
  /\b(?:why|design|architect(?:ure)?|debug|investigate|figure out|root cause|refactor|re-?architect|plan|approach|trade-?offs?|decide|strategy|should we|compare|evaluate|migrate)\b/i;

// 'reasoning' | 'mechanical' | null (unknown -> say nothing)
// Which client is this work for?
//
// An agency running five projects needs spend split by client, and the answer
// cannot be "label every session", because nobody does that reliably and the
// one they forget is the one they cannot bill. So it is derived: Claude Code
// tells the hook its working directory on every call, and work for a client
// almost always lives in that client's folder. Map the folder once and every
// session after it is attributed with nobody typing anything.
//
// Longest prefix wins, so ~/work/acme/api is Acme even when ~/work is mapped
// to something else. An unmapped path falls back to the last folder name,
// which is usually the project, so a new client shows up as itself rather
// than as "unattributed" until somebody notices.
export function clientFor(cwd, clients) {
  const path = String(cwd || '');
  if (!path) return '';
  let best = '',
    bestLen = -1;
  for (const [prefix, name] of Object.entries(clients || {})) {
    if (path === prefix || path.startsWith(prefix.replace(/\/+$/, '') + '/')) {
      if (prefix.length > bestLen) {
        best = name;
        bestLen = prefix.length;
      }
    }
  }
  if (best) return best;
  // Nothing mapped. Guess from the folder name so the work is not lost, and
  // mark it so the dashboard can ask a human to confirm rather than quietly
  // putting it on an invoice.
  const parts = path.split('/').filter(Boolean);
  return parts.length ? '?' + parts[parts.length - 1] : '';
}

export function taskShape(task = '') {
  const t = String(task || '');
  if (!t.trim()) return null;
  if (REASONING.test(t)) return 'reasoning'; // reasoning wins ties
  if (MECHANICAL.test(t)) return 'mechanical';
  return null;
}

// Named tiers, NOT "cheapest in the family". Sorting by price suggested
// gpt-5-nano for a changelog bump -- a 100x saving on paper and useless in
// practice, because nano cannot carry multi-step work. Advice moves ONE step,
// to a model that can actually do the job.
const TIERS = {
  anthropic: { top: 'claude-opus-5', mid: 'claude-sonnet-5', low: 'claude-haiku-4-5' },
  openai: { top: 'gpt-5.6-sol', mid: 'gpt-5.4', low: 'gpt-5-mini' },
  google: { top: 'gemini-3.1-pro', mid: 'gemini-3.5-flash', low: 'gemini-2.5-flash-lite' },
  xai: { top: 'grok-4.6', mid: 'grok-4.3', low: 'grok-build-0.1' },
};
const tierOf = (key, t) => (t.top === key ? 'top' : t.mid === key ? 'mid' : t.low === key ? 'low' : null);

// New agents in the last minute. Not a total: a team of twenty that started
// this morning is a choice, twenty appearing in sixty seconds is a fan-out.
export function spawnRate(state, now = Date.now()) {
  if (!state.spawns) return 0;
  const from = now - BURN_WINDOW;
  return state.spawns.reduce((n, s) => n + (s.t > from ? 1 : 0), 0);
}

// { suggest, label, ratio, why } or null when there is nothing worth saying.
export function modelAdvice(model, shape) {
  if (!shape) return null;
  const me = priceOf(model);
  const t = TIERS[me.p];
  if (!t) return null;
  // Anything off the named ladder (a Pro or a dated variant) is left alone
  // rather than guessed at.
  const here = tierOf(me.key, t);
  if (!here) return null;

  let suggest = null;
  if (shape === 'mechanical' && here === 'top') suggest = t.mid;
  else if (shape === 'mechanical' && here === 'mid') suggest = t.low;
  else if (shape === 'reasoning' && here === 'low') suggest = t.mid;
  else if (shape === 'reasoning' && here === 'mid') suggest = t.top;
  if (!suggest || suggest === me.key) return null;

  const to = MODELS[suggest];
  const cheaper = to.in < me.in;
  return {
    suggest,
    label: to.label,
    ratio: +(cheaper ? me.in / to.in : to.in / me.in).toFixed(1),
    cheaper,
    why: cheaper
      ? `this looks like mechanical work, and ${me.label} costs ${+(me.in / to.in).toFixed(1)}x ${to.label}`
      : `this looks like reasoning work, and ${me.label} is a lighter model than ${to.label}`,
  };
}

export const DEFAULTS = {
  // Budgets are COST-WEIGHTED effective tokens (input=1, output 5x,
  // cache-create 1.25x, cache-read 0.1x), so long cached sessions are
  // measured by what they cost, not by raw context re-reads.
  dollars: 20, // what the human actually sets: spend cap per agent, USD
  model: 'claude-opus-5', // which model's prices convert dollars -> tokens
  budget: 4000000, // == $20 at Opus 5 rates. Derived from dollars+model.
  soft: 0.75, // escalate / warn at this fraction of budget
  // Total spend caps across ALL agents, in dollars. 0 means off. These are what
  // bound a team; the per-agent limit only bounds one session.
  dailyLimit: 0,
  weeklyLimit: 0,
  monthlyLimit: 0,
  // Dollars per minute. Unlike the totals above these are ON by default,
  // because the incidents worth preventing are all rate incidents and a
  // control that ships switched off prevents nothing. A normal single session
  // runs around $0.10 to $0.25 a minute, so these sit roughly 8x above
  // ordinary work and only a genuine runaway reaches them.
  burnLimit: 2, // per agent
  fleetBurnLimit: 10, // everything at once
  // New agents appearing per minute. An orchestrator spawning spawners is
  // exponential, so this is about the shape of the arrival, not the count.
  fanoutLimit: 8,
  // Upstream errors an agent may hit in a minute before we stop it retrying.
  // A rate-limited call returns quickly and cheaply to the script but the
  // retry does not: one report had 96% of attempts coming back rate limited
  // while the wrapper kept paying for the ones that got through.
  retryLimit: 6,
  // Reroute: when an agent is out of budget, finish the job somewhere cheaper
  // instead of stopping. Off by default, because moving someone's work to
  // another model is not a decision to take without being asked.
  rerouteOn: false,
  fallbackUrl: '', // e.g. http://localhost:1234/v1/chat/completions
  fallbackModel: '', // e.g. qwen3.8-27b-mlx
  fallbackHeaders: {},
  // Decisioning is OFF by default: a fresh install reports data first (cost
  // records and receipts for every call) and only checks spend, capability
  // rules or the tenant policy once someone turns them on. An organisation's
  // managed `on` still wins over these (managed.mjs onWins).
  budgetOn: false,
  rulesOn: false, // capability rules: what it may DO
  // With rulesOn false, still evaluate the capability rules and record what
  // they would have decided on the receipt as `would` (shadow.mjs). Never blocks.
  shadow: true,
  // Ask the tenant's Enforcer policy about actions a rule matched (central.mjs).
  // Inert when signed out; the local rule stands whenever it cannot answer.
  policyOn: false,
  // Let ENFORCER_GOVERNOR_RULES/_BUDGET/_POLICY=off turn a check off for a
  // process tree. Off by default: a project can set environment variables for
  // its sessions, so an environment `off` needs this machine's own opt-in.
  // Read only from config.json (managed.mjs envReading), never the environment.
  allowEnvOff: false,
  policyTimeoutMs: 1500,
  policyTtlSec: 30,
  centralUrl: 'https://api.instruxi.dev',
  // Ship receipts to the control plane (src/ship.mjs), in the background,
  // with the Enforcer sign-in. Inert when signed out.
  shipOn: true,
  ingestUrl: '', // empty: centralUrl
  adviseModel: true, // say when the model looks mismatched to the task
  // Days a finished session's scratch files (cost-*/cursor-*) are kept before
  // the SessionEnd sweep removes them (src/sweep.mjs). 0 keeps them forever.
  sweepDays: 7,
  enforceModel: false, // rewrite the model on the proxy. Off by default: silently
  // changing someone's model is a big deal, and we can only
  // do it where we own the request (never for Claude Code).
  // Directory prefix -> client name. Map a folder once and every session in it
  // is attributed automatically. { "/Users/me/work/acme": "Acme Corp" }
  clients: {},
  // Per-client spend caps in dollars, by the same names. 0 or absent is off.
  clientLimits: {},
  rules: null, // null = DEFAULT_RULES; set your own to override
  operator: '', // the human this agent acts for; stamped on every receipt
  softAction: 'escalate', // 'escalate' -> ask a human; 'deny' -> auto-block
};

// Period keys double as the reset mechanism: when the key changes, the total
// starts again. No scheduler, no cron, correct across restarts and time zones.
export const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const monthKey = (t) => new Date(t).toISOString().slice(0, 7);
const weekKey = (t) => {
  // ISO-ish: week identified by its Monday
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
export const PERIODS = [
  ['day', dayKey],
  ['week', weekKey],
  ['month', monthKey],
];

export function makeState() {
  return {
    agents: {},
    chain: [],
    prevHash: 'genesis',
    // Total spend across EVERY agent. A per-agent cap cannot bound a team:
    // Claude Code agent teams run each teammate as its own session, so seven
    // teammates on a $20 per-agent cap can spend $140. These totals are the
    // ceiling that actually holds.
    periods: { day: { k: '', usd: 0 }, week: { k: '', usd: 0 }, month: { k: '', usd: 0 } },
    // Recent spend, one entry per charge, trimmed to BURN_WINDOW. Totals are
    // the wrong instrument for the worst real incidents: 49 subagents burning
    // 887k tokens a minute reach $15,000 in one sitting, and a daily cap only
    // notices once the day's money is gone. Rate notices in the first minute.
    burn: [],
    // When each agent first appeared. An orchestrator that spawns spawners is
    // exponential, and the documented case reached 49 subagents before anyone
    // looked. Counting arrivals per minute catches it around the sixth.
    spawns: [],
    // Dollars per client, per period. Keyed the same way the fleet totals are,
    // so a new day resets them without a scheduler.
    clients: { day: { k: '', by: {} }, week: { k: '', by: {} }, month: { k: '', by: {} } },
    // Folders seen that nobody has mapped yet: path -> the name we guessed.
    unmapped: {},
  };
}

export const BURN_WINDOW = 60000; // one minute, so the sum IS dollars per minute

// Dollars per minute, for one agent or for everything at once. Needs a few
// samples across a few seconds before it will answer, because one big charge
// against no history reads as an infinite rate and would stop honest work.
export function burnRate(state, now = Date.now(), agent = null) {
  if (!state.burn || !state.burn.length) return 0;
  const from = now - BURN_WINDOW;
  const rows = state.burn.filter((b) => b.t > from && (!agent || b.agent === agent));
  if (rows.length < 3) return 0;
  const span = now - rows[0].t;
  // Per minute, measured over however much of the minute has actually
  // happened. Summing the raw window instead would mean waiting a full minute
  // before the rate reads true, and at $50 a minute that wait is the whole
  // loss. The floor keeps a single early charge from reading as infinite.
  if (span < 15000) return 0;
  return rows.reduce((s, b) => s + b.usd, 0) * (60000 / span);
}

// Roll the running totals forward, resetting any period whose key has changed.
// Clear any period whose date key has moved on. This has to run on READS as
// well as writes: totals used to reset only when the next dollar was spent, so
// an agent grounded on yesterday's daily cap stayed grounded after midnight
// until something else spent money, and a fresh agent could be grounded at
// 00:01 by a figure belonging to yesterday.
export function rollPeriods(state, now = Date.now()) {
  if (!state.periods) return;
  for (const [name, keyFn] of PERIODS) {
    const p = state.periods[name],
      k = keyFn(now);
    if (p.k !== k) {
      p.k = k;
      p.usd = 0;
    }
    if (state.clients) {
      const c = state.clients[name];
      if (c.k !== k) {
        c.k = k;
        c.by = {};
      }
    }
  }
}

export function addSpend(state, a, deltaTokens, now = Date.now()) {
  if (!state.periods || !(deltaTokens > 0)) return;
  rollPeriods(state, now);
  const usd = dollarsForTokens(deltaTokens, priceOf(a.model).in);
  for (const [name] of PERIODS) state.periods[name].usd += usd;
  if (state.clients && a.client) {
    for (const [name] of PERIODS) {
      const c = state.clients[name];
      c.by[a.client] = (c.by[a.client] || 0) + usd;
    }
  }
  if (state.burn) {
    state.burn.push({ t: now, usd, agent: a.id });
    const from = now - BURN_WINDOW;
    while (state.burn.length && state.burn[0].t <= from) state.burn.shift();
  }
}

// An effective token is denominated as "one input-token of cost AT THIS
// MODEL'S price". Switching model mid-session therefore changes the unit, so
// the running total has to be converted with it. Without this, an agent moved
// from Opus to Sonnet keeps its old total against a bigger token budget and
// quietly gets 1.7x more money than the human set. Model switching used to be
// rare; the model-matching feature makes it deliberate, so it has to be right.
export function setModel(a, model) {
  if (!model || model === a.model) return;
  const from = priceOf(a.model, model).in,
    to = priceOf(model).in;
  if (a.model && a.tokens > 0 && from !== to) a.tokens = Math.round((a.tokens * from) / to);
  a.model = model;
}

// Older versions kept a per-agent `recent` list of whole tool calls (commands included). Nothing reads
// it any more (jev-hooks owns loop detection), so it is dropped from every entry on load.
export function dropRecent(a) {
  if (a && typeof a === 'object') delete a.recent;
  return a;
}

export function getAgent(state, id, cfg, now = Date.now()) {
  if (!state.agents[id]) {
    if (state.spawns) {
      state.spawns.push({ t: now, id });
      const from = now - BURN_WINDOW;
      while (state.spawns.length && state.spawns[0].t <= from) state.spawns.shift();
    }
    state.agents[id] = {
      id,
      tokens: 0,
      escalated: false,
      status: 'active',
      budget: cfg.budget,
      soft: cfg.soft,
      cost: 0,
    };
  }
  const a = state.agents[id];
  a.lastSeen = now; // idle agents are evicted by it (store.mjs loadState)
  return dropRecent(a);
}

// The one call. Returns { verdict, reason, receipt, hash, agent }.
// verdict is one of: allow | deny | escalate.
// Decisioning is off: spend checks off and capability rules off, which is what
// a fresh install has (budgetOn and rulesOn false by default). Loop detection
// belongs to jev-hooks, not the governor.
export const checksOff = (cfg = {}) => isOff(cfg.budgetOn) && isOff(cfg.rulesOn);

export function decide(state, ev, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const now = ev.ts || Date.now();
  rollPeriods(state, now);
  const a = getAgent(state, ev.agent || 'default', cfg);
  if (cfg.operator) a.operator = cfg.operator;
  if (ev.task) a.task = ev.task;
  if (ev.model) setModel(a, ev.model);
  a.tool = ev.tool || String(ev.action || '').split(':')[0] || a.tool;
  if (ev.cwd) a.cwd = ev.cwd;
  // An explicit client always wins over a derived one, so a header or a config
  // entry can correct a directory that guessed wrong.
  const named = ev.client || clientFor(ev.cwd, cfg.clients);
  if (named) a.client = named;
  // A leading ? means it was guessed. Keep the folder next to the guess so the
  // dashboard can offer to name it rather than making someone find the path.
  if (named && named[0] === '?' && ev.cwd && state.unmapped) {
    state.unmapped[ev.cwd] = named.slice(1);
  }
  // Whether this session is drawing on a subscription or on API credit. The
  // nastiest surprise bills are people who believed they were on a flat plan
  // while an API key quietly moved them onto per-token billing.
  if (ev.billing) a.billing = ev.billing;

  // Master switch wins over everything, including a grounded agent. Turning the
  // governor off in the dashboard has to actually let work through, otherwise
  // there is no way back and the user is stuck.
  if (checksOff(cfg)) {
    a.status = 'active';
    a.escalated = false;
    return record(state, a, 'allow', 'checks are switched off', a.tokens, 'human');
  }

  // A grounded agent stays grounded -- but only for the reasons that cannot be
  // re-derived from the current config.
  //
  // This used to latch for every reason, which built a dead end: an agent
  // stopped at a $5 limit stayed stopped after the limit was raised to $20,
  // because this check ran BEFORE the budget comparison and never looked at it
  // again. The only ways out were editing state.json by hand, which breaks the
  // receipt chain, or turning the checks off entirely.
  //
  // So the spend reasons do not latch. If the agent is still over its limit the
  // check below grounds it again on this very call; if the human raised the
  // limit, it simply carries on. Nothing is lost by re-deriving them, and the
  // dead end goes away. What DOES latch is a human saying stop. An old state
  // file with no reason recorded is treated as re-derivable, so upgrading
  // unsticks anyone already stuck.
  if (a.status === 'grounded' && a.groundedBy === 'human') {
    return record(state, a, 'deny', 'you stopped this agent. Resume it with /enforcer-governor:resume', a.tokens);
  }
  if (a.status === 'grounded') {
    a.status = 'active';
    a.groundedBy = undefined;
  }

  // Capability first. "You may not do this" outranks "you have budget left",
  // and a cheap command can still be the destructive one.
  if (!isOff(cfg.rulesOn)) {
    const hit = matchRule(cfg.rules || DEFAULT_RULES, ev);
    if (hit && hit.action === 'deny') {
      // Refuse the ACTION, do not ground the agent. A capability check says
      // "not that", not "you are finished" -- grounding here meant one blocked
      // command silently turned every later verdict into "agent is stopped".
      return record(state, a, 'deny', `not allowed to ${hit.name}`, a.tokens, undefined, undefined, { rule: hit.name });
    }
    if (hit && hit.action === 'ask') {
      // Deliberately does NOT latch a.escalated: every separate dangerous
      // action deserves its own answer, not one blanket approval.
      return record(state, a, 'escalate', `wants to ${hit.name}`, a.tokens, undefined, undefined, { rule: hit.name });
    }
  }

  // The hook/proxy reports the session's cumulative token total. Do NOT trust it
  // blindly: /decide is an open local endpoint and the proxy reads usage out of
  // an upstream response. A NaN here is the worst case, because every
  // comparison against the budget silently evaluates false and the agent is
  // never stopped at all. Infinity poisons the running totals permanently, and
  // a negative lets a caller rewind its own spend.
  const clean = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
  const wasTokens = a.tokens;
  const abs = clean(ev.tokens),
    delta = clean(ev.deltaTokens);
  // Cumulative totals only ever move forward; a lower figure means a restarted
  // or re-read transcript, not spend that un-happened.
  if (abs !== null) a.tokens = Math.max(a.tokens, abs);
  else if (delta !== null) a.tokens += delta;
  if (typeof ev.cost === 'number') a.cost = ev.cost;
  addSpend(state, a, a.tokens - wasTokens, now);

  // Totals first: a team of agents can each sit inside its own limit while
  // together spending many times what the human intended.
  if (isOn(cfg.budgetOn) && state.periods) {
    const caps = { day: cfg.dailyLimit, week: cfg.weeklyLimit, month: cfg.monthlyLimit };
    const word = { day: 'today', week: 'this week', month: 'this month' };
    for (const [name] of PERIODS) {
      const cap = caps[name],
        spent = state.periods[name].usd;
      if (cap > 0 && spent >= cap) {
        a.status = 'grounded';
        a.groundedBy = name;
        return record(state, a, 'deny', `your agents have spent $${spent.toFixed(2)} ${word[name]}, which is your $${cap} limit`, a.tokens);
      }
    }
  }

  // Speed, before totals. A runaway is recognisable by how fast it spends
  // long before it reaches any ceiling, and by the time a daily cap notices,
  // the day's money is already gone. Escalating rather than denying is
  // deliberate: an overnight run stops and waits for a human, which is exactly
  // what should have happened in every one of these incidents.
  if (isOn(cfg.budgetOn) && !a.burnFlagged) {
    const mine = burnRate(state, now, a.id),
      all = burnRate(state, now);
    const hit =
      cfg.burnLimit > 0 && mine >= cfg.burnLimit
        ? ['this agent is spending', mine, cfg.burnLimit]
        : cfg.fleetBurnLimit > 0 && all >= cfg.fleetBurnLimit
          ? ['your agents together are spending', all, cfg.fleetBurnLimit]
          : null;
    if (hit) {
      a.burnFlagged = true;
      a.status = 'paused';
      return record(state, a, 'escalate', `${hit[0]} $${hit[1].toFixed(2)} a minute, over your $${hit[2]} a minute mark`, a.tokens);
    }
  }

  // Fan-out. Flagged once per burst on the agent that trips it, so a genuine
  // twenty-agent job asks a single question rather than twenty.
  if (isOn(cfg.budgetOn) && cfg.fanoutLimit > 0 && !state.fanoutFlagged) {
    const spawned = spawnRate(state, now);
    if (spawned >= cfg.fanoutLimit) {
      state.fanoutFlagged = true;
      a.status = 'paused';
      return record(state, a, 'escalate', `${spawned} new agents started in the last minute, and you asked to be told past ${cfg.fanoutLimit}`, a.tokens);
    }
  }

  // Retry storm. A rate-limited call fails cheaply; the retry does not.
  if (isOn(cfg.budgetOn) && cfg.retryLimit > 0 && a.fails && !a.retryFlagged) {
    const recent = a.fails.reduce((n, t) => n + (t > now - BURN_WINDOW ? 1 : 0), 0);
    if (recent >= cfg.retryLimit) {
      a.retryFlagged = true;
      a.status = 'paused';
      return record(state, a, 'escalate', `it hit ${recent} errors in a minute and kept going, which is a retry loop, not progress`, a.tokens);
    }
  }

  if (isOn(cfg.budgetOn) && a.client && state.clients) {
    const cap = (cfg.clientLimits || {})[a.client];
    const spent = state.clients.month.by[a.client] || 0;
    if (cap > 0 && spent >= cap) {
      a.status = 'grounded';
      a.groundedBy = 'client';
      return record(state, a, 'deny', `work for ${a.client} has cost $${spent.toFixed(2)} this month, which is its $${cap} limit`, a.tokens);
    }
  }

  if (isOn(cfg.budgetOn) && a.tokens >= a.budget) {
    a.status = 'grounded';
    a.groundedBy = 'limit';
    return record(state, a, 'deny', 'it reached your spend limit', a.tokens);
  }
  if (isOn(cfg.budgetOn) && !a.escalated && a.tokens >= a.budget * a.soft) {
    a.escalated = true;
    if (cfg.softAction === 'escalate') {
      a.status = 'paused';
      return record(state, a, 'escalate', `it has used ${Math.round(a.soft * 100)}% of your spend limit`, a.tokens);
    }
    a.status = 'grounded';
    a.groundedBy = 'soft';
    return record(state, a, 'deny', 'it passed the warn-me mark, and you set that to stop it', a.tokens);
  }
  const r = record(state, a, 'allow', 'inside the limit, doing new work', a.tokens);
  // Advisory only: it never changes the verdict, it just tells you the model
  // and the job look mismatched. Enforcement happens only on the proxy, where
  // we actually own the request.
  if (!isOff(cfg.adviseModel)) {
    const advice = modelAdvice(a.model, taskShape(a.task || ev.task));
    if (advice) r.advice = advice;
  }
  return r;
}

// Human resolves an escalation.
export function resolve(state, agentId, approve, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const a = state.agents[agentId];
  if (!a) return null;
  if (approve) {
    a.budget = Math.round(a.budget * 1.5); // grant +50% and let it finish
    a.budgetRaised = true; // a human overrode the cap; stop recomputing it
    a.status = 'active';
    a.groundedBy = undefined;
    a.escalated = false;
    a.burnFlagged = a.retryFlagged = state.fanoutFlagged = false;
    return record(state, a, 'allow', 'you approved it, limit raised by half', a.tokens, 'human');
  }
  a.status = 'grounded';
  a.groundedBy = 'human';
  return record(state, a, 'deny', 'you said no', a.tokens, 'human');
}

// Release a grounded agent and give it room to finish. This is the way out.
export function release(state, agentId, extra = 1.5) {
  const a = state.agents[agentId];
  if (!a) return null;
  a.budget = Math.round(Math.max(a.budget, a.tokens) * extra);
  a.budgetRaised = true; // a human overrode the cap; stop recomputing it
  a.status = 'active';
  a.groundedBy = undefined;
  a.escalated = false;
  a.burnFlagged = a.retryFlagged = state.fanoutFlagged = false;
  a.pendingAsk = undefined;
  return record(state, a, 'allow', 'you resumed it and raised its limit', a.tokens, 'human');
}

export function kill(state, agentId) {
  const a = state.agents[agentId];
  if (!a) return null;
  a.status = 'grounded';
  a.groundedBy = 'human';
  return record(state, a, 'deny', 'you stopped it', a.tokens, 'human');
}

// Append a hash-chained receipt. Each hash folds in the previous one, so any
// later edit or deletion breaks the chain and verifyChain() catches it.
export function record(state, a, verdict, reason, tokens, authority, operator, extra) {
  // ISO, not epoch milliseconds. The record is read by people and by log
  // pipelines, and both do better with a self-describing, sortable, timezone-
  // bearing string than with a bare integer. v3's verdict.entry() already
  // wrote ISO, so leaving this as Date.now() put TWO formats in one record —
  // which broke the collector's timestamp parser and, worse, made the evidence
  // chain internally inconsistent. Lines already written keep their own format
  // and still verify: each hash covers the bytes that were hashed, so this is
  // a format transition, not a chain break.
  const entry = { ts: new Date().toISOString(), agent: a.id, verdict, reason, tokens: Math.round(tokens) };
  // An auditor asks four things of an agent action: who it acted for, what it
  // tried to do, which policy answered, and on what. A prose reason answers
  // none of them in a form you can query, so the facts are recorded as fields
  // as well. This is the shape the 2026 rules ask for.
  if (a.client) entry.client = a.client;
  if (a.tool) entry.tool = a.tool;
  if (a.model) entry.model = a.model;
  if (extra && extra.rule) entry.rule = extra.rule;
  // An agent acts FOR someone. A receipt that cannot say who is evidence of
  // nothing, which is the whole point of keeping receipts.
  if (operator || a.operator) entry.operator = operator || a.operator;
  if (authority) entry.authority = authority;
  const json = JSON.stringify(entry);
  const hash = sha256(state.prevHash + json);
  state.chain.push({ json, hash });
  // The file is the record; memory only holds a recent tail. A daemon left
  // running for weeks used to grow this array forever. Dropping the oldest
  // links means the in-memory check now starts from the oldest one KEPT.
  if (state.chain.length > 5000) {
    state.chainStart = state.chain.shift().hash;
  }
  state.prevHash = hash;
  return {
    verdict,
    reason,
    receipt: 'rcpt_' + hash.slice(0, 12),
    hash,
    agent: { id: a.id, tokens: Math.round(a.tokens), budget: a.budget, status: a.status },
    entry,
  };
}

// Checks the links this process holds. A restarted governor picks the chain up
// from the file, so it starts from wherever it resumed, not from genesis.
export function verifyChain(state) {
  let h = state.chainStart || 'genesis';
  for (const link of state.chain) {
    h = sha256(h + link.json);
    if (h !== link.hash) return false;
  }
  return true;
}
