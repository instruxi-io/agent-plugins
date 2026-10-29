#!/usr/bin/env node
// Everything the slash commands print. Plain text on stdout -- these are read
// by a person mid-session, so money first and jargon never.
import { loadState, loadConfig, saveConfig, saveState, verify, withLock, commit, RECEIPTS } from './store.mjs';
import { readManaged, merge, envReading, envIgnoredLines, ENV_OVERRIDES, decisioningLine } from './managed.mjs';
import { DEFAULTS, priceOf, dollarsForTokens, burnRate, release } from './policy.mjs';
import { SETTINGS, GROUPS, RETIRED, validate, parseValue } from './settings.mjs';
import { seal } from './chain.mjs';
import { hashVersion, ackedHash } from './outbox.mjs';

// Everything after the subcommand is ONE argument. The slash commands pass
// $ARGUMENTS unquoted, so `/enforcer-governor:set budgetOn false` arrives as
// two argv entries; taking only the first made every typed `set` print its
// usage line and change nothing.
const [, , cmd, ...rest] = process.argv;
const arg = rest.join(' ').trim();
const cfg = { ...DEFAULTS, ...loadConfig() };
const state = loadState();
// Checks this process's environment turns on or off (ENFORCER_GOVERNOR_RULES,
// _BUDGET, _POLICY). `on` beats config.json for this process tree; `off` only
// with allowEnvOff in config.json (managed.mjs). Both `config` and `status`
// say where a value came from, and which variables were ignored and why.
const envSays = envReading(process.env, cfg);
const fromEnv = envSays.applied;
const ignoredEnv = envIgnoredLines(process.env, cfg);
const ignoredLine = () => (ignoredEnv.length ? "Ignored from this process's environment: " + ignoredEnv.join('; ') + '.' : '');
const envLine = () =>
  Object.keys(fromEnv).length
    ? "Set by this process's environment: " +
      Object.keys(fromEnv)
        .map((k) => `${ENV_OVERRIDES[k]}=${fromEnv[k] ? 'on' : 'off'}`)
        .join(', ') +
      '. These apply to this process and its children, not to the machine-wide config.'
    : '';
// The harness prefixes an agent id can carry ('claude:0f3c9a1b', 'grok:...',
// 'codex:...'), so `resume 0f3c9a1b` finds the agent under any of them.
const ID_PREFIXES = ['claude', 'grok', 'codex'];
const usd = (t, m) => '$' + dollarsForTokens(t, priceOf(m, cfg.model).in).toFixed(2);

// The file, checked against the chain head in state.json and the newest
// receipt the control plane acknowledged (store.mjs verify()).
/** @returns {any} the verify() result; its shape varies by outcome */
const checkRecord = () => verify(RECEIPTS, { acked: ackedHash() });

if (cmd === 'verify') {
  const v = checkRecord();
  if (v.missing && v.truncated)
    console.log(
      `The record does NOT check out. ${RECEIPTS} is missing, but the control plane acknowledged receipts from this machine (newest ${v.head.slice(0, 12)}...), so the file has been deleted or moved.\nThe receipts shipped to the server are the only copy outside this machine.`,
    );
  else if (v.missing)
    console.log(
      `The record does NOT check out. ${RECEIPTS} is missing, but the governor's state still names a head (${v.head.slice(0, 12)}...), so receipts were written and the file has been deleted or moved.\nThe receipts shipped to the server are the only copy outside this machine.`,
    );
  else if (v.headMismatch)
    console.log(
      `The record does NOT check out. All ${v.receipts} lines chain, but the last one is not the head the governor last recorded: lines are missing from the end.\nFile: ${RECEIPTS}`,
    );
  else if (v.truncated)
    console.log(
      `The record does NOT check out. All ${v.receipts} lines chain, but the file no longer holds the newest receipt the control plane acknowledged: lines are missing from the end.\nFile: ${RECEIPTS}`,
    );
  else if (v.unhashedTail && v.breakCount === 1)
    console.log(
      `The record does NOT check out. Line ${v.brokeAt} of ${v.receipts}, the last, carries no hash, so nothing shows it was not edited.${v.blind ? ' It says it was decided while the governor could not read its own chain; if so, the next decision recorded after it makes the record check out again.' : ''}\nFile: ${RECEIPTS}`,
    );
  else if (!v.receipts) console.log('No decisions recorded yet.');
  else if (v.ok)
    console.log(
      `All ${v.receipts} records check out.${v.unverifiable ? ` (${v.unverifiable} carry no hash and could not be chain-checked: either written before hashes were stored, or decided while the governor could not read its own chain.)` : ''}`,
    );
  else {
    const shown = v.breaks.slice(0, 10).join(', ');
    const more = v.breakCount > 10 ? ` and ${v.breakCount - 10} more` : '';
    console.log(
      `The record does NOT check out. ${v.breakCount} of ${v.receipts} lines do not match the one before them (first: line ${v.brokeAt}; lines ${shown}${more}). ${v.linked} of ${v.receipts} lines chain correctly. The last line ${v.headMatches ? 'is' : 'is not'} the head the governor recorded.\nFile: ${RECEIPTS}`,
    );
  }
  // Non-zero on a broken chain, so a script or CI step can gate on it.
  process.exit(v.ok ? 0 : 1);
}

