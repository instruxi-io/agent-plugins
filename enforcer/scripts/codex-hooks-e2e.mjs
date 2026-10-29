#!/usr/bin/env node
// Real-Codex check of Enforcer's hooks: installs THIS checkout as a Codex plugin into a throwaway CODEX_HOME,
// approves its hooks the way Codex's own /hooks review does (app-server hooks/list + config/batchWrite), and
// runs `codex exec` against a local stub model that makes one `echo hi` tool call. Passes when every hook
// Codex reports is Completed (Codex prints `hook: <Event> <Status>` on stderr).
//
//   node scripts/codex-hooks-e2e.mjs            needs `codex` on PATH (tested with codex-cli 0.164.0)
//
// Nothing leaves the machine: no real model (the stub answers), Enforcer signed out in temp homes with
// ENFORCER_BASE_URL on a closed local port, and the user's ~/.codex is never read or written.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'codex-e2e-'));
const codexHome = join(tmp, 'codex');
const work = join(tmp, 'project');
mkdirSync(codexHome);
mkdirSync(work);

// A Responses API stub: one exec_command call, then "ok".
const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let input = [];
    try {
      input = JSON.parse(body).input || [];
    } catch {}
    const called = input.some((i) => i && i.type === 'function_call_output');
    const item = called
      ? { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'ok' }] }
      : { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hi' }) };
    const evs = [
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: 'r1', usage } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = /** @type {any} */ (server.address()).port;
writeFileSync(
  join(codexHome, 'config.toml'),
  `model = "gpt-5"\nmodel_provider = "stub"\n\n[model_providers.stub]\nname = "stub"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`,
);

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  ENFORCER_HOME: join(tmp, 'enforcer'),
  ENFORCER_CONFIG_HOME: join(tmp, 'enforcer-config'),
  GOVERNOR_HOME: join(tmp, 'governor'),
  ENFORCER_BASE_URL: 'http://127.0.0.1:9',
};
delete env.ENFORCER_API_KEY;
delete env.CLAUDECODE;
delete env.CLAUDE_ENV_FILE;
const codex = (args) => {
  const r = spawnSync('codex', args, { cwd: work, env, encoding: 'utf8', timeout: 120000 });
  if (r.error) throw r.error;
  return r;
};
const fail = (m) => {
  console.error(`codex-hooks-e2e: FAIL ${m}\n  (left in ${tmp})`);
  server.close();
  process.exit(1);
};

console.log(codex(['--version']).stdout.trim());
for (const args of [
  ['plugin', 'marketplace', 'add', repo],
  ['plugin', 'add', 'enforcer@instruxi'],
]) {
  const r = codex(args);
  if (r.status !== 0) fail(`codex ${args.join(' ')}: ${r.stderr || r.stdout}`);
}

// Approve the hooks exactly as the TUI does (codex-rs/tui/src/hooks_rpc.rs write_hook_trusts).
async function approve() {
  const p = spawn('codex', ['app-server'], { cwd: work, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: p.stdout });
  const waiting = new Map();
  lines.on('line', (l) => {
    try {
      const m = JSON.parse(l);
      if (waiting.has(m.id)) waiting.get(m.id)(m);
    } catch {}
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((res) => {
      waiting.set(++id, res);
      p.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  await call('initialize', { clientInfo: { name: 'codex-hooks-e2e', title: null, version: '0' } });
  p.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const list = await call('hooks/list', { cwds: [work] });
  const hooks = (list.result?.data?.[0]?.hooks || []).filter((h) => h.pluginId === 'enforcer@instruxi');
  if (!hooks.length) fail(`hooks/list found no Enforcer hooks: ${JSON.stringify(list).slice(0, 400)}`);
  const value = Object.fromEntries(hooks.map((h) => [h.key, { trusted_hash: h.currentHash }]));
  const w = await call('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
  if (w.error) fail(`config/batchWrite: ${JSON.stringify(w.error)}`);
  p.kill();
  return hooks.map((h) => h.eventName);
}
console.log(`approved: ${(await approve()).join(' ')}`);

const run = await new Promise((res) => {
  const p = spawn('codex', ['exec', '--skip-git-repo-check', 'run echo hi'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => (err += c));
  p.stdout.on('data', () => {});
  const t = setTimeout(() => p.kill(), 120000);
  p.on('close', (code) => {
    clearTimeout(t);
    res({ code, err });
  });
});
server.close();
const done = [...run.err.matchAll(/^hook: (\w+) (\w+)\s*$/gm)].map((m) => [m[1], m[2]]);
for (const [ev, st] of done) console.log(`  ${ev}: ${st}`);
if (run.code !== 0) fail(`codex exec exited ${run.code}:\n${run.err}`);
const bad = done.filter(([, st]) => st !== 'Completed');
if (bad.length) fail(`hooks not Completed: ${bad.map((b) => b.join(' ')).join(', ')}`);
for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
  if (!done.some(([e]) => e === ev)) fail(`${ev} never ran:\n${run.err}`);
// The governor's local record of the run: what a signed-in session would ship to governance.
let receipts = [];
try {
  receipts = readFileSync(join(env.GOVERNOR_HOME, 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch {}
const tools = receipts.filter((r) => r.tool).map((r) => r.tool);
console.log(
  `governor receipts: ${receipts.length} (harness ${[...new Set(receipts.map((r) => r.harness))].join(',') || '-'}; tools ${tools.join(',') || '-'})`,
);
if (!receipts.length || receipts.some((r) => r.harness !== 'codex')) fail('the governor wrote no Codex receipt');
rmSync(tmp, { recursive: true, force: true });
console.log('codex-hooks-e2e: every Enforcer hook Completed under real Codex');
