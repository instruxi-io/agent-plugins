// One adapter per worker harness. The dispatcher (launch.mjs, run.mjs, stream.mjs, routes.mjs) asks the adapter, never
// `harness === '...'`, for anything that differs between harnesses.
//
// The shape (HarnessAdapter):
//   name                 'claude' | 'codex' | 'grok' | 'gemini'
//   caps                 {supported, experimental, models, resume}: HARNESS_CAPS[name] (launch.mjs)
//   apis                 the endpoint APIs a route may give it (routes.mjs HARNESS_APIS); [] = no endpoint form
//   command(prompt, model, args, key, opts) -> argv      pure; opts carries the plan's paths and the session
//   env?(out, ctx) -> out                                harness tweaks to the allowlisted worker environment
//   endpointEnv?(out, route, env) -> out                 a route endpoint's variables (only when apis is non-empty)
//   plan({state, key, args, route}) -> {...paths}        pure: the per-worker files it will need, for argv and dry runs
//   prepare?(plan, ctx) -> {env, cleanup, notes?}        writes those files (0600) just before the spawn; may be async
//   prepareWhat?         what prepare does, for the refusal line when it throws
//   promptRules() -> string                              appended to the worker prompt ('' for none)
//   events(path) -> Iterable                             the worker stream as Claude-shaped events (summarize reads them)
//   sweep?(state)                                        remove every per-worker file it leaves in the state dir (start, shutdown)
//   preflight?(args, sys) -> [{name, ok, line}]          host checks for a run that will launch it (codex: binary, sandbox)
//   usageAfterExit?(summary, {model, endpoint}) -> body|null   the run's usage (graph runs.Usage) from the finished
//                                                        stream, which the dispatcher posts on the run after the worker
//                                                        exits (Dispatcher.recordUsage); null when the stream reported
//                                                        none. Only for a harness that cannot report usage itself
//                                                        (codex); claude reports through its hooks and has none.
import claude from './claude.mjs';
import codex from './codex.mjs';
import grok from './grok.mjs';
import gemini from './gemini.mjs';

/** @typedef {{ name: string, caps: {supported: boolean, experimental: boolean, models: string[]|null, resume: boolean, why?: string},
 *   apis: string[], command: Function, env?: Function, endpointEnv?: Function, plan: Function, prepare?: Function,
 *   prepareWhat?: string, promptRules: () => string, events: (path: string) => Iterable<any>, preflight?: Function, sweep?: Function,
 *   usageAfterExit?: (summary: any, ctx: {model: string|null, endpoint: any}) => object|null }} HarnessAdapter */

/** @type {Record<string, HarnessAdapter>} */
export const ADAPTERS = { claude, codex, grok, gemini };
export const HARNESSES = Object.keys(ADAPTERS);

/** The adapter for a harness name (default claude); throws for a name no adapter answers to. */
export function adapterFor(harness) {
  const a = ADAPTERS[harness || 'claude'];
  if (!a) throw new Error(`unknown harness ${harness}: must be one of ${HARNESSES.join(', ')}`);
  return a;
}

/** Every adapter's per-worker files left in the state dir (a SIGKILLed dispatcher leaves them, and their secrets, behind). */
export function sweepWorkerFiles(state) {
  for (const a of Object.values(ADAPTERS)) a.sweep?.(state);
}

/** The harnesses a run can launch: --harness, every route's harness, and every route:<harness> fallback. */
export function runHarnesses(table, defaultHarness = 'claude') {
  const out = new Set([defaultHarness || 'claude']);
  for (const r of Object.values(table?.routes || {})) {
    if (r.harness) out.add(r.harness);
    const t = typeof r.fallback === 'string' && r.fallback.startsWith('route:') ? r.fallback.slice(6) : null;
    if (t && ADAPTERS[t]) out.add(t);
  }
  return [...out].filter((h) => ADAPTERS[h]);
}

/** The host checks for the harnesses a run can launch ([{name, ok, line}]); a harness without checks adds none. */
export function harnessPreflight(harnesses, args = {}, sys = {}) {
  return harnesses.flatMap((h) => ADAPTERS[h]?.preflight?.(args, sys) || []);
}
