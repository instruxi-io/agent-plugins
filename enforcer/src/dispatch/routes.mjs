// The per-tier route table (docs/graph/ROUTES.md items 1-3 and 6): where it comes from, its validation, the endpoint
// probe and its cache, the per-route fallback, and the preflight lines. Which route a node gets is routeFor (model.mjs).
// The worker environment for an endpoint (item 4) is launch.mjs workerEnv's job, not this module's.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HARNESSES, harnessRefusal, harnessKnowsModel } from './launch.mjs';
import { routeFor, rank, TIER_MODEL, ROUTE_TIERS } from './model.mjs';

export { ROUTE_TIERS, rank };
export const ROUTE_FIELDS = ['harness', 'model', 'endpoint', 'fallback'];
export const ENDPOINT_FIELDS = ['url', 'api', 'token_env'];
export const ROUTE_APIS = ['anthropic', 'openai'];
/** Which endpoint API each harness can speak (ROUTES.md section 4). grok and gemini have no endpoint form yet. */
export const HARNESS_APIS = { claude: ['anthropic'], codex: ['openai'], grok: [] };
export const DEFAULT_PROBE_TTL = 60;
export const PROBE_TIMEOUT_MS = 5000;
export const HOLD_NOTE_SECONDS = 600;

/** A route table that cannot be used: a usage error, exit 5, naming the source and the field. */
export class RouteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RouteError';
    this.exitCode = 5;
  }
}

