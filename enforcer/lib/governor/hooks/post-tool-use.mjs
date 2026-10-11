#!/usr/bin/env node
// The outcome. v1 recorded only intentions -- it knew it had allowed
// `terraform apply` and never learned whether it ran. A failed call is also
// the cheap half of a retry storm: the rate-limited call returns fast, and the
// retry after it is what costs money.
import { guard, input, emit } from './lib.mjs';
import { fileURLToPath } from 'node:url';
import { agentOf } from '../adapters/claude-code/events.mjs';
await guard(async () => {
  const ev = input('PostToolUse');
  const failed = !!(ev.tool_response && (ev.tool_response.is_error || ev.tool_response.error));

  // Fast path, the one nearly every call takes: it worked and nothing is pending, so no state
  // changes. Peek without the lock and without loading the whole governor (a hook runs per tool call).
  if (!failed) {
    let quiet = false;
    try {
      // One key, read straight from the file: no bound(), no receipt-head read, no config read.
      const { peekPendingAsk, peekShipOn } = await import('../core/peek.mjs');
      quiet = !peekPendingAsk(agentOf(ev));
      if (quiet && peekShipOn()) {
        const { kick } = await import('../core/ship.mjs');
        kick(30_000, fileURLToPath(new URL('../bin/ship.mjs', import.meta.url)));
      }
    } catch {
      quiet = false;
    }
    if (quiet) emit('PostToolUse', {});
  }
  const { governor } = await import('../adapters/claude-code/index.mjs');

  // Record the outcome and ship what has been decided, without waiting: the
  // shipper is spawned detached at most every 30s. No network on this path.
  governor().after({ agent: agentOf(ev) }, { failed });

  emit('PostToolUse', {});
});
