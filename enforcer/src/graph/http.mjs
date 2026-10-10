// Hook-side graph HTTP through the shared API client. Never throws.
import { apiFetch, TIMEOUTS } from '../../lib/api/client.mjs';

const timeoutMs = () => Number(process.env.GRAPH_HOOK_TIMEOUT) * 1000 || TIMEOUTS.hook;

async function call(cfg, method, path, body, o) {
  const res = await apiFetch(
    `${cfg.base_url}/api/v1/graph${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', ...(cfg.api_key ? { 'X-API-Key': cfg.api_key } : {}) },
      ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
    },
    { auth: !cfg.api_key, timeoutMs: timeoutMs(), retries: 1, baseDelayMs: 50, maxDelayMs: 200, hooks: 'on', ...o },
  );
  let out = null;
  try {
    out = await res.json();
  } catch {}
  return [res, out];
}

/** Parsed JSON object, or null on any failure (4xx/5xx, timeout, bad JSON, success:false). */
export async function http(cfg, method, path, body, o = {}) {
  try {
    const [res, out] = await call(cfg, method, path, body, o);
    if (!res.ok) return null;
    return out && typeof out === 'object' && !Array.isArray(out) && out.success !== false ? out : null;
  } catch {
    return null;
  }
}

/** [status, body|null, errorBody|null]; status 0 when no response came back. errorBody is the parsed body of a non-2xx answer. */
export async function httpResult(cfg, method, path, body, o = {}) {
  try {
    const [res, out] = await call(cfg, method, path, body, o);
    const obj = out && typeof out === 'object' && !Array.isArray(out) ? out : null;
    return [res.status, res.ok ? obj : null, res.ok ? null : obj];
  } catch {
    return [0, null, null];
  }
}

/** [status, body|null]; status 0 when no response came back. */
export async function httpStatus(cfg, method, path, body, o = {}) {
  const [status, out] = await httpResult(cfg, method, path, body, o);
  return [status, out];
}

/** Raw bytes: {status, bytes, etag}; status 0 (bytes null) when no response came back. A 304 carries no bytes. Never throws. */
export async function httpBytes(cfg, path, headers = {}, o = {}) {
  try {
    const res = await apiFetch(
      `${cfg.base_url}/api/v1/graph${path}`,
      { method: 'GET', headers: { ...(cfg.api_key ? { 'X-API-Key': cfg.api_key } : {}), ...headers } },
      { auth: !cfg.api_key, timeoutMs: timeoutMs(), retries: 1, baseDelayMs: 50, maxDelayMs: 200, hooks: 'on', ...o },
    );
    const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    return { status: res.status, bytes, etag: res.headers?.get?.('etag') || null };
  } catch {
    return { status: 0, bytes: null, etag: null };
  }
}
