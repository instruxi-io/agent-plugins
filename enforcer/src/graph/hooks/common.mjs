// Shared by the in-process graph hooks: config lookup, tool payload parsing, transcript usage, attestation marker.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stateBase, privateDir, privateWrite } from '../state.mjs';
import { readCredentials } from '../../credentials.mjs';
import { envBaseUrl } from '../../config.mjs';
import { DEFAULT_BASE } from './version-check.mjs';
import { LEGACY_PROJECT_CONFIG } from '../../../hooks/claude/paths.mjs';

export const GRAPH_TOOL_PREFIXES = ['mcp__plugin_enforcer_enforcer__graph_', 'mcp__enforcer__graph_', 'mcp__enforcer-graph__graph_'];
export const isGraphTool = (n) => GRAPH_TOOL_PREFIXES.some((p) => String(n || '').startsWith(p));
export const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

const hostOf = (u) => {
  try {
    return new URL(String(u)).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** A repo's graph.json is untrusted: it may name only an ENFORCER_ or GRAPH_ prefixed variable as the key source, and only the configured enforcer host
 *  (or localhost) as the base. Anything else is dropped with one stderr notice, so a cloned repo cannot send an env secret to its own host. */
function guardRepoCredentialRouting(cfg, env) {
  if (cfg.api_key_env !== undefined && !/^(ENFORCER|GRAPH)_[A-Z0-9_]*$/.test(String(cfg.api_key_env))) {
    process.stderr.write(
      `enforcer: ignoring api_key_env ${JSON.stringify(String(cfg.api_key_env))} from the repo graph config: only ENFORCER_* or GRAPH_* variables may be named\n`,
    );
    delete cfg.api_key_env;
  }
  if (cfg.base_url) {
    const host = hostOf(cfg.base_url);
    const trusted = new Set(['localhost', '127.0.0.1', hostOf(DEFAULT_BASE)]);
    for (const u of [envBaseUrl(env), env.GRAPH_BASE_URL]) if (u) trusted.add(hostOf(u));
    try {
      const sh = readCredentials()?.enforcer?.base_url;
      if (sh) trusted.add(hostOf(sh));
    } catch {
      /* no shared sign-in */
    }
    trusted.delete('');
    if (!host || !trusted.has(host)) {
      process.stderr.write(
        `enforcer: ignoring base_url host ${host || JSON.stringify(String(cfg.base_url))} from the repo graph config: not the configured enforcer host\n`,
      );
      delete cfg.base_url;
    }
  }
}

/** Walk up from `start` for the project graph config; env wins field by field. null when unusable. */
export function findConfig(start) {
  let cfg = {};
  let d = resolve(start || process.cwd());
  for (;;) {
    let p = join(d, '.enforcer', 'graph.json');
    if (!existsSync(p)) p = join(d, LEGACY_PROJECT_CONFIG);
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        cfg = isObj(j) ? j : {};
      } catch {
        cfg = /** @type {any} */ ({});
      }
      break;
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const env = process.env;
  guardRepoCredentialRouting(cfg, env);
  if (env.GRAPH_ID) cfg.graph_id = env.GRAPH_ID;
  if (env.GRAPH_BASE_URL) cfg.base_url = env.GRAPH_BASE_URL;
  if (envBaseUrl(env)) cfg.base_url = envBaseUrl(env);
  cfg.api_key = env[cfg.api_key_env || 'GRAPH_API_KEY'] || env.GRAPH_API_KEY || '';
  const doc = cfg.api_key ? null : readCredentials();
  if (!cfg.base_url && doc) cfg.base_url = doc.enforcer?.base_url || '';
  // base_url is the HOST ROOT (https://api.instruxi.dev): src/graph/http.mjs appends /api/v1/graph. A dispatched worker (GRAPH_ID set) with no base anywhere falls back to the default host.
  if (!cfg.base_url && env.GRAPH_ID) cfg.base_url = DEFAULT_BASE;
  cfg.base_url = String(cfg.base_url || '').replace(/\/+$/, '');
  if (!cfg.graph_id || !cfg.base_url) return null;
  const e = doc?.enforcer || {};
  if (!cfg.api_key && !(env.ENFORCER_API_KEY || e.api_key || e.oauth?.access_token)) return null;
  return cfg;
}

/** An MCP tool result as a hook sees it (string, content blocks, or object with `content`), parsed to an object or {}. */
export function toolPayload(resp) {
  let r = resp;
  if (isObj(r) && 'content' in r && !r.state) r = r.content;
  if (Array.isArray(r))
    r = r
      .filter((b) => isObj(b) && b.text)
      .map((b) => b.text)
      .join('\n');
  if (typeof r === 'string') {
    const s = r.trim();
    try {
      const j = JSON.parse(s);
      return isObj(j) ? j : {};
    } catch {}
    const a = s.indexOf('{'),
      b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        const j = JSON.parse(s.slice(a, b + 1));
        return isObj(j) ? j : {};
      } catch {}
    }
    return {};
  }
  return isObj(r) ? r : {};
}

export function markAttested(...keys) {
  try {
    const d = join(stateBase(), 'attest');
    privateDir(d);
    for (const k of keys) if (k) privateWrite(join(d, String(k)), String(Math.floor(Date.now() / 1000)));
  } catch {}
}

export function actorTranscript(inp) {
  const { transcript_path: tp, agent_id: aid, session_id: sid } = inp || {};
  if (tp && aid && sid) {
    const sub = join(dirname(tp), sid, 'subagents', `agent-${aid}.jsonl`);
    if (existsSync(sub)) return sub;
  }
  return tp;
}

/** Tokens, model and tool calls in a transcript since an ISO time; null when nothing found. */
export function transcriptUsage(path, since) {
  if (!path) return null;
  const seen = new Set(),
    tools = new Set();
  const tot = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  let chars = 0,
    model = null,
    text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(rec) || rec.type !== 'assistant' || (since && (rec.timestamp || '') < since)) continue;
    const msg = rec.message || {};
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_use' && b.id) {
        if (!tools.has(b.id)) chars += JSON.stringify(b.input || {}).length;
        tools.add(b.id);
      } else if (b.type === 'text' || b.type === 'thinking') chars += (b.text || b.thinking || '').length;
    }
    const u = msg.usage;
    if (!msg.id || seen.has(msg.id) || !isObj(u)) continue;
    seen.add(msg.id);
    model = msg.model || model;
    for (const k of Object.keys(tot)) tot[k] += Math.trunc(Number(u[k]) || 0);
  }
  if (!seen.size) return null;
  const recorded = tot.output_tokens;
  delete tot.output_tokens;
  const est = Math.max(recorded, Math.floor(chars / 4));
  return {
    model,
    messages: seen.size,
    tool_uses: tools.size,
    ...tot,
    output_tokens_recorded: recorded,
    output_tokens_est: est,
    total_tokens: Object.values(tot).reduce((a, b) => a + b, 0) + est,
  };
}

export function typedUsage(u) {
  if (!isObj(u)) return null;
  const out = {};
  for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) out[k] = Math.trunc(Number(u[k]) || 0);
  out.output_tokens = Math.trunc(Number(u.output_tokens_est) || Number(u.output_tokens_recorded) || 0);
  if (u.model) out.model = u.model;
  out.source = out.output_tokens !== Math.trunc(Number(u.output_tokens_recorded) || 0) ? 'estimated' : 'reported';
  return out;
}
