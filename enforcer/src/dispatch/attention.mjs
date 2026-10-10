// Attended dispatch: which moments need a person, which of them are new, and the one line that announces each.
// Pure functions (no I/O) except the two small seen-set helpers; the dispatcher wires them in (run.mjs, --attend).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ATTEND_POLL_SECONDS = 15;
export const ATTEND_NOTE_SECONDS = 600;

const one = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/**
 * Everything that needs a person right now: open review items, plus gate nodes that are active with every
 * prerequisite done. `readyIds` (the frontier's ids) also marks a gate decidable when the node carries no
 * prerequisite list.
 */
export function needsYou(nodes, reviewItems = [], readyIds = new Set()) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = [];
  for (const r of reviewItems || []) {
    const ref = r.node_key || r.key || byId.get(r.node_id)?.key || r.node_id || r.id;
    out.push({
      kind: 'review',
      id: `review:${r.id ?? ref}`,
      ref: String(ref),
      why: one(r.reason || r.title || r.kind || r.state || 'a verdict needs a person'),
    });
  }
  for (const n of nodes) {
    if (n.type !== 'gate' || n.status !== 'active') continue;
    const deps = n.depends_on || n.prerequisites || n.requires;
    const decidable = Array.isArray(deps) ? deps.every((d) => (byId.get(d?.id ?? d?.key ?? d) || {}).status === 'done') : readyIds.has(n.id);
    if (decidable)
      out.push({ kind: 'gate', id: `gate:${n.key ?? n.id}`, ref: String(n.key ?? n.id), why: one(n.data?.decision || n.title || 'a gate is ready to decide') });
  }
  return out;
}

/** The items in `current` whose id is not in `seen` (an array or Set of ids). */
export function newItems(seen, current) {
  const s = new Set(seen || []);
  return current.filter((i) => !s.has(i.id));
}

/** The one line for an item. */
export function attentionLine(item, graph = '<graph>') {
  return `ATTENTION ${item.kind} ${item.ref}: ${item.why} (answer with: graphwatch attend ${graph}, or graph_review / graph_decide)`;
}

const seenPath = (stateDir) => join(stateDir, 'attention-seen.json');

export function loadSeen(stateDir) {
  try {
    const v = JSON.parse(readFileSync(seenPath(stateDir), 'utf8'));
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

export function saveSeen(stateDir, seen) {
  mkdirSync(dirname(seenPath(stateDir)), { recursive: true, mode: 0o700 });
  writeFileSync(seenPath(stateDir), JSON.stringify([...seen]));
}

/** notify-send with a short title when the binary exists; never throws, never fails the dispatcher. */
export function notify(title, body = '') {
  try {
    spawnSync('notify-send', [title, body], { stdio: 'ignore', timeout: 5000 });
  } catch {
    /* no binary or no desktop: the log line is the notification */
  }
}

/** Needs-you count in the log: the last `ATTENTION` ids minus nothing; used by status when it has only nodes. */
export function seenCount(stateDir) {
  return existsSync(seenPath(stateDir)) ? loadSeen(stateDir).size : 0;
}