// Everything the v1 console could turn, as text. Grouped, because the order
// these are read in is not the order they are stored in, and showing 18 flat
// keys is the wall the console's "?" affordances existed to avoid.
if (cmd === 'config') {
  const live = loadConfig();
  // What the organisation publishes, and therefore what this machine is only
  // free to TIGHTEN. Showing the local value alone would be a lie on any
  // setting the tenant floors (src/managed.mjs).
  const managed = readManaged();
  const local = { ...cfg, ...fromEnv };
  const applied = merge(local, managed);
  const width = Math.max(...Object.keys(SETTINGS).map((k) => k.length));
  for (const g of GROUPS) {
    const keys = Object.keys(SETTINGS).filter((k) => SETTINGS[k].group === g);
    if (!keys.length) continue;
    console.log(`\n${g.toUpperCase()}`);
    for (const k of keys) {
      const spec = SETTINGS[k];
      const val = applied[k];
      // Mark what has been changed. On a page of defaults the two or three
      // someone actually set are the only interesting rows.
      const set = Object.prototype.hasOwnProperty.call(live, k) && live[k] !== DEFAULTS[k];
      const shown = spec.type === 'boolean' ? (val ? 'on' : 'off') : spec.unit === '$' ? `$${val}` : String(val);
      // A managed setting is marked, and the local value is shown beside it
      // when the two differ -- otherwise "it says $150 but I set $400" has no
      // visible explanation.
      const mine = k in fromEnv ? fromEnv[k] : live[k];
      const floored = k in managed && applied[k] !== mine && mine !== undefined;
      const env =
        k in fromEnv
          ? `  [from the environment: ${ENV_OVERRIDES[k]}=${fromEnv[k] ? 'on' : 'off'}]`
          : envSays.ignoredOff.includes(k)
            ? `  [${ENV_OVERRIDES[k]}=off ignored: allowEnvOff is off]`
            : k in envSays.unrecognised
              ? `  [${ENV_OVERRIDES[k]}=${JSON.stringify(envSays.unrecognised[k])} ignored: expected on or off]`
              : '';
      console.log(
        `  ${k.padEnd(width)}  ${shown.padEnd(12)}${k in managed ? '!' : k in fromEnv ? '~' : set ? '*' : ' '} ${spec.describe}` +
          env +
          (floored ? `  [your organisation's setting; yours was ${String(mine)}]` : ''),
      );
      if (arg === '--why' && spec.hint) console.log(`  ${' '.repeat(width)}  ${' '.repeat(13)}${spec.hint}`);
    }
  }
  console.log('\n  * changed from the default.  Type /enforcer:governor config to see what each one does.');
  if (Object.keys(managed).length) {
    console.log(`  ! set by your organisation (${Object.keys(managed).length} setting(s)). You can make these stricter, not looser.`);
  }
  if (Object.keys(fromEnv).length) console.log(`  ~ set by this process's environment. ${envLine()}`);
  if (ignoredEnv.length) console.log(`  ${ignoredLine()}`);
  console.log('  Change one by typing /enforcer:governor set <name> <value>.');
  const dead = Object.keys(RETIRED).filter((k) => k in live);
  if (dead.length) {
    console.log(`\n  Your config still carries ${dead.length} retired setting(s) that do nothing:`);
    for (const k of dead) console.log(`    ${k}: ${RETIRED[k]}`);
  }
  process.exit(0);
}

if (cmd === 'set') {
  const [key, ...rest] = (arg || '').split(/\s+/);
  const raw = rest.join(' ');
  if (!key || raw === '') {
    console.log('Type /enforcer:governor set <name> <value>. To see the names, type /enforcer:governor config.');
    process.exit(0);
  }
  const err = validate(key, raw);
  // Refuse rather than absorb. These values are compared against spend on every
  // tool call and the failure is silent: a soft mark of 75 instead of 0.75 means
  // the warn never fires and nothing tells you.
  if (err) {
    console.log(`Not changed: ${err}`);
    process.exit(0);
  }
  const value = parseValue(SETTINGS[key], raw);
  const before = cfg[key];
  saveConfig({ ...loadConfig(), [key]: value });
  const show = (v) => (SETTINGS[key].type === 'boolean' ? (v ? 'on' : 'off') : String(v));
  console.log(`${key}: ${show(before)} -> ${show(value)}   ${SETTINGS[key].describe}`);
  if (SETTINGS[key].hint) console.log(`  ${SETTINGS[key].hint}`);
  const managed = readManaged();
  if (key in managed) {
    const applied = merge({ ...cfg, [key]: value }, managed)[key];
    const show2 = (v) => (SETTINGS[key].type === 'boolean' ? (v ? 'on' : 'off') : String(v));
    if (applied !== value) {
      console.log(`Your organisation sets ${key} to ${show2(managed[key])}, and a local value can only be stricter, so ${show2(applied)} is what applies.`);
    }
  }
  if (key in fromEnv) {
    console.log(`${ENV_OVERRIDES[key]}=${fromEnv[key] ? 'on' : 'off'} is set in this process's environment and beats config.json here and in its children.`);
  } else if (envSays.ignoredOff.includes(key)) {
    console.log(`${ENV_OVERRIDES[key]}=off is set in this process's environment but ignored, because config.json does not set allowEnvOff.`);
  }
  console.log('Agents already running pick this up on their next action.');
  process.exit(0);
}

