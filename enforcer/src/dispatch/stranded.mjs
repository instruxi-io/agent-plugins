// Is a "running" node actually being worked? The graph's `running` and its elapsed timer come from the CLAIM, not
// from any heartbeat, so a node whose worker died, or whose dispatcher exited, looks identical to a live one until
// its lease lapses (graph_plan_status already returns lease_expires_at). This reads only fields the server returns,
// plus the dispatcher's own per-node worker log, and names the four ways a node looks claimed and is not:
//   stranded  running, lease in the past: nobody has heartbeated it since (the graph lists it on the frontier as
//             reclaimable; a running dispatcher re-claims it, a stopped one does not)
//   orphaned  running with a live lease while this graph's dispatcher is not running: someone else holds it, or it
//             will lapse and strand within minutes
//   quiet     running, lease live, dispatcher up, but its worker log has not grown for QUIET_MINUTES
//   gateRun   a gate with a run: gates are decided, not claimed, so this is an outside claim
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { lapsed } from './select.mjs';
import { parseTs } from './util.mjs';

export const QUIET_MINUTES = 10;

const mins = (ms) => Math.max(0, Math.round(ms / 60000));
export const ago = (ms) => {
  const m = mins(ms);
  return m >= 120 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** newest worker log for a node: logs/<key>.<attempt>.jsonl; returns its mtime in ms, or null. */
export function workerLogMtime(logsDir, key) {
  let best = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const t = statSync(join(logsDir, `${key}.${attempt}.jsonl`)).mtimeMs;
      if (best === null || t > best) best = t;
    } catch {
      /* no such attempt */
    }
  }
  return best;
}

/**
 * nodes: the graph's nodes; opts: {dispatcherRunning, logMtime(key) -> ms|null, now (ms)}.
 * @param {any[]} nodes
 * @param {{ dispatcherRunning?: boolean, logMtime?: (key: string) => number | null, now?: number }} [opts]
 */
export function strandedReport(nodes, { dispatcherRunning, logMtime = () => null, now = Date.now() } = {}) {
  const out = { stranded: [], orphaned: [], quiet: [], gateRuns: [] };
  for (const n of nodes) {
    if (n.status !== 'running' || n.data?.dispatcher_lease) continue;
    if (['gate'].includes(n.type)) out.gateRuns.push({ key: n.key });
    if (lapsed(n, now)) {
      out.stranded.push({ key: n.key, lapsedMs: now - parseTs(n.lease_expires_at) });
      continue;
    }
    if (!dispatcherRunning) {
      const until = parseTs(n.lease_expires_at);
      out.orphaned.push({ key: n.key, leftMs: until === null ? null : until - now });
      continue;
    }
    const t = logMtime(n.key);
    if (t !== null && now - t > QUIET_MINUTES * 60000) out.quiet.push({ key: n.key, quietMs: now - t });
  }
  return out;
}

/**
 * The lines `enforcer dispatch status` prints, first the headline when anything is wrong.
 * @param {ReturnType<typeof strandedReport>} rep
 * @param {string} graph
 * @param {{ dispatcherRunning?: boolean }} opts
 */
export function strandedLines(rep, graph, { dispatcherRunning }) {
  const L = [];
  const bad = rep.stranded.length || rep.gateRuns.length;
  if (rep.stranded.length) {
    L.push(
      `STRANDED (${rep.stranded.length}): marked running but not being worked${dispatcherRunning ? '' : '; the dispatcher is NOT running, so nothing will re-claim them'}`,
    );
    for (const s of rep.stranded) L.push(`  ${s.key}: lease lapsed ${ago(s.lapsedMs)} ago, no heartbeat`);
    if (!dispatcherRunning) L.push(`  restart it: enforcer dispatch ${graph}   (it re-claims lapsed nodes on its first pass)`);
  }
  if (rep.gateRuns.length) {
    L.push(`gate with a run (${rep.gateRuns.length}): gates are decided, not claimed; something outside the dispatcher claimed:`);
    for (const g of rep.gateRuns) L.push(`  ${g.key}`);
  }
  if (rep.orphaned.length) {
    L.push(`running with no dispatcher (${rep.orphaned.length}): held by another harness, or will lapse and strand:`);
    for (const o of rep.orphaned) L.push(`  ${o.key}: lease ${o.leftMs === null ? 'unknown' : `ends in ${ago(o.leftMs)}`}`);
  }
  if (rep.quiet.length) {
    L.push(`quiet workers (${rep.quiet.length}): lease is live but the worker log has not grown for ${QUIET_MINUTES}+ min:`);
    for (const q of rep.quiet) L.push(`  ${q.key}: ${ago(q.quietMs)} without output`);
  }
  return { lines: L, bad: Boolean(bad) };
}
