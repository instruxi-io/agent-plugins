// Which harness is actually running these hooks, and the agent-id prefix that
// names it. Its own small module so the status line and the event code can ask
// without loading the governor.
//
// Grok Build and Codex run the same hook scripts as Claude Code, so the
// adapter's name ('claude-code') is not proof of it. Grok's shim sets
// ENFORCER_HARNESS=grok; Codex's hooks file passes `--harness codex`, which
// bin/enforcer turns into ENFORCER_HARNESS=codex; Claude Code marks its
// environment CLAUDECODE=1. With none of them it is '': a session is announced
// only under a harness that is known, because announcing a session under the
// wrong one would make it a contradiction.
export const HARNESS_NAME = 'claude-code';
const RUNNING = { grok: 'grok-cli', codex: 'codex' };
export function runningHarness(env = process.env) {
  if (RUNNING[env.ENFORCER_HARNESS]) return RUNNING[env.ENFORCER_HARNESS];
  return env.CLAUDECODE === '1' ? HARNESS_NAME : '';
}

// The agent id's prefix: 'grok:0f3c9a1b', 'codex:0f3c9a1b', and 'claude:' for
// Claude Code and for a harness we cannot tell (what every id was before
// harnesses were told apart). The control plane maps a receipt's stamped
// harness to the same prefixes (enforcer-governance migration 016), which is
// what lets an older plugin's 'claude:' id and this one land on one session.
const PREFIX = { 'grok-cli': 'grok', codex: 'codex' };
export const agentPrefix = (env = process.env) => PREFIX[runningHarness(env)] || 'claude';
