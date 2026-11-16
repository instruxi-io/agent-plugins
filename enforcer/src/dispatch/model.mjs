// Which model a node's worker runs on (and, with a route table, which harness and endpoint), and the per-node turn cap.
import { truthy } from './util.mjs';

/** enforcer-graph internal/tiers.Model: mechanical script-or-haiku, standard sonnet, deep opus. */
export const TIER_MODEL = { mechanical: 'script-or-haiku', standard: 'sonnet', deep: 'opus' };
/** Tier keys of a route table (docs/graph/ROUTES.md). Any other key is a named route, selected by node data.route. */
export const ROUTE_TIERS = ['mechanical', 'standard', 'deep', 'untiered'];

/** The route a node names (`data.route`), lowercased, or '' when it names none. */
export function askedRoute(node) {
  const raw = node?.data?.route;
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * A node is private when the server field `private` is true or `data.private` is true.
 * The server copies `data.private` out as a boolean (missing or non-boolean is false) so a client
 * need not re-read the payload. Either true fails closed: only an endpoint route may run the node.
 */
export function isPrivate(node) {
  return node?.private === true || node?.data?.private === true;
}

/**
 * The server says this caller must not claim the node (assignment_mode required, migration 169).
 * `claim_block` is null or `node_reserved`. A required node with `viewer_can_claim: false` is the
 * same refusal when the block was not copied onto the row. Advisory nodes are not reserved.
 */
export function reservedForAssignee(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.claim_block === 'node_reserved') return true;
  return node.assignment_mode === 'required' && node.viewer_can_claim === false;
}

const LADDER = ['haiku', 'sonnet', 'opus'];
/** opus > sonnet > haiku; any other name is unranked (-1) and never capped. */
export const rank = (m) => LADDER.indexOf(String(m || ''));

/**
 * The model for a node's next launch after `failures` failed attempts this session: one rung up the ladder per
 * failure (haiku -> sonnet -> opus), so a step tiered too low is retried on a model that can do it instead of
 * failing the same way again. Never above the --model cap (`cap`), never for an unranked model (a route's vLLM name,
 * a pinned id). The first launch (`failures` 0) is unchanged.
 */
export function escalate(model, failures, cap = null) {
  const r = rank(model);
  if (!failures || r < 0) return model;
  let t = Math.min(r + failures, LADDER.length - 1);
  const c = rank(cap);
  if (c >= 0) t = Math.min(t, Math.max(c, r));
  return LADDER[t];
}

/** Explicit data.model (or the claim card's model) wins; a user-set tier beats the
 *  dispatcher's --model cap; otherwise the cap, then the tier (mechanical is
 *  script-or-haiku), then sonnet. */
export function modelFor(node, override = null) {
  const data = node.data || {};
  const explicit = data.model || node.model;
  if (explicit) return explicit;
  const tier = String(data.tier || node.tier || '').toLowerCase();
  if (data.tier_source === 'user' && Object.hasOwn(TIER_MODEL, tier)) return TIER_MODEL[tier];
  if (override) return override;
  return Object.hasOwn(TIER_MODEL, tier) ? TIER_MODEL[tier] : 'sonnet';
}

/**
 * The harness, model and endpoint a node runs on (ROUTES.md section 2), each by the first rule that gives a value:
 *   harness  node data.harness > the named route (data.route) or the tier's route > --harness > claude
 *   model    node data.model (or the card's model) > the route's > modelFor (--model, the tier, sonnet)
 *   endpoint the route's, only while the route also decides the harness: an endpoint never outlives its harness.
 * A route model without an endpoint is capped by --model when ranked above it, unless the tier is user-set; a route
 * model behind an endpoint is never capped. With no table and no data.route this is exactly today's --harness and modelFor.
 * `data.route` naming a key the table does not have sets `unknown` (the caller refuses; it does not use the tier).
 * `routeKey` forces the route (a fallback to route:<name>). `source` names the rule behind each field.
 */
export function routeFor(node, table, args = {}, { routeKey = null } = {}) {
  const data = node.data || {};
  const rawTier = String(data.tier || node.tier || '').toLowerCase();
  const tier = Object.hasOwn(TIER_MODEL, rawTier) ? rawTier : 'untiered';
  const asked = askedRoute(node);
  const key = routeKey || asked || tier;
  const unknown = !routeKey && Boolean(asked) && !table?.routes?.[asked];
  const route = unknown ? null : table?.routes?.[key] || null;
  const flagHarness = args.harness || 'claude';
  const routeHarness = route ? route.harness || flagHarness : null;
  // node data.harness naming another harness drops the route's endpoint and model: a vLLM model name means nothing elsewhere
  const applies = Boolean(route) && (!data.harness || data.harness === routeHarness);
  const harness = data.harness || routeHarness || flagHarness;
  const hsrc = data.harness ? 'node' : route ? `route:${key}` : args.harness ? 'flag' : 'default';
  const user = data.tier_source === 'user' && Object.hasOwn(TIER_MODEL, rawTier);
  const explicit = data.model || node.model;
  let model;
  let msrc;
  if (explicit) [model, msrc] = [explicit, 'node'];
  else if (applies && route.model) {
    const capped = !route.endpoint && args.model && !user && rank(route.model) > rank(args.model) && rank(args.model) >= 0;
    [model, msrc] = capped ? [args.model, 'flag'] : [route.model, `route:${key}`];
  } else [model, msrc] = [modelFor(node, args.model), args.model && !user ? 'flag' : 'default'];
  const endpoint = applies && route.endpoint ? route.endpoint : null;
  return {
    tier,
    harness,
    model,
    endpoint,
    fallback: applies ? route.fallback || 'wait' : null,
    route: applies ? key : null,
    asked: asked || null,
    unknown,
    source: { harness: hsrc, model: msrc, endpoint: endpoint ? `route:${key}` : null },
  };
}

export function nodeMaxTurns(node) {
  const raw = (node.data || {}).max_turns;
  if (!truthy(raw)) return null;
  const v = Math.trunc(Number(raw));
  return Number.isFinite(v) && v > 0 ? v : null;
}
