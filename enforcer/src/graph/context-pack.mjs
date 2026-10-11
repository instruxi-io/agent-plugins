// The graph's context pack: one immutable file per graph, fetched once per hash into the state dir and injected byte-identical.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, httpBytes } from './http.mjs';
import { stateBase, privateDir, privateWrite } from './state.mjs';
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export const FETCH_TIMEOUT_MS = 3000;
const SHA = /^[0-9a-f]{64}$/i;

/** ENFORCER_CONTEXT_PACK=0 (set by `enforcer dispatch run --context off`) turns the injection off. */
export const contextEnabled = (env = process.env) => !/^(0|off|false)$/i.test(String(env.ENFORCER_CONTEXT_PACK ?? '1').trim());

/** The first line of the injected text; the file bytes follow it unchanged. */
export const packHeader = (sha) => `enforcer-graph context pack ${String(sha).slice(0, 12)}\n`;

const cachePath = (sha) => join(stateBase(), 'context', `${String(sha).toLowerCase()}.md`);

/** Default fetch: GET /graphs/{id}/context/pack with the worker's own credential (ETag is the sha256; 304 when If-None-Match matches). */
export async function fetchPack(cfg, sha, { cached = false } = {}) {
  const r = await httpBytes(cfg, `/graphs/${cfg.graph_id}/context/pack`, cached ? { 'If-None-Match': `"${sha}"` } : {}, { timeoutMs: FETCH_TIMEOUT_MS });
  return { status: r.status, bytes: r.bytes };
}

const reasonFor = (status) => (status === 404 ? 'no pack on the graph' : status === 0 ? 'HTTP no response' : `HTTP ${status}`);

/**
 * The text to inject, or null (no graph, switched off, no pack, or a failure). Never throws; whenever GRAPH_ID is set and nothing is
 * injected it prints exactly one stderr line `enforcer-graph: context pack not injected (<reason>)`.
 * `post(cfg, 'GET', path)` returns the parsed body or null; `getPack(cfg, sha, {cached})` returns {status, bytes}.
 */
export async function contextPackText(cfg, { post = http, getPack = fetchPack, env = process.env, warn = (m) => process.stderr.write(m + '\n') } = {}) {
  const say = (reason) => {
    try {
      if (env.GRAPH_ID || cfg) warn(`enforcer-graph: context pack not injected (${reason})`);
    } catch {}
    return null;
  };
  try {
    if (!contextEnabled(env)) return say('switched off');
    if (!cfg) return say('no base url');
    // api-used: reads data.pack.sha256
    const body = await post(cfg, 'GET', `/graphs/${cfg.graph_id}/context`, undefined, { timeoutMs: FETCH_TIMEOUT_MS });
    if (body === null || body === undefined) return say('HTTP error reading the graph context');
    const d = isObj(body) && isObj(body.data) ? body.data : body;
    const pack = isObj(d) ? d.pack : null;
    if (!isObj(pack) || !SHA.test(String(pack.sha256 || ''))) return say('no pack on the graph');
    const sha = String(pack.sha256).toLowerCase();
    const p = cachePath(sha);
    const cached = existsSync(p);
    const r = await getPack(cfg, sha, { cached });
    if (r.status === 304 && cached) {
      // the cache is shared, writable state: hash the bytes on every use
      const onDisk = readFileSync(p);
      if (createHash('sha256').update(onDisk).digest('hex') === sha) return packHeader(sha) + onDisk.toString('utf8');
      const again = await getPack(cfg, sha, { cached: false });
      if (again.status !== 200 || !again.bytes || createHash('sha256').update(again.bytes).digest('hex') !== sha) return say('cached pack sha mismatch');
      privateDir(join(stateBase(), 'context'));
      privateWrite(p, again.bytes);
      return packHeader(sha) + again.bytes.toString('utf8');
    }
    if (r.status !== 200 || !r.bytes) return say(reasonFor(r.status));
    if (createHash('sha256').update(r.bytes).digest('hex') !== sha) return say('sha mismatch');
    privateDir(join(stateBase(), 'context'));
    privateWrite(p, r.bytes);
    return packHeader(sha) + r.bytes.toString('utf8');
  } catch (e) {
    return say(String(e?.message || e).slice(0, 120));
  }
}