if (cmd === 'limit') {
  const d = Number(arg);
  if (!Number.isFinite(d) || d <= 0) {
    console.log('Give a dollar amount, for example /enforcer:governor limit 40');
    process.exit(0);
  }
  saveConfig({ ...loadConfig(), dollars: d });
  console.log(`Spend limit is now $${d} per agent, at ${priceOf(cfg.model).label} rates. Agents already running pick this up on their next action.`);
  process.exit(0);
}

// The way out of being stopped. release() has existed since v1 and nothing ever
// called it, so "resume it" was advice with no command behind it. Held under the
// lock because it mutates state and appends a receipt: a human overriding the
// governor is exactly the kind of decision the record has to carry.
if (cmd === 'resume') {
  const held = withLock(() => {
    const s = loadState();
    const stopped = Object.entries(s.agents || {}).filter(([, a]) => a.status === 'grounded');
    if (!stopped.length) return { msg: 'No agent is stopped. Nothing to resume.' };

    let ids = arg ? [arg, ...ID_PREFIXES.map((p) => p + ':' + arg)].filter((id) => s.agents[id]) : stopped.map(([id]) => id);
    if (arg && !ids.length) return { msg: `No agent called ${arg}. Stopped right now: ${stopped.map(([id]) => id).join(', ')}` };
    // With no argument and several stopped, name them rather than guess: resuming
    // the wrong agent spends real money on work nobody asked to continue.
    if (!arg && ids.length > 1) {
      return {
        msg:
          `${ids.length} agents are stopped. Name one:\n` +
          ids.map((id) => `  /enforcer:governor resume ${id.replace(/^(claude|grok|codex):/, '')}`).join('\n'),
      };
    }
    const id = ids[0];
    const before = s.prevHash;
    // release() chains its receipt as v1; re-seal it under the version the
    // governor writes now, from the same prev (chain.mjs).
    const out = seal(before, release(s, id).entry, hashVersion());
    commit(s, out.entry, out.hash, before);
    const a = s.agents[id];
    return { msg: `${id} is running again, with its limit raised to ${usd(a.budget, a.model)}. Recorded as your decision.` };
  });
  console.log(held.ok && held.value ? held.value.msg : 'Could not take the lock on the governor state, so nothing was changed. Try again.');
  process.exit(0);
}

console.log(decisioningLine(cfg));
if (Object.keys(fromEnv).length) console.log(envLine() + '\n');
if (ignoredEnv.length) console.log(ignoredLine() + '\n');
const agents = Object.values(state.agents || {});
if (!agents.length) {
  console.log('No agents seen yet.');
  process.exit(0);
}

console.log(
  `Limit: $${cfg.dollars} per agent  ·  warns at ${Math.round(cfg.soft * 100)}%  ·  $${cfg.burnLimit}/min per agent, $${cfg.fleetBurnLimit}/min across all`,
);
console.log('');
for (const a of agents.sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).slice(0, 12)) {
  const pct = a.budget ? Math.round((a.tokens / a.budget) * 100) : 0;
  // Say WHY it stopped, not just that it did. "STOPPED" alone sends people to
  // the state file; the reason tells them whether to raise a limit or resume.
  const why =
    {
      limit: 'over its limit',
      soft: 'past the warn mark',
      client: 'client cap',
      day: 'daily cap',
      week: 'weekly cap',
      month: 'monthly cap',
      human: 'you stopped it',
    }[a.groundedBy] || '';
  const flag = a.status === 'grounded' ? `  STOPPED${why ? ' - ' + why : ''}` : a.escalated ? '  WAITING ON YOU' : '';
  console.log(`  ${a.id.padEnd(18)} ${usd(a.tokens || 0, a.model).padStart(8)}  ${String(pct).padStart(3)}%${a.client ? '  ' + a.client : ''}${flag}`);
}
if (agents.some((a) => a.status === 'grounded')) {
  console.log('\nTo let a stopped AI agent run again, type /enforcer:governor resume. Raising the limit');
  console.log('with /enforcer:governor limit also lets any agent stopped for spending carry on.');
}
const burn = burnRate(state);
if (burn > 0) console.log(`\nRight now: $${burn.toFixed(2)}/min across every agent.`);
const v = checkRecord();
console.log(
  `\nRecord: ${v.receipts} decisions, ${v.ok ? 'all check out' : v.missing ? 'BROKEN: the receipt file is missing' : v.truncated ? 'BROKEN: lines are missing from the end' : `BROKEN at line ${v.brokeAt}`}.`,
);
