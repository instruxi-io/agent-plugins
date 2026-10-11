// SessionStart, PreCompact, Stop/SubagentStop.
// Each returns a hook answer or null and never throws.
import { readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actorKey, stateBase, tightenState, privateDir, privateWrite } from '../state.mjs';
import { loadRun } from '../run.mjs';
import { sweepSessions, prFooter } from '../evidence.mjs';
import { http, httpStatus } from '../http.mjs';
import { redact } from '../redact.mjs';
import { contextPackText } from '../context-pack.mjs';
import { readCredentials, signInProblem, isFederated } from '../../credentials.mjs';
import { envBaseUrl } from '../../config.mjs';
import { configDir } from '../../../hooks/claude/paths.mjs';
import { findConfig, markAttested, isObj } from './common.mjs';
import { pluginVersion } from './attach.mjs';
import { report, workspaceLine, load, DEFAULT_BASE } from './version-check.mjs';

const root = () => process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('../../../', import.meta.url));

/** The marketplace this copy was installed from: <config>/plugins/cache/<marketplace>/<plugin>/<version>. */
export function marketplaceName() {
  const parts = normalize(root()).split(sep);
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.length >= 4 && parts[parts.length - 4] === 'cache' ? parts[parts.length - 3] : 'instruxi';
}

export const baseUrl = () => String(envBaseUrl() || (readCredentials()?.enforcer || {}).base_url || DEFAULT_BASE);

// Any credential this install would send: the shared sign-in, ENFORCER_API_KEY,
// or the graph hooks' GRAPH_API_KEY.
const hasCredential = () => isFederated() || !!String(process.env.GRAPH_API_KEY || '').trim();

export async function notices(health, signedIn = hasCredential) {
  const cfgdir = configDir(),
    mkt = marketplaceName();
  // A machine that never signed in makes no network calls (lib/governor/README.md):
  // without a credential the health fetch is skipped, and with it the tool-drift check.
  if (health == null && !signedIn()) health = false;
  const installed = (load(join(cfgdir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const out = (await report(cfgdir, mkt, pluginVersion(), readCredentials(), baseUrl(), null, health)).map((l) => [`drift:${l}`, l]);
  if (`enforcer-graph@${mkt}` in installed && !(`enforcer@${mkt}` in installed)) {
    out.push([
      `no-enforcer:${mkt}`,
      `enforcer-graph: the \`enforcer\` plugin is not installed, so the graph tools have no MCP server here. Install it in your shell: claude plugin install enforcer@${mkt}  (it brings enforcer-graph's hooks with it), then /enforcer:setup`,
    ]);
  }
  return out;
}

/** The notices not shown before, recording them so each is said once. */
export function unseen(items) {
  const p = join(stateBase(), 'notices.json');
  const prev = load(p);
  const seen = new Set(Array.isArray(prev) ? prev : []);
  const fresh = items.filter(([k]) => !seen.has(k));
  if (fresh.length) {
    try {
      privateDir(stateBase());
      privateWrite(p, JSON.stringify([...new Set([...seen, ...fresh.map(([k]) => k)])].sort()));
    } catch {}
  }
  return fresh.map(([, t]) => t);
}

export async function statusLines(inp, post = http) {
  const cfg = findConfig(inp.cwd || process.env.CLAUDE_PROJECT_DIR);
  if (!cfg) return [];
  const g = cfg.graph_id;
  // api-used: reads data,data.key,data.status
  const [fr, nodes] = await Promise.all([post(cfg, 'GET', `/graphs/${g}/frontier`), post(cfg, 'GET', `/graphs/${g}/nodes?limit=100`)]);
  if (fr == null && nodes == null) return [];
  const lines = [`## enforcer-graph plan status (graph ${g})`];
  const rows = (nodes || {}).data || [];
  if (rows.length) {
    const counts = {};
    for (const n of rows) counts[n.status] = (counts[n.status] || 0) + 1;
    lines.push(
      'nodes by status: ' +
        Object.keys(counts)
          .sort()
          .map((k) => `${k}=${counts[k]}`)
          .join(', '),
    );
    const running = rows.filter((n) => n.status === 'running').map((n) => n.key);
    const failed = rows.filter((n) => n.status === 'failed').map((n) => n.key);
    if (running.length) lines.push('running: ' + running.join(', '));
    if (failed.length) lines.push('failed (claimable for retry once prerequisites are done): ' + failed.join(', '));
  }
  const fnodes = (fr || {}).data || [];
  lines.push('frontier (runnable now, not claimed): ' + (fnodes.length ? fnodes.map((n) => n.key).join(', ') : 'none'));
  const run = loadRun(actorKey(inp));
  if (run)
    lines.push(
      `THIS SESSION HOLDS node ${run.key || run.node_id} (run ${run.run_id}). Continue it, heartbeat rides on your tool calls, and graph_report it before stopping. End any pull request body with the line \`${prFooter(run.run_id)}\`.`,
    );
  else
    lines.push(
      fnodes.length
        ? 'Next: graph_next_work to claim, or graph_plan_status for the full card.'
        : 'Nothing runnable; graph_next_work will say whether to wait or whether the plan is complete.',
    );
  return lines;
}

export async function sessionStart(inp, opts = {}) {
  try {
    tightenState();
    try {
      sweepSessions();
    } catch {}
    markAttested(inp.session_id); // hooks run here: node worked to get this far
    let said = [];
    try {
      said = unseen(await notices(opts.health));
    } catch {}
    const lines = await statusLines(inp, opts.post);
    try {
      const cfg = findConfig(inp.cwd || process.env.CLAUDE_PROJECT_DIR);
      const env = opts.env || process.env;
      const pack =
        cfg || env.GRAPH_ID
          ? await contextPackText(cfg, {
              post: opts.post || http,
              ...(opts.getPack ? { getPack: opts.getPack } : {}),
              ...(opts.env ? { env: opts.env } : {}),
              ...(opts.warn ? { warn: opts.warn } : {}),
            })
          : null;
      if (pack) lines.unshift(pack);
    } catch {}
    let w = null;
    try {
      w = workspaceLine(readCredentials());
    } catch {}
    if (w) lines.unshift(w);
    try {
      const sp = signInProblem();
      if (sp) {
        said.push(sp);
      }
    } catch {}
    if (said.length)
      return { systemMessage: said.join('\n'), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [...said, ...lines].join('\n') } };
    if (lines.length) return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } };
    return null;
  } catch {
    return null;
  }
}

