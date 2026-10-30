// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// PostToolUse: extend the lease when a third of it is spent. Returns a hook answer or null.
import { notice, warningNotices } from '../../errors.mjs';
import { actorKey } from '../state.mjs';
import { loadRun, saveRun, clearRun } from '../run.mjs';
import { httpStatus, httpResult } from '../http.mjs';
import { findConfig, isGraphTool, actorTranscript, transcriptUsage, typedUsage } from './common.mjs';

const DEFAULT_LEASE = 300;
const minGap = () => {
  const v = parseFloat(process.env.GRAPH_HEARTBEAT_MIN_GAP ?? '20');
  return Number.isFinite(v) ? v : 20;
};
const ts = (s) => {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? t / 1000 : null;
};

export function leaseSeconds(run) {
  const a = ts(run.claimed_at),
    b = ts(run.lease_expires_at);
  return a && b && b > a ? b - a : DEFAULT_LEASE;
}
export function due(run, now, longCall = false) {
  // The first tool call after a claim beats at once: a run shorter than a third of its lease (the 44 s conformance worker
  // on 2026-10-30) otherwise ended with no heartbeat at all, and conformance read heartbeat FAIL.
  if (!run.last_hb && !run.heartbeats) return true;
  const last = run.last_hb || ts(run.claimed_at) || 0;
  if (now - last < minGap()) return false;
  return longCall || now - last >= leaseSeconds(run) / 3;
}
const callSeconds = (inp) => {
  const r = inp.tool_response;
  let d = r && typeof r === 'object' && !Array.isArray(r) ? r.duration_ms : undefined;
  if (d === undefined || d === null) d = inp.duration_ms;
  return typeof d === 'number' ? d / 1000 : 0;
};

let lastCall = null;
export async function beat(inp, run, sid, now = Date.now() / 1000, post = httpResult) {
  const cfg = findConfig(inp.cwd);
  if (!cfg) return null;
  const usage = typedUsage(transcriptUsage(actorTranscript(inp), run.claimed_at));
  // api-used: sends usage; reads data.state,data.lease_expires_at,data.started_at,warnings; headers X-Graph-Client
  const [status, r, errBody] = await post(cfg, 'POST', `/graphs/${run.graph_id}/nodes/${run.node_id}/runs/${run.run_id}/heartbeat`, usage ? { usage } : {}, {
    runId: run.run_id,
  });
  run.last_hb = now;
  lastCall = { status, errBody, warnings: r && r.warnings };
  if (status === 404 || status === 409) {
    run.reclaimed = true;
    saveRun(sid, run);
    return 'reclaimed';
  }
  const d = (r && r.data) || {};
  if (status >= 200 && status < 300 && (!d.state || d.state === 'ok')) {
    run.heartbeats = (Number.isInteger(run.heartbeats) ? run.heartbeats : 0) + 1;
    run.last_heartbeat_at = new Date(now * 1000).toISOString();
  }
  if (d.lease_expires_at) {
    run.lease_expires_at = d.lease_expires_at;
    run.claimed_at = run.claimed_at || d.started_at;
  }
  saveRun(sid, run);
  return d.state;
}

export async function heartbeat(inp, post) {
  try {
    const sid = actorKey(inp);
    if (isGraphTool(inp.tool_name)) return null;
    const run = loadRun(sid);
    if (!run) return null;
    // the ticker (hooks/ticker.mjs) saw a non-ok heartbeat while a tool ran: say it now
    let state,
      pending = false;
    if (run.pending_state) {
      state = run.pending_state;
      delete run.pending_state;
      pending = true;
      saveRun(sid, run);
    } else if (run.reclaimed) return null;
    const now = Date.now() / 1000;
    const longCall = inp.tool_name === 'Bash' && callSeconds(inp) > leaseSeconds(run) / 2;
    if (!pending && !due(run, now, longCall)) return null;
    lastCall = null;
    if (!pending) state = await beat(inp, run, sid, now, post);
    const said = [],
      ctxs = [];
    if (lastCall) {
      const n = lastCall.status >= 400 ? notice(sid, { status: lastCall.status, body: lastCall.errBody || {} }, { run: true }) : null;
      if (n) {
        said.push(n.systemMessage);
        ctxs.push(n.additionalContext);
      }
      for (const w of warningNotices(sid, lastCall.warnings)) {
        said.push(w);
        ctxs.push(w);
      }
    }
    if (!state || state === 'ok')
      return said.length ? { systemMessage: said.join('\n'), hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctxs.join('\n') } } : null;
    const key = run.key || run.node_id;
    const msg =
      {
        cancel_requested: `enforcer-graph: cancellation was requested for node ${key}. Stop the work, graph_remember what is worth keeping, then graph_report it as cancelled.`,
        reclaimed: `enforcer-graph: the lease on node ${key} lapsed and another harness now owns it. Stop; a report from this run will be refused. graph_remember any progress worth keeping, then graph_next_work.`,
        finished: `enforcer-graph: the run on node ${key} has already ended. Nothing further to report; graph_next_work for the next node.`,
      }[state] || `enforcer-graph: heartbeat state ${state} on node ${key}; treat as reclaimed and stop.`;
    if ((state === 'reclaimed' || state === 'finished') && !run.reclaimed) clearRun(sid);
    return { systemMessage: msg, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } };
  } catch {
    return null;
  }
}
