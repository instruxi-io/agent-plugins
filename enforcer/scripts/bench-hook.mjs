#!/usr/bin/env node
// Hook latency bench: runs `bin/enforcer event <name>` N times against a fixed Bash payload and
// compares the median with a bare `node -e 0` on the same host.
//   node scripts/bench-hook.mjs [event] [--runs N] [--populated]
//   --populated: first builds a governor dir like a long-lived home (700 agents, 350 unmapped, 500 cursor
//   files) and also prints `populated_overhead_ms=`.
//   event: pre-tool-use (default), post-tool-use, stop, session-start, ...
// Prints `bare_node_ms=<median> hook_ms=<median> overhead_ms=<hook - bare>` and exits 0.
// Every run gets a temp HOME (and temp config, state and plugin data dirs), so the real
// ~/.config is never read or written; decisioning is off there by default, so nothing goes to the network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--runs');
const runs = Math.max(3, Number(at >= 0 ? args[at + 1] : 30) || 30);
const populated = args.includes('--populated');
const event = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs') || 'pre-tool-use';
const cli = fileURLToPath(new URL('../bin/enforcer', import.meta.url));

const base = mkdtempSync(join(tmpdir(), 'enforcer-bench-'));
const cwd = mkdtempSync(join(tmpdir(), 'enforcer-bench-cwd-')); // no .enforcer above it
const env = {
  ...process.env,
  HOME: base,
  USERPROFILE: base,
  CLAUDE_PLUGIN_DATA: join(base, 'data'),
  CLAUDE_CONFIG_DIR: join(base, 'cc'),
};
for (const k of ['GRAPH_ID', 'ENFORCER_STATE_DIR', 'GOVERNOR_HOME', 'ENFORCER_CONFIG_HOME', 'ENFORCER_HOME', 'CLAUDE_ENV_FILE']) delete env[k];

const hookName = event.replace(/(^|-)([a-z])/g, (_, _d, c) => c.toUpperCase());
export const payload = (name) =>
  JSON.stringify({
    hook_event_name: name,
    session_id: 'bench-hook-1',
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'ls -la', description: 'List files' },
    ...(name.startsWith('PostToolUse') ? { tool_response: { stdout: 'a\nb\n', stderr: '', interrupted: false } } : {}),
  });
const input = payload(hookName);

const time = (argv, stdin) => {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, argv, { input: stdin, env, cwd, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) {
    process.stderr.write(`bench-hook: ${argv.join(' ')} exited ${r.status}: ${r.stderr}\n`);
    process.exit(1);
  }
  return ms;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// A synthetic long-lived governor dir: agents shaped like real ones (the big ones carry ~30 KB of `recent`).
const populate = () => {
  const dir = join(base, '.config', 'enforcer', 'governor');
  mkdirSync(dir, { recursive: true });
  const agents = {};
  for (let i = 0; i < 700; i++) {
    const id = `agent-${i}`;
    const recent = [];
    for (let j = 0; j < (i % 3 === 0 ? 8 : 1); j++) recent.push(`Bash:${'x'.repeat(3700)}`);
    agents[id] = { id, tokens: 1000 + i, recent, escalated: false, status: 'active', budget: 500000, soft: 0.8, cost: 0, task: `task ${i}`, tool: 'Bash' };
  }
  const unmapped = {};
  for (let i = 0; i < 350; i++) unmapped[`/home/u/proj-${i}`] = `proj-${i}`;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, unmapped }));
  for (let i = 0; i < 500; i++) writeFileSync(join(dir, `cursor-sess-${i}.json`), JSON.stringify({ offset: i, usd: 0 }));
};

const measure = () => {
  for (let i = 0; i < 3; i++) time([cli, 'event', event], input);
  const bare = [];
  const hook = [];
  // interleave so a load change hits both series alike
  for (let i = 0; i < runs; i++) {
    bare.push(time(['-e', '0'], ''));
    hook.push(time([cli, 'event', event], input));
  }
  return [median(bare), median(hook)];
};

try {
  const [b, h] = measure(); // also warms the file cache and the V8 compile cache
  console.log(`event=${event} runs=${runs}`);
  console.log(`bare_node_ms=${b.toFixed(1)} hook_ms=${h.toFixed(1)} overhead_ms=${(h - b).toFixed(1)}`);
  console.log(`empty_overhead_ms=${(h - b).toFixed(1)}`);
  if (populated) {
    populate();
    const [pb, ph] = measure();
    console.log(`populated_hook_ms=${ph.toFixed(1)}`);
    console.log(`populated_overhead_ms=${(ph - pb).toFixed(1)}`);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
