// Runner check records for a run from ANY harness. The Claude report hook (src/graph/hooks/attach.mjs) attaches
// `{kind:'check', source:'runner'}` records to graph_report; gemini, codex and grok run no such hook, so their
// reports carried none and every check row came back no_runner_record (conformance 864314b4). After a worker
// reports succeeded, the dispatcher runs the node's check rows itself in the worker's checkout and completes the
// run with the records. Best effort: a refused completion is logged, never fatal.
import { runEvidence } from '../evidence-run.mjs';
import { isCheckRow } from '../repo-checks.mjs';

/** The check rows of a node's acceptance list. */
export const checkRows = (node) => ((node && node.data && node.data.acceptance) || []).filter((l) => typeof l !== 'string' && isCheckRow(l));

/** Should the dispatcher look for records to attach for this finished worker? Claude's own hook already did. */
export const needsRunnerRecords = (harness, node) => harness !== 'claude' && checkRows(node).length > 0;

/** The node's latest run from the API (the stream parser misses graph_report for gemini and grok). Null when none. */
export async function latestRun(api, graph, node) {
  const runs = typeof api.runs === 'function' ? await api.runs(graph, node.id ?? node.node_id) : [];
  const stamp = (r) => String(r.started_at ?? r.created_at ?? '');
  const last = [...runs].sort((a, b) => stamp(a).localeCompare(stamp(b))).pop();
  return last ? { runId: last.run_id ?? last.id, status: last.status } : null;
}

/** Run each check row in cwd; returns the records tagged with their 1-based acceptance line. */
export function runnerRecords(node, cwd, graph, deps = {}) {
  const lines = (node.data && node.data.acceptance) || [];
  const out = [];
  lines.forEach((l, i) => {
    if (typeof l === 'string' || !isCheckRow(l)) return;
    const r = runEvidence(node, { cwd, graph, only: i, run: deps.run, retryDelayMs: deps.retryDelayMs, timeoutMs: deps.timeoutMs });
    for (const { line_index, ...rec } of r.items) out.push({ ...rec, line: line_index + 1 });
  });
  return out;
}

/** Run the rows and POST them to the run's evidence route (the run is already complete). Returns the number posted. */
export async function attachRunnerRecords({ api, graph, node, runId, cwd, say = (_m) => {}, deps = {} }) {
  const records = runnerRecords(node, cwd, graph, deps);
  if (!records.length) return 0;
  try {
    await api.addEvidence(graph, node.id ?? node.node_id, runId, { evidence: records });
    say(`runner records for ${node.key}: ${records.length} posted on run ${runId}`);
  } catch (e) {
    say(`runner records for ${node.key} not accepted: ${e.message}`);
    return 0;
  }
  return records.length;
}