export function lastAssistantText(path, limit = 1500) {
  let last = '';
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(rec) || rec.type !== 'assistant') continue;
      const c = (rec.message || {}).content;
      if (Array.isArray(c)) for (const b of c) if (isObj(b) && b.type === 'text' && String(b.text || '').trim()) last = b.text.trim();
    }
  } catch {}
  return last.slice(0, limit);
}

/** The files the transcript's tool calls touched (file_path, path, notebook_path inputs), in first-seen order. */
export function touchedFiles(path, limit = 200) {
  const seen = new Set();
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const c = isObj(rec) && isObj(rec.message) ? rec.message.content : null;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (!isObj(b) || b.type !== 'tool_use' || !isObj(b.input)) continue;
        for (const k of ['file_path', 'path', 'notebook_path']) if (typeof b.input[k] === 'string' && b.input[k]) seen.add(b.input[k]);
      }
    }
  } catch {}
  return [...seen].slice(0, limit);
}

/** Default writer: the parsed body on success, else {ok: false, status} (status 0 = no response, e.g. a timeout). */
async function postWithStatus(cfg, method, path, body) {
  const [status, out] = await httpStatus(cfg, method, path, body);
  return out && out.success !== false ? out : { ok: false, status };
}

export async function rememberOnCompact(inp, post = postWithStatus) {
  try {
    const sid = inp.session_id;
    const run = loadRun(actorKey(inp));
    if (!run) return null;
    const cfg = findConfig(inp.cwd || process.env.CLAUDE_PROJECT_DIR);
    if (!cfg) return null;
    const text = lastAssistantText(inp.transcript_path || '') || 'context was compacted while this run was open; no assistant summary was available';
    const body = redact(`Progress at compaction (${inp.trigger || 'auto'}), run ${run.run_id} in session ${sid}:\n${text}`)[0];
    const source = `claude-code:compact:${sid}`;
    const data = JSON.parse(
      redact(JSON.stringify({ session_id: sid, run_id: run.run_id, node_key: run.key || run.node_id, files: touchedFiles(inp.transcript_path || '') }))[0],
    );
    // api-used: sends body,source,kind,data
    const wrote = await post(cfg, 'POST', `/graphs/${run.graph_id}/observations`, { body, source, kind: 'summary', scope: 'graph', data });
    // fall back only on a definite unsupported route (404/405); a timeout may have committed, so it never double-posts
    if (wrote && wrote.ok === false && (wrote.status === 404 || wrote.status === 405)) {
      // an older service without graph scope: today's node-scoped write
      await post(cfg, 'POST', `/graphs/${run.graph_id}/nodes/${run.node_id}/observations`, { body, source, data: { ...data, kind: 'progress' } });
    }
  } catch {}
  return null;
}

// Pass only on an explicit marker at the END of the message: `still running: <run id>`.
export function passes(msg, run) {
  const m = /still running:\s*`?([0-9A-Za-z-]+)`?[\s.]*$/i.exec(msg || '');
  return !!m && m[1] === String(run.run_id);
}

export async function openRunGuard(inp) {
  try {
    if (inp.stop_hook_active) return null;
    const run = loadRun(actorKey(inp));
    if (!run) return null;
    if (passes(inp.last_assistant_message || '', run)) return null;
    const key = run.key || run.node_id;
    return {
      decision: 'block',
      reason: `enforcer-graph: this session still holds node ${key} (run ${run.run_id}) and has not reported it. Before stopping, either graph_report it (succeeded or failed, with a report that answers each acceptance line), or graph_remember your progress and end your final message with \`still running: ${run.run_id}\`.`,
    };
  } catch {
    return null;
  }
}
