// The dispatcher's graph API client. Every request goes through apiFetch, so it carries X-Graph-Client,
// retries 429/502/503/504 and network blips, and has a timeout. `headers` is an async () => object (auth).
import { apiFetch, ApiError, TIMEOUTS } from '../../lib/api/client.mjs';
import { clip } from './util.mjs';

export class APIError extends Error {
  constructor(status, body = '') {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'APIError';
    this.status = status;
    this.body = String(body);
  }
  /** The server's error detail from a JSON body, else the message. */
  detail() {
    try {
      const j = JSON.parse(this.body);
      const e = j && typeof j === 'object' ? j.error : null;
      const d = j?.detail || (e && typeof e === 'object' ? e.detail : null);
      if (d) return `HTTP ${this.status}: ${clip(typeof d === 'string' ? d : JSON.stringify(d), 600)}`;
    } catch {
      /* not json */
    }
    return this.message;
  }
}

const one = (d) => (Array.isArray(d) ? d[0] : d);

export class API {
  constructor(
    base,
    { headers = async () => ({}), fetchImpl, retries = 3, baseDelayMs = 1000, sleep, timeoutMs = TIMEOUTS.dispatcher } = /** @type {any} */ ({}),
  ) {
    this.base = base.replace(/\/+$/, '');
    this.headers = headers;
    this.o = { fetchImpl, retries, baseDelayMs, timeoutMs, ...(sleep ? { sleep } : {}) };
    if (!fetchImpl) delete this.o.fetchImpl;
  }

  async call(method, path, body) {
    let h;
    try {
      h = await this.headers();
    } catch (e) {
      throw new APIError('auth', `auth failed: ${e.message}`);
    }
    let res;
    try {
      res = await apiFetch(
        this.base + path,
        {
          method,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'graph-dispatch/2.0 (enforcer plugin)', ...h },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        this.o,
      );
    } catch (e) {
      throw new APIError('network', `${e?.name || 'Error'}: ${e?.message || e}`);
    }
    const text = await res.text();
    if (!res.ok) throw new APIError(res.status, text);
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new APIError('network', 'truncated body');
    }
  }

  // api-used: reads data
  async graph(g) {
    return (await this.call('GET', `/graphs/${g}`)).data || {};
  }
  // api-used: reads data
  async frontier(g) {
    return (await this.call('GET', `/graphs/${g}/frontier`)).data || [];
  }
  async nodes(g) {
    const out = [];
    for (let off = 0; ; off += 200) {
      const d = await this.call('GET', `/graphs/${g}/nodes?limit=200&offset=${off}`); // api-used: reads data,meta.total
      out.push(...(d.data || []));
      const total = d.meta?.total ?? out.length;
      if (off + 200 >= total || !(d.data || []).length) return out;
    }
  }
  // api-used: sends runner; reads data; headers X-Graph-Client
  async claim(g, n, runner) {
    return one((await this.call('POST', `/graphs/${g}/nodes/${n}/claim`, { runner })).data);
  }
  /** The run's control channel: the answer's `state` is the instruction (ok, cancel_requested, reclaimed, finished). */
  async heartbeat(g, n, r) {
    const d = await this.call('POST', `/graphs/${g}/nodes/${n}/runs/${r}/heartbeat`, {}); // api-used: reads state,data.state; headers X-Graph-Client
    return { ...d, state: d.state ?? d.data?.state };
  }
  // api-used: sends status,evidence,data,error,pr
  complete(g, n, r, body) {
    return this.call('POST', `/graphs/${g}/nodes/${n}/runs/${r}/complete`, body);
  }
  // api-used: sends key,type,status,title,description,data; reads data
  async createNode(g, body) {
    return one((await this.call('POST', `/graphs/${g}/nodes`, body)).data);
  }
  // api-used: reads data
  async createEdge(g, body) {
    return (await this.call('POST', `/graphs/${g}/edges`, body)).data;
  }
  // api-used: sends data; reads data
  async patchNode(g, n, body) {
    return (await this.call('PATCH', `/graphs/${g}/nodes/${n}`, body)).data;
  }
  // api-used: reads data
  async runs(g, n) {
    return (await this.call('GET', `/graphs/${g}/nodes/${n}/runs`)).data || [];
  }
  // api-used: reads data
  async reviewOpen(g) {
    return (await this.call('GET', `/graphs/${g}/review?open`)).data || [];
  }
  // api-used: reads data
  async node(g, n) {
    return one((await this.call('GET', `/graphs/${g}/nodes/${n}`)).data);
  }
  // api-used: reads data
  async observations(g, n) {
    return (await this.call('GET', `/graphs/${g}/nodes/${n}/observations`)).data || [];
  }
}

export { ApiError };
