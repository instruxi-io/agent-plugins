// Cheap reads for the PostToolUse fast path (a hook runs per tool call). These import nothing heavy: no
// store.mjs (its import hardens the whole governor dir), no bound(), no receipt-head read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toBool } from './bool.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const DIR = process.env.GOVERNOR_HOME || join(process.env.ENFORCER_CONFIG_HOME || join(HOME, '.config', 'enforcer'), 'governor');

/** Does this agent hold a pendingAsk? A bare read of the one key; missing or unreadable means no. */
export function peekPendingAsk(agent) {
  try {
    const buf = readFileSync(join(DIR, 'state.json'));
    if (!buf.includes('"pendingAsk"')) return false; // the common case: no UTF-8 decode, no parse of the whole file
    return !!JSON.parse(buf.toString('utf8'))?.agents?.[agent]?.pendingAsk;
  } catch {
    return false;
  }
}

/** Is shipping on? Only an explicit off spelling in config.json turns it off (same predicate as isOff). */
export function peekShipOn() {
  try {
    return toBool(JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'))?.shipOn) !== false;
  } catch {
    return true;
  }
}
