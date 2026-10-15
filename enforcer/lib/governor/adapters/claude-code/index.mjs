// The Claude Code adapter: how Claude Code measures spend, bound to the core.
// The hooks in hooks/ are the rest of it -- they read Claude Code's hook JSON,
// call the governor, and answer in Claude Code's permission vocabulary.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGovernor } from '../../core/governor.mjs';
import { read, harnessUsd, HARNESS, TRANSCRIPT } from './meter.mjs';
import { readUsage } from './usage.mjs';

/**
 * Claude Code's spend: its transcript for the model and the tokens, and the
 * status line's total_cost_usd where it is fresh. Claude Code prices a session
 * at the organisation's CONTRACTED rates, which no table can know, so its
 * figure wins where we have it; `source` says which one answered.
 */
export const cost = {
  // A subagent is metered from its own transcript, never the parent's: the
  // session's status-line figure and transcript are the parent's spend.
  read: (event, cfg) =>
    event.subagent
      ? { ...readUsage('agent-' + event.subagent.id, event.subagent.transcript), usd: null, source: TRANSCRIPT }
      : read(event.session, event.transcript, cfg),
  total: (event) => {
    const { tokens, model } = readUsage(event.session, event.transcript);
    const usd = harnessUsd(event.session);
    return { tokens, model, usd, source: usd === null ? TRANSCRIPT : HARNESS };
  },
};

// The adapter's version is the plugin's: this adapter ships inside the plugin
// and changes with it. Read once per hook process; a package.json that cannot
// be read costs the receipts a label, never a decision.
export const HARNESS_NAME = 'claude-code';
export const ADAPTER_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '');
  } catch {
    return '';
  }
})();

// The plugin's own shipper, as it has always been: it reports the plugin
// version as the OTLP service.version, and it is the one `node bin/ship.mjs`
// runs by hand.
export const SHIPPER = fileURLToPath(new URL('../../bin/ship.mjs', import.meta.url));

// Which harness is actually running these hooks. Grok Build and Codex run the
// same hook scripts as Claude Code, so HARNESS_NAME (what the receipts say
// decided) is not proof of it. Grok's shim sets ENFORCER_HARNESS; Claude Code
// marks its environment CLAUDECODE=1. Codex sets neither yet, so it is ''
// there: a session is announced only under a harness that is known, because
// announcing a Codex session as claude-code would make it a contradiction.
const RUNNING = { grok: 'grok-cli', codex: 'codex' };
export function runningHarness(env = process.env) {
  if (RUNNING[env.ENFORCER_HARNESS]) return RUNNING[env.ENFORCER_HARNESS];
  return env.CLAUDECODE === '1' ? HARNESS_NAME : '';
}

export const governor = () => createGovernor({ harness: HARNESS_NAME, adapterVersion: ADAPTER_VERSION, cost, shipper: SHIPPER });