// a value shaped like a credential rather than a variable name (the redactor's shapes: long hex/base64, known prefixes)
const TOKENISH = /^(sk-|xox|ghp_|gho_|github_pat_|eyJ)|[a-z]|^[A-Za-z0-9+/=_-]{40,}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parse and validate one table. `raw` is the file text or the object; returns {version, routes} with every field checked. */
export function validateRoutes(raw, source, { env = process.env, experimental = false, defaultHarness = 'claude' } = {}) {
  let t = raw;
  if (typeof raw === 'string') {
    try {
      t = JSON.parse(raw);
    } catch (e) {
      throw new RouteError(`routes: ${source}: not valid JSON: ${e.message}`);
    }
  }
  if (!isObj(t)) throw new RouteError(`routes: ${source}: not valid JSON: expected an object`);
  if (t.version !== 1) throw new RouteError(`routes: ${source}: version must be 1`);
  const routes = t.routes ?? {};
  if (!isObj(routes)) throw new RouteError(`routes: ${source}: routes must be an object`);
  const out = {};
  for (const [tier, r] of Object.entries(routes)) {
    const at = `routes.${tier}`;
    if (!ROUTE_TIERS.includes(tier)) throw new RouteError(`${at}: unknown tier (expected ${ROUTE_TIERS.join(', ')})`);
    if (!isObj(r)) throw new RouteError(`${at}: must be an object`);
    for (const f of Object.keys(r)) if (!ROUTE_FIELDS.includes(f)) throw new RouteError(`${at}.${f}: unknown field`);
    if (r.harness !== undefined && !HARNESSES.includes(r.harness)) throw new RouteError(`${at}.harness: must be one of ${HARNESSES.join(', ')}`);
    const harness = r.harness ?? defaultHarness;
    // a harness that cannot run workers fails startup here, never a node later
    const refusal = harnessRefusal(harness, experimental);
    if (refusal) throw new RouteError(`${at}.harness: ${refusal}`);
    if (r.model !== undefined && (typeof r.model !== 'string' || !r.model)) throw new RouteError(`${at}.model: must be a model name`);
    let endpoint = null;
    if (r.endpoint !== undefined) {
      const e = r.endpoint;
      if (!isObj(e)) throw new RouteError(`${at}.endpoint: must be an object with url and api`);
      for (const f of Object.keys(e)) if (!ENDPOINT_FIELDS.includes(f)) throw new RouteError(`${at}.endpoint.${f}: unknown field`);
      if (!HARNESS_APIS[harness]?.length) throw new RouteError(`${at}.endpoint: ${harness} cannot use a custom endpoint`);
      let u = null;
      try {
        u = new URL(String(e.url));
      } catch {
        /* reported below */
      }
      if (!u || !['http:', 'https:'].includes(u.protocol) || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
        throw new RouteError(`${at}.endpoint.url: must be an http(s) URL without a path past the root`);
      if (!ROUTE_APIS.includes(e.api)) throw new RouteError(`${at}.endpoint.api: must be anthropic or openai`);
      if (!HARNESS_APIS[harness].includes(e.api)) throw new RouteError(`${at}.endpoint.api: ${harness} cannot speak ${e.api}`);
      if (e.token_env !== undefined) {
        if (typeof e.token_env !== 'string' || !ENV_NAME.test(e.token_env) || TOKENISH.test(e.token_env))
          throw new RouteError(`${at}.endpoint.token_env: must be a variable name, not a token`);
        if (!env[e.token_env]) throw new RouteError(`${at}.endpoint.token_env: ${e.token_env} is not set`);
      }
      if (!r.model) throw new RouteError(`${at}.model: required with an endpoint (the /v1/models id the endpoint serves)`);
      endpoint = { url: `${u.protocol}//${u.host}`, api: e.api, ...(e.token_env ? { token_env: e.token_env } : {}) };
    } else if (r.model !== undefined && !harnessKnowsModel(harness, r.model)) {
      throw new RouteError(`${at}.model: ${r.model} is not a ${harness} model`);
    }
    const fallback = r.fallback ?? 'wait';
    const target = typeof fallback === 'string' && fallback.startsWith('route:') ? fallback.slice(6) : null;
    if (fallback !== 'wait' && !(target && (ROUTE_TIERS.includes(target) || HARNESSES.includes(target))))
      throw new RouteError(`${at}.fallback: must be wait or route:<tier|harness>`);
    if (target && HARNESSES.includes(target)) {
      const why = harnessRefusal(target, experimental);
      if (why) throw new RouteError(`${at}.fallback: ${why}`);
    }
    out[tier] = { ...(r.harness ? { harness: r.harness } : {}), ...(r.model ? { model: r.model } : {}), ...(endpoint ? { endpoint } : {}), fallback };
  }
  // route:<tier> chains are followed at launch, so a cycle would never end: refused here
  for (const start of Object.keys(out)) {
    const seen = [start];
    let cur = out[start];
    while (cur?.fallback?.startsWith('route:')) {
      const next = cur.fallback.slice(6);
      if (!ROUTE_TIERS.includes(next)) break;
      if (seen.includes(next)) throw new RouteError(`routes.${start}.fallback: ${cur.fallback} forms a cycle (${[...seen, next].join(' -> ')})`);
      seen.push(next);
      cur = out[next];
    }
  }
  return { version: 1, routes: out };
}

const configHome = (env) => env.ENFORCER_CONFIG_HOME || join(homedir(), '.config', 'enforcer');
export const routesConfigPath = (env = process.env) => join(configHome(env), 'dispatch', 'routes.json');

function readTable(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new RouteError(`routes: ${label}: cannot read: ${e.code || e.message}`);
  }
}

/**
 * The one table this run uses and where it came from. The first source found is the whole table (never merged):
 * --routes, then ENFORCER_ROUTES, then the graph's node_defaults.routes, then <config home>/dispatch/routes.json, else none.
 * Returns {table: {version, routes} | null, source}. Throws RouteError for a table that is there but unusable.
 */
export function loadRoutes({ file = null, noRoutes = false, graphRoutes = undefined, env = process.env, experimental = false, harness = 'claude' } = {}) {
  const opts = { env, experimental, defaultHarness: harness || 'claude' };
  if (noRoutes) return { table: null, source: 'none (--no-routes)' };
  if (file) return { table: validateRoutes(readTable(file, file), file, opts), source: file };
  if (env.ENFORCER_ROUTES)
    return { table: validateRoutes(readTable(env.ENFORCER_ROUTES, env.ENFORCER_ROUTES), env.ENFORCER_ROUTES, opts), source: env.ENFORCER_ROUTES };
  if (graphRoutes != null) {
    const src = 'graph node_defaults.routes';
    // the plan may carry the whole table or only its routes object
    const t = isObj(graphRoutes) && 'version' in graphRoutes ? graphRoutes : { version: 1, routes: graphRoutes };
    return { table: validateRoutes(t, src, opts), source: src };
  }
  const p = routesConfigPath(env);
  if (existsSync(p)) return { table: validateRoutes(readTable(p, p), p, opts), source: p };
  return { table: null, source: null };
}

