// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// The per-graph dispatcher lease: (host, pid, nonce) on the data of a `dispatcher-lease` node.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseTs } from './util.mjs';

export const LEASE_KEY = 'dispatcher-lease';
export const LEASE_TTL = 180; // seconds a lease outlives its last renewal

export class Lease {
  constructor(
    api,
    graph,
    { say = () => {}, takeover = false, noLease = false, dryRun = false, host = hostname(), pid = process.pid, nonce = randomUUID().replaceAll('-', '') } = {},
  ) {
    Object.assign(this, { api, graph, say, takeover, noLease, dryRun, host, pid, nonce });
  }

  data() {
    return {
      dispatcher: { owner: 'graph-dispatch', host: this.host, pid: this.pid, nonce: this.nonce, until: new Date(Date.now() + LEASE_TTL * 1000).toISOString() },
    };
  }

  isUs(held) {
    if (!held) return false;
    if (held.host !== this.host || held.pid !== this.pid) return false;
    return held.nonce == null || held.nonce === this.nonce;
  }

  async node() {
    return (await this.api.nodes(this.graph)).find((n) => n.key === LEASE_KEY) ?? null;
  }

  /** Write, then re-read: true only when our nonce is what the graph holds (read-then-patch is not atomic). */
  async write(cur) {
    const data = this.data();
    if (!cur) {
      await this.api.createNode(this.graph, {
        key: LEASE_KEY,
        type: 'ops',
        status: 'done',
        title: 'graph-dispatch lease',
        description: 'Held by the running graph-dispatch for this graph; renewed each pass. Not work.',
        data: { ...data, dispatcher_lease: true },
      });
    } else {
      await this.api.patchNode(this.graph, cur.id, { data: { ...(cur.data || {}), ...data } });
    }
    const back = await this.node();
    const ours = back?.data?.dispatcher?.nonce === this.nonce;
    if (ours) await this.keepDone(back);
    return ours;
  }

  /** The lease node is bookkeeping, never work, so it must stay `done`. A graph reset (a loop's next epoch) returns
   *  every live node to `active`, this one too, and PATCH cannot set a status: left open, it keeps the epoch from ever
   *  completing (so an on-completion loop never fires again) and the lobby advertises it as work. Best effort: a
   *  failure here must not cost the lease, and the next renewal tries again. */
  async keepDone(n) {
    if (!n?.id || n.status === 'done' || typeof this.api.setNodeStatus !== 'function') return;
    try {
      await this.api.setNodeStatus(this.graph, n.id, 'done');
    } catch (e) {
      this.say(`lease node is ${n.status}, could not set it done: ${e.status ?? e.message}`);
    }
  }

  async acquire(nodes = null) {
    nodes = nodes ?? (await this.api.nodes(this.graph));
    const cur = nodes.find((n) => n.key === LEASE_KEY) ?? null;
    const held = cur?.data?.dispatcher;
    if (held && !this.isUs(held)) {
      const until = parseTs(held.until);
      const live = until !== null && until > Date.now();
      if (live && !this.takeover) {
        this.say(
          `another graph-dispatch holds graph ${this.graph} (host ${held.host} pid ${held.pid}, lease until ${held.until}); exiting. Use --takeover to replace it.`,
        );
        return false;
      }
      if (live) this.say(`TAKEOVER: replacing the dispatcher on ${held.host} pid ${held.pid}`);
    }
    if (!(await this.write(cur))) {
      this.say(`lost the race for the dispatcher lease on graph ${this.graph}; exiting`);
      return false;
    }
    return true;
  }

  async renew() {
    if (this.noLease) return true;
    const cur = await this.node();
    const held = cur?.data?.dispatcher;
    if (held && !this.isUs(held)) {
      this.say(`lease lost to ${held.host} pid ${held.pid}; exiting`);
      return false;
    }
    if (!(await this.write(cur))) {
      this.say('lease lost on re-read; exiting');
      return false;
    }
    return true;
  }

  /** Clear the lease if it is ours. Never throws on an API error. */
  async release() {
    if (this.noLease || this.dryRun) return;
    try {
      const cur = await this.node();
      if (cur && this.isUs(cur.data?.dispatcher)) await this.api.patchNode(this.graph, cur.id, { data: { ...(cur.data || {}), dispatcher: null } });
    } catch {
      /* best effort */
    }
  }
}
