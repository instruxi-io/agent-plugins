#!/usr/bin/env node
// /enforcer-governor:telemetry [on | off | status]          Claude Code's export (default off)
// /enforcer-governor:telemetry codex [on | off | status]    Codex's export (default on)
import { enable, disable, status } from '../adapters/claude-code/telemetry.mjs';
import * as codex from '../adapters/codex/telemetry.mjs';
import { loadConfig, saveConfig } from '../src/store.mjs';
import { DEFAULTS } from '../src/policy.mjs';
import { stats } from '../src/outbox.mjs';
import { isFederated } from '../src/credentials.mjs';

const [first, second] = process.argv.slice(2).map((s) => String(s).trim());
const cfg = { ...DEFAULTS, ...loadConfig() };
const out = (s) => process.stdout.write(s + '\n');

function codexStatusLine() {
  const t = codex.status(cfg);
  if (t.error) return `Codex telemetry: unknown (${t.error}).`;
  const last = codex.lastAttempt();
  if (last?.skipped && !t.optedOut)
    out(
      `Codex telemetry: the last setup at ${last.at} did not complete (${last.skipped}); ${t.on ? 'the key already in config.toml is still used' : 'it retries at the next Codex session start'}.`,
    );
  for (const k of t.sensitive || []) out(`Warning: otel.${k} is true in ${t.config}, so Codex exports that text. Run telemetry codex on to set it false.`);
  if (t.on) return `Codex telemetry: on, exporting events to ${t.logs} and metrics to ${t.metrics} (${t.config}).`;
  if (t.optedOut) return 'Codex telemetry: off (codexTelemetry). Turn it on with telemetry codex on.';
  if (t.metricsKind === 'statsig' && t.exists)
    return `Codex telemetry: not set up yet; it is written at the next Codex session start while you are signed in (${t.config}).`;
  return `Codex telemetry: not set up (${t.config}). Turn it on with telemetry codex on.`;
}

try {
  if (first === 'codex') {
    const cmd = second || 'status';
    if (cmd === 'on') {
      saveConfig({ ...loadConfig(), codexTelemetry: true });
      if (!isFederated()) {
        out('Codex telemetry is on, but you are not signed in, so no ingest key could be made. Run /enforcer:login; the next Codex session writes it.');
      } else {
        const r = await codex.enable(cfg);
        out(`Codex telemetry on. Codex will export its events to ${r.logs} and its metrics to ${r.metrics}, not to OpenAI.`);
        out(`Authenticated with this machine's Codex ingest key, written to ${r.config} (mode 0600). The key can only write telemetry.`);
        out('Prompt text, responses and tool output are not exported; tool arguments are (Codex has no switch for them). Restart Codex to start exporting.');
      }
    } else if (cmd === 'off') {
      saveConfig({ ...loadConfig(), codexTelemetry: false });
      const r = codex.disable();
      out(
        `Codex telemetry off. ${r.changed ? `Removed the export settings from ${r.config}` : `Nothing to remove from ${r.config}`}; session starts will not add them back. Restart Codex to stop exporting.`,
      );
    } else if (cmd === 'status') {
      out(codexStatusLine());
    } else {
      out('Usage: /enforcer-governor:telemetry codex [on | off | status]');
    }
  } else {
    const cmd = first || 'status';
    if (cmd === 'on') {
      const r = enable(cfg);
      out(`Telemetry on. Claude Code will export its metrics and events to ${r.endpoint}.`);
      out(`Authenticated with your Enforcer sign-in through otelHeadersHelper (${r.helper}); no credential is written to settings.`);
      if (r.removed.length) out(`Removed ${r.removed.join(' and ')} from ${r.settings}: they would export prompt text or tool parameters.`);
      out('Prompt text is not exported. Restart Claude Code to start exporting.');
      if (!isFederated()) out('You are not signed in, so exports will be refused until you run /enforcer-governor:login.');
    } else if (cmd === 'off') {
      const r = disable();
      out(`Telemetry off. Removed the export settings from ${r.settings}; restart Claude Code to stop exporting.`);
    } else if (cmd === 'status') {
      const t = status();
      const q = stats();
      if (t.sensitive?.length)
        out(
          `Warning: ${t.sensitive.join(' and ')} ${t.sensitive.length > 1 ? 'are' : 'is'} set in Claude Code settings, so prompt text or tool parameters are exported. Run /enforcer-governor:telemetry on to remove ${t.sensitive.length > 1 ? 'them' : 'it'}.`,
        );
      out(t.on ? `Claude Code telemetry: on, exporting to ${t.endpoint}.` : 'Claude Code telemetry: off. Turn it on with /enforcer-governor:telemetry on.');
      out(codexStatusLine());
      out(
        cfg.shipOn === false
          ? 'Receipt shipping: off (shipOn).'
          : `Receipt shipping: on. ${q.behind ? `${q.unshippedBytes} bytes waiting` : 'caught up'}${q.shippedAt ? `, last shipped ${new Date(q.shippedAt).toISOString()}` : ', nothing shipped yet'}${q.lastError ? `. Last problem: ${q.lastError.message}` : ''}.`,
      );
    } else {
      out('Usage: /enforcer-governor:telemetry [on | off | status] | codex [on | off | status]');
    }
  }
} catch (e) {
  out(`Not changed: ${e.message}`);
}