// ---- the endpoint probe

/** GET <url>/v1/models with the route's token. Up when it answers 200 with JSON that lists `model` in data[].id. */
export async function probeEndpoint(endpoint, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const token = endpoint.token_env ? env[endpoint.token_env] : null;
  const headers = { accept: 'application/json' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    if (endpoint.api === 'anthropic') headers['x-api-key'] = token;
  }
  if (endpoint.api === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  let res;
  try {
    res = await fetchImpl(`${endpoint.url}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const code = e?.cause?.code || e?.code || e?.name || 'error';
    return { ok: false, reason: `unreachable (${code})`, ids: null };
  }
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}`, ids: null };
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return { ok: false, reason: 'not JSON', ids: null };
  }
  const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
  return { ok: true, reason: null, ids };
}

/** The answer for one model from a probe of its endpoint: {up, reason}. */
export function probeVerdict(p, model) {
  if (!p.ok) return { up: false, reason: p.reason };
  if (!p.ids.includes(model)) return { up: false, reason: `model ${model} not served (serves: ${p.ids.slice(0, 5).join(', ') || 'none'})` };
  return { up: true, reason: null };
}

/** Probe results cached per endpoint URL for `ttl` seconds, so a busy pass does not probe once per worker. */
export class ProbeCache {
  constructor({ ttl = DEFAULT_PROBE_TTL, probe = probeEndpoint, env = process.env, clock = () => Date.now() / 1000 } = {}) {
    this.ttl = ttl;
    this.probe = probe;
    this.env = env;
    this.clock = clock;
    this.entries = new Map(); // url -> {at, result}
    this.state = new Map(); // url -> {up, reason, since}: what `dispatch status` shows
  }

  async check(endpoint, model) {
    const t = this.clock();
    let e = this.entries.get(endpoint.url);
    if (!e || t - e.at >= this.ttl) {
      e = { at: t, result: await this.probe(endpoint, { env: this.env }) };
      this.entries.set(endpoint.url, e);
    }
    const v = probeVerdict(e.result, model);
    const prev = this.state.get(endpoint.url);
    this.state.set(endpoint.url, { up: v.up, reason: v.reason, since: prev && prev.up === v.up ? prev.since : t });
    return v;
  }

  /** Forget an endpoint, so the next launch probes it again (a worker saw a connection error to it). */
  clear(url) {
    this.entries.delete(url);
  }

  snapshot() {
    return Object.fromEntries([...this.state].map(([url, s]) => [url, { ...s }]));
  }
}

// ---- choosing the route a node launches on, with the fallback

/**
 * The route a node launches on now: routeFor, then for a route with an endpoint the probe, and when it is down the
 * route's fallback. Returns {hold: true, route, reason} for `wait` (launch nothing, spend no attempt), else
 * {hold: false, route, fallbackFrom: {route, url, reason, target} | null}.
 */
export async function resolveRoute(node, table, args, probes) {
  let r = routeFor(node, table, args);
  let from = null;
  for (let hop = 0; r.endpoint && hop <= ROUTE_TIERS.length; hop++) {
    const v = await probes.check(r.endpoint, r.model);
    if (v.up) break;
    const fb = r.fallback || 'wait';
    if (fb === 'wait') return { hold: true, route: r, reason: v.reason, fallbackFrom: from };
    const target = fb.slice(6);
    from ??= { route: r.route, url: r.endpoint.url, reason: v.reason, target };
    from.target = target;
    if (ROUTE_TIERS.includes(target)) r = routeFor(node, table, args, { routeKey: target });
    else r = harnessOnly(node, target, args);
  }
  return { hold: false, route: r, fallbackFrom: from };
}

/** route:<harness>: that harness, no endpoint, the model from precedence rules 3 and 4 (--model, else the tier's). */
function harnessOnly(node, harness, args) {
  const data = node.data || {};
  const tier = String(data.tier || node.tier || '').toLowerCase();
  const user = data.tier_source === 'user' && Object.hasOwn(TIER_MODEL, tier);
  const model = args.model && !user ? args.model : Object.hasOwn(TIER_MODEL, tier) ? TIER_MODEL[tier] : 'sonnet';
  return {
    tier: Object.hasOwn(TIER_MODEL, tier) ? tier : 'untiered',
    harness,
    model,
    endpoint: null,
    fallback: null,
    route: null,
    source: { harness: `fallback:${harness}`, model: args.model && !user ? 'flag' : 'default', endpoint: null },
  };
}

/** `route=<tier>` or `route=<tier>->fallback:<target> (endpoint down: <reason>)` for the launch line. */
export function routeNote(r, from) {
  const base = `route=${from ? from.route : r.route || '-'}`;
  return from ? `${base}->fallback:${from.target} (endpoint down: ${from.reason})` : base;
}

// ---- preflight

const pad = (s, n) => String(s).padEnd(n);

/**
 * The preflight block: where the table came from, one line per tier with the probe result, what --harness no longer
 * decides, and how the plan's open nodes split across tiers. `probes` may be null (no probing, e.g. a dry run offline).
 */
export async function routeLines(loaded, args, { probes = null, nodes = [] } = {}) {
  const L = [];
  const { table, source } = loaded;
  const harness = args.harness || 'claude';
  if (!table) {
    L.push(`routes      ${source && source.startsWith('none') ? source : `none (today's behaviour: --harness ${harness}, TIER_MODEL)`}`);
    return L;
  }
  L.push(`routes      from ${source}`);
  const overridden = [];
  for (const tier of ROUTE_TIERS) {
    const r = table.routes[tier];
    if (!r) {
      if (tier === 'untiered') L.push(`route       ${pad('untiered', 11)} ${pad(harness, 6)} ${pad(args.model || 'sonnet', 12)} provider (default)`);
      continue;
    }
    const h = r.harness || harness;
    if (r.harness && r.harness !== harness) overridden.push(tier);
    const model = r.model || (Object.hasOwn(TIER_MODEL, tier) ? TIER_MODEL[tier] : 'sonnet');
    let where = 'provider';
    let state = '-';
    if (r.endpoint) {
      where = `${r.endpoint.api} ${r.endpoint.url}${r.endpoint.token_env ? ` (token ${r.endpoint.token_env})` : ''}`;
      if (probes) {
        const v = await probes.check(r.endpoint, r.model);
        state = v.up ? 'up' : `DOWN: ${v.reason}`;
      } else state = 'not probed';
    }
    const cap =
      !r.endpoint && args.model && r.model && rank(r.model) > rank(args.model) ? `  (--model ${args.model} caps ${r.model} unless the tier is user-set)` : '';
    L.push(
      `route       ${pad(tier, 11)} ${pad(h, 6)} ${pad(model, 12)} ${pad(where, 44)}${r.endpoint ? `${state}  fallback ${r.fallback}` : '-'}${cap}`.trimEnd(),
    );
  }
  if (overridden.length) L.push(`route-note  --harness ${harness} is overridden by routes for ${overridden.join(', ')}`);
  if (nodes.length) {
    const open = nodes.filter((n) => !['done', 'cancelled'].includes(n.status) && !['gate', 'release'].includes(n.type) && !n.data?.dispatcher_lease);
    const count = Object.fromEntries(ROUTE_TIERS.map((t) => [t, 0]));
    for (const n of open) count[routeFor(n, table, args).tier]++;
    L.push(
      `route-plan  ${open.length} nodes: ${ROUTE_TIERS.filter((t) => count[t])
        .map((t) => `${t} ${count[t]}`)
        .join(', ')}`,
    );
  }
  return L;
}
