// The Codex CLI worker: `codex exec --json` in a workspace-write sandbox. The dispatcher commits and lands for it
// (codex-land.mjs): the sandbox keeps a linked worktree's git metadata read-only.
import { isObj } from '../util.mjs';
import { codexGitRules } from '../codex-land.mjs';
import { knowsModel, readStream } from './common.mjs';

/** `codex exec --json` prints one JSON event per line (fixture: test/fixtures/codex-exec.jsonl):
 *  thread.started{thread_id}, turn.started, item.started|completed{item:{id,type,...}}, turn.completed{usage}.
 *  Item types read: agent_message{text}, command_execution{command,aggregated_output,exit_code,status}.
 *  Anything else (including `error` items, which the fixture shows as warnings) is ignored. */
export function* codexEvents(path) {
  const text = readStream(path);
  if (text === null) return;
  let sid = null;
  let turns = 0;
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    const item = isObj(e.item) ? e.item : {};
    if (e.type === 'thread.started') {
      sid = typeof e.thread_id === 'string' ? e.thread_id : null;
      yield { type: 'system', subtype: 'init', session_id: sid, message: {} };
    } else if (e.type === 'item.completed' && item.type === 'agent_message') {
      turns++;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: String(item.text ?? '') }] } };
    } else if (e.type === 'item.completed' && item.type === 'command_execution') {
      turns++;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command } }] } };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: item.exit_code !== 0, content: String(item.aggregated_output ?? '') }] },
      };
    } else if (e.type === 'turn.completed') {
      const u = isObj(e.usage) ? e.usage : {};
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: turns,
        session_id: sid,
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cached_input_tokens },
        message: {},
      };
    }
  }
}

const caps = { supported: true, experimental: true, models: ['gpt', 'o1', 'o3', 'o4', 'codex'], resume: false };

/** @type {import('./index.mjs').HarnessAdapter} */
export default {
  name: 'codex',
  caps,
  apis: ['openai'],
  command(prompt, model, args) {
    // Headless exec cannot answer an MCP approval prompt ("approval policy is never"): approve only the enforcer server's tools, not shell or other servers.
    const url = process.env.ENFORCER_MCP_URL || 'https://api.instruxi.dev/mcp';
    const cmd = [
      args.codex || process.env.CODEX_BIN || 'codex',
      'exec',
      '--json',
      // default exec sandbox is read-only (a worker could not commit or land): write inside the cwd (the worktree) only,
      // plus network for git push and gh. Narrower than danger-full-access; no approvals needed (exec never asks).
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
    ];
    // No `--add-dir <git common dir>`: workspace-write keeps a linked worktree's git metadata read-only by design even
    // with it (codex 0.164, measured 2026-10-31). A codex worker edits and checks only; the dispatcher commits and lands.
    cmd.push('-c', `mcp_servers.enforcer={url=${JSON.stringify(url)}, default_tools_approval_mode="approve"}`);
    if (knowsModel(caps, model)) cmd.push('--model', model);
    return [...cmd, prompt];
  },
  // Only claude has an endpoint environment until the codex config file exists (ROUTES.md section 4).
  endpointEnv() {
    throw new Error('codex cannot use a custom endpoint');
  },
  plan: () => ({}),
  promptRules: () => codexGitRules(),
  events: codexEvents,
};
