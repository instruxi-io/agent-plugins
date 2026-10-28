// Which model a node's worker runs on (and, with a route table, which harness and endpoint), and the per-node turn cap.
import { truthy } from './util.mjs';

export const TIER_MODEL = { mechanical: 'sonnet', standard: 'sonnet', deep: 'opus' };
/** The keys of a route table (docs/graph/ROUTES.md): the three tiers, and untiered for a node with no known tier. */
export const ROUTE_TIERS = ['mechanical', 'standard', 'deep', 'untiered'];

const LADDER = ['haiku', 'sonnet', 'opus'];
/** opus > sonnet > haiku; any other name is unranked (-1) and never capped. */
export const rank = (m) => LADDER.indexOf(String(m || ''));

/** Explicit data.model (or the claim card's model) wins; a user-set tier beats the
 *  dispatcher's --model cap; otherwise the cap, then the tier, then sonnet. */
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
 *   harness  node data.harness > the route for its tier > --harness > claude
 *   model    node data.model (or the card's model) > the route's > modelFor (--model, the tier, sonnet)
 *   endpoint the route's, only while the route also decides the harness: an endpoint never outlives its harness.
 * A route model without an endpoint is capped by --model when ranked above it, unless the tier is user-set; a route
 * model behind an endpoint is never capped. With no table this is exactly today's --harness and modelFor.
 * `routeKey` forces the route (a fallback to route:<tier>). `source` names the rule behind each field.
 */
export function routeFor(node, table, args = {}, { routeKey = null } = {}) {
  const data = node.data || {};
  const rawTier = String(data.tier || node.tier || '').toLowerCase();
  const tier = Object.hasOwn(TIER_MODEL, rawTier) ? rawTier : 'untiered';
  const key = routeKey || tier;
  const route = table?.routes?.[key] || null;
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
    source: { harness: hsrc, model: msrc, endpoint: endpoint ? `route:${key}` : null },
  };
}

export function nodeMaxTurns(node) {
  const raw = (node.data || {}).max_turns;
  if (!truthy(raw)) return null;
  const v = Math.trunc(Number(raw));
  return Number.isFinite(v) && v > 0 ? v : null;
}
