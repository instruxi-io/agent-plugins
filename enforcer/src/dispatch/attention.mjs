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
      item: String(r.id ?? ref),
      why: one(r.reason || r.title || r.kind || r.state || 'a verdict needs a person'),
    });
  }
  for (const n of nodes) {
    if (n.type !== 'gate' || n.status !== 'active') continue;
    const deps = n.depends_on || n.prerequisites || n.requires;
    const decidable = Array.isArray(deps) ? deps.every((d) => (byId.get(d?.id ?? d?.key ?? d) || {}).status === 'done') : readyIds.has(n.id);
    if (decidable)
      out.push({
        kind: 'gate',
        id: `gate:${n.key ?? n.id}${(n.epoch ?? n.data?.epoch) != null ? `:${n.epoch ?? n.data.epoch}` : ''}`,
        ref: String(n.key ?? n.id),
        why: one(n.data?.decision || n.title || 'a gate is ready to decide'),
        options: Array.isArray(n.data?.options) && n.data.options.length ? n.data.options.map(String) : null,
      });
  }
  return out;
}

/** The items in `current` whose id is not in `seen` (an array or Set of ids). */
export function newItems(seen, current) {
  const s = new Set(seen || []);
  return current.filter((i) => !s.has(i.id));
}

/**
 * The command a person runs to answer an item, ready to paste after `!` in Claude Code. A gate's decision must be
 * one of its `data.options` when it declares them (the server refuses anything else); otherwise it is free text and
 * approve|reject are offered. A review item takes approve|reject|override (override needs a note).
 */
export function answerCommand(item, graph = '<graph>') {
  if (item.kind === 'gate') return `graphwatch decide ${graph} ${item.ref} ${(item.options || ['approve', 'reject']).join('|')} --note "<why>"`;
  return `graphwatch resolve ${graph} ${item.item ?? item.ref} approve|reject|override --note "<why>"`;
}

/** The one line for an item: what needs a person, and the exact command that answers it. */
export function attentionLine(item, graph = '<graph>') {
  return `ATTENTION ${item.kind} ${item.ref}: ${item.why} (answer: ! ${answerCommand(item, graph)}; or all at once: ! graphwatch attend ${graph})`;
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

/**
 * notify-send with a short title when the binary exists; never throws, never fails the dispatcher.
 * ENFORCER_DISPATCH_NOTIFY=0 turns it off: the log line stays, the desktop stays quiet. The test preload sets it, so a
 * suite that drives --attend or the 404 exit never reaches the developer's desktop.
 */
export function notify(title, body = '') {
  if (process.env.ENFORCER_DISPATCH_NOTIFY === '0') return;
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
