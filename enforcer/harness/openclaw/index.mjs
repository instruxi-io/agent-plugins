// The enforcer plugin's OpenClaw entry (openclaw.plugin.json + package.json "openclaw.extensions").
//
// OpenClaw loads this in the Gateway process. It does one thing at runtime: keep OpenClaw's diagnostics-otel
// exporter pointed at Enforcer governance with this machine's telemetry-only key (src/openclaw.mjs), checked at
// Gateway start and hourly after, so a rotated or re-minted key is written back without anyone running a command.
// The Enforcer MCP server is declared statically in openclaw.plugin.json (mcpServers); skills load from skills/.
//
// A plain entry object, not definePluginEntry(): that helper only fills defaults, and importing
// openclaw/plugin-sdk would tie the shared package to OpenClaw's loader aliases.
import { ensureIngestKey, OTLP_BASE } from '../../src/ingest-key.mjs';
import { sync, RECHECK_MS, HARNESS } from '../../src/openclaw.mjs';

export function createEntry({ ensureKey = () => ensureIngestKey({ harness: HARNESS }), otlpBase = () => OTLP_BASE(), recheckMs = RECHECK_MS } = {}) {
  return {
    id: 'enforcer',
    name: 'Enforcer',
    description: 'Enforcer for OpenClaw: the Enforcer MCP server, skills, and telemetry to Enforcer governance.',
    register(api) {
      // discovery and setup-only loads must not start background work
      if (api.registrationMode && api.registrationMode !== 'full') return;
      const log = api.logger ?? console;
      const check = () =>
        sync({
          pluginConfig: api.pluginConfig,
          current: () => api.runtime.config.current(),
          mutate: (fn) => api.runtime.config.mutateConfigFile({ mutate: fn, afterWrite: { mode: 'auto' } }),
          ensureKey,
          otlpBase,
          log,
        }).catch((e) => log.warn?.(`enforcer: telemetry check failed: ${e?.message ?? e}`));
      // A service, not a gateway_start hook: services restart when this plugin's config changes (hybrid reload),
      // so setting telemetry=false takes effect without a Gateway restart. The host scheduler runs one check at a
      // time and joins it on stop.
      api.registerService({
        id: 'enforcer-telemetry',
        apiVersion: 2,
        start({ scheduler }) {
          if (scheduler) scheduler.schedule({ id: 'telemetry', delayMs: 0, everyMs: recheckMs, run: check });
          else void check();
        },
      });
    },
  };
}

export default createEntry();
