// Worker streams: each harness adapter (./harness/<name>.mjs) parses its own NDJSON-or-JSON into the Claude-shaped
// events summarize reads; this module picks the parser and counts.
import { ADAPTERS } from './harness/index.mjs';
import { claudeEvents } from './harness/claude.mjs';

export { claudeEvents } from './harness/claude.mjs';
export { grokEvents } from './harness/grok.mjs';
export { codexEvents } from './harness/codex.mjs';
export { geminiEvents } from './harness/gemini.mjs';

export const HARNESS_PARSERS = Object.fromEntries(
  Object.entries(ADAPTERS)
    .filter(([k]) => k !== 'claude')
    .map(([k, a]) => [k, a.events]),
);

export function* events(path, harness = 'claude') {
  if (harness !== 'claude') {
    yield* HARNESS_PARSERS[harness](path);
    return;
  }
  yield* claudeEvents(path);
}

export function countTurns(path, harness = 'claude') {
  let n = 0;
  for (const e of events(path, harness)) if (e.type === 'assistant') n++;
  return n;
}

/** Count the compact_boundary events (auto-compaction) in a claude worker's stream. */
export function countCompactions(path) {
  let n = 0;
  for (const e of claudeEvents(path)) if (e.type === 'system' && e.subtype === 'compact_boundary') n++;
  return n;
}
