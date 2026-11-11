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
import claude from './claude.mjs';
import codex from './codex.mjs';
import grok from './grok.mjs';
import gemini from './gemini.mjs';

/** @typedef {{ name: string, caps: {supported: boolean, experimental: boolean, models: string[]|null, resume: boolean, why?: string},
 *   apis: string[], command: Function, env?: Function, endpointEnv?: Function, plan: Function, prepare?: Function,
 *   prepareWhat?: string, promptRules: () => string, events: (path: string) => Iterable<any>, preflight?: Function }} HarnessAdapter */

/** @type {Record<string, HarnessAdapter>} */
export const ADAPTERS = { claude, codex, grok, gemini };
export const HARNESSES = Object.keys(ADAPTERS);

/** The adapter for a harness name (default claude); throws for a name no adapter answers to. */
export function adapterFor(harness) {
  const a = ADAPTERS[harness || 'claude'];
  if (!a) throw new Error(`unknown harness ${harness}: must be one of ${HARNESSES.join(', ')}`);
  return a;
}
