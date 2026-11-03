// Carrying what one worker learned about a repo to the next worker in it. Two layers:
//
//  - Handoffs (every harness). A worker that finishes a repo node leaves a short note on that node with graph_remember
//    (source "handoff"): the layout, the commands that worked, the traps. The dispatcher reads the newest notes from
//    the finished nodes in the same repo and puts them in the next worker's prompt as data. It is plain text on the
//    server, so it crosses harnesses, machines and dispatchers, and needs nothing from the harness but the MCP tools.
//  - Warm sessions (--warm, a harness whose HARNESS_CAPS entry has `resume`). A session that ended in a clean report
//    goes into a pool keyed by repo and lane (harness + model); the next node in that repo on that lane continues it
//    instead of starting cold, within --warm-max-nodes and --warm-max-age. Only claude resumes today.
import { repoOf, sessionUsable, warmKey } from './select.mjs';

export const HANDOFF_SOURCE = 'handoff';
export const HANDOFF_LIMIT = 3; // notes per prompt
export const HANDOFF_NOTE_CHARS = 1500; // per note
export const HANDOFF_SCAN = 8; // finished nodes read per launch, newest first
export const DEFAULT_WARM_MAX_NODES = 3;
export const DEFAULT_WARM_MAX_AGE = 1800; // seconds; past the prompt cache a resume re-reads the whole transcript at full price

/** The pool's lane: one harness and one model, since a session can only be continued by the harness that wrote it. */
export const laneOf = (harness, model) => `${harness || 'claude'}/${model || '-'}`;

/** Sessions that ended in a clean report, waiting for the next node in their repo and lane. Each is taken by one
 *  launch at a time (take removes it), so two workers never continue the same session. */
export class WarmPool {
  constructor({ maxNodes = DEFAULT_WARM_MAX_NODES, maxAge = DEFAULT_WARM_MAX_AGE } = {}) {
    this.maxNodes = maxNodes;
    this.maxAge = maxAge;
    this.items = []; // {session, repo, lane, nodes, born, lastKey}
  }

  /** Put a session back after a clean report. `born` stays the first launch's time, so the age cap is the session's. */
  add(entry) {
    if (!entry?.session || !entry.repo) return false;
    this.items = this.items.filter((e) => e.session !== entry.session);
    this.items.push({ ...entry });
    return true;
  }

  /** Drop sessions past a cap; returns [entry, why] for each dropped one. */
  prune(now = Date.now() / 1000) {
    const out = [];
    this.items = this.items.filter((e) => {
      const [ok, why] = sessionUsable(e, this.maxNodes, this.maxAge, now);
      if (!ok) out.push([e, why]);
      return ok;
    });
    return out;
  }

  /** warmKey(repo, lane) -> idle usable sessions, for affinityOrder. */
  counts(now = Date.now() / 1000) {
    const m = new Map();
    for (const e of this.items) {
      if (!sessionUsable(e, this.maxNodes, this.maxAge, now)[0]) continue;
      const k = warmKey(e.repo, e.lane);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  /** Remove and return the newest usable session for (repo, lane), or null. */
  take(repo, lane, now = Date.now() / 1000) {
    let best = -1;
    for (let i = 0; i < this.items.length; i++) {
      const e = this.items[i];
      if (e.repo !== repo || e.lane !== lane || !sessionUsable(e, this.maxNodes, this.maxAge, now)[0]) continue;
      if (best < 0 || e.born > this.items[best].born) best = i;
    }
    if (best < 0) return null;
    return this.items.splice(best, 1)[0];
  }

  get size() {
    return this.items.length;
  }
}

/** True for an observation a worker left as a handoff. */
export function isHandoff(o) {
  if (!o || typeof o !== 'object' || typeof o.body !== 'string' || !o.body.trim()) return false;
  return o.source === HANDOFF_SOURCE || o.data?.handoff === true;
}

const stamp = (n) => String(n.completed_at || n.updated_at || n.created_at || '');

/** The newest handoff notes from finished nodes in `node`'s repo: [{key, body}], at most `limit`. `cache` maps
 *  node id + its timestamp to that node's note (or null), so a finished node's observations are read once. A read
 *  that fails is skipped: a handoff is a hint, never a reason not to launch. */
export async function collectHandoffs(api, graph, nodes, node, { cache = new Map(), limit = HANDOFF_LIMIT, scan = HANDOFF_SCAN } = {}) {
  const repo = repoOf(node);
  if (!repo || typeof api?.observations !== 'function') return [];
  const done = nodes
    .filter((n) => n && n.id !== node.id && n.status === 'done' && repoOf(n) === repo && !n.data?.dispatcher_lease)
    .sort((a, b) => stamp(b).localeCompare(stamp(a)))
    .slice(0, scan);
  const out = [];
  for (const n of done) {
    if (out.length >= limit) break;
    const ck = `${n.id}@${stamp(n)}`;
    let note = cache.get(ck);
    if (note === undefined) {
      try {
        const obs = await api.observations(graph, n.id); // newest first
        const h = (Array.isArray(obs) ? obs : []).find(isHandoff);
        note = h ? { key: n.key, body: clipNote(h.body) } : null;
      } catch {
        continue; // not cached: try again next launch
      }
      cache.set(ck, note);
    }
    if (note) out.push(note);
  }
  return out;
}

function clipNote(s) {
  const t = String(s).trim();
  return t.length <= HANDOFF_NOTE_CHARS ? t : t.slice(0, HANDOFF_NOTE_CHARS) + ' …[clipped]';
}

/** What the worker is asked to leave before a succeeded report, for a node that names a repo. */
export function handoffAsk(node) {
  const repo = repoOf(node);
  if (!repo) return '';
  return (
    `HANDOFF: before you report succeeded, leave one note for the next worker in ${repo}: graph_remember ` +
    `{graph, node_id: "${node.id}", kind: "summary", source: "${HANDOFF_SOURCE}", data: {handoff: true, repo: "${repo}"}, body} ` +
    'where body is at most 10 short lines about the REPO, not this node: how it is laid out, the build/test/check ' +
    'commands that worked (and ones that did not), conventions and traps. No secrets, tokens, keys or URLs with ' +
    'credentials. Skip it only if you learned nothing a next worker could use.'
  );
}

/** The ask for this launch: none once the repo already has a prompt's worth of notes. A note costs the worker a turn
 *  (on the cassoulet calibration, +1.1 turns and +12% cost per worker when every worker wrote one), so the notes stay
 *  fresh without every worker writing one. */
export function handoffAskFor(node, handoffs = []) {
  return handoffs.length >= HANDOFF_LIMIT ? '' : handoffAsk(node);
}
