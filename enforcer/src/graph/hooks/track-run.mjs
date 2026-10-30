// PostToolUse on the graph MCP tools: records the run a session holds.
import { isCheckRow } from '../../repo-checks.mjs';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { actorKey, dataDir, privateWrite } from '../state.mjs';
import { saveRun, clearRun, loadRun } from '../run.mjs';
import { clearEvidence } from '../evidence.mjs';
import { toolPayload, isObj } from './common.mjs';

const REF_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The branch the claim card names: `branch` on the card, its run or its node (the server's claim-branch). */
export function cardBranch(out) {
  const o = isObj(out) ? out : {};
  const run = isObj(o.run) ? o.run : {};
  const node = isObj(o.node) ? o.node : {};
  for (const b of [o.branch, run.branch, isObj(run.data) ? run.data.branch : undefined, node.branch, isObj(node.data) ? node.data.branch : undefined])
    if (typeof b === 'string' && b.startsWith('graph/') && b.split('/').every((p) => REF_PART.test(p) && !p.endsWith('.lock'))) return b;
  return '';
}

/** Put the worktree at `cwd` on the claim card's branch. The dispatcher creates a worktree before the claim, when the node
 *  carries no branch yet, so it falls back to graph/<key>; the card then names graph/<code>/<key>/e<epoch> and the worker
 *  pushed the fallback (2026-10-30 conformance: land FAIL, PR on graph/conf-claude). Only a `graph/` branch is renamed,
 *  never main or a person's branch, and never onto a branch that already exists. Returns a line for the worker, or ''. */
export function adoptCardBranch(cwd, branch, { git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 }) } = {}) {
  if (!branch || !cwd) return '';
  try {
    const cur = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = cur && cur.status === 0 ? String(cur.stdout || '').trim() : '';
    if (!name || name === branch) return name === branch ? `enforcer-graph: this worktree is on the claim card's branch ${branch}; push that branch.` : '';
    const say = `enforcer-graph: land this node on the claim card's branch ${branch}`;
    if (!name.startsWith('graph/')) return `${say} (this checkout is on ${name}; create ${branch} for the work).`;
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0)
      return `${say} (it already exists locally; this worktree stays on ${name}).`;
    const r = git(['branch', '-m', name, branch]);
    if (r.status !== 0)
      return `${say} (renaming ${name} failed: ${String(r.stderr || '')
        .trim()
        .slice(0, 200)}).`;
    return `${say}: the worktree's branch ${name} was renamed to it. Push ${branch} and open the pull request from it.`;
  } catch {
    return '';
  }
}

/** The acceptance lines the report hook runs, from a claim card. The node's own list (`node.data.acceptance`) comes first:
 *  the card's top-level `acceptance` holds only the judged lines and drops every `{"check": ...}` row, so a hook that read it
 *  ran no check row and attached no runner record, and every check came back no_runner_record (conformance 7d162fcc,
 *  2026-10-30). The node's list also numbers lines the way `enforcer evidence run` does, so a line the worker already ran
 *  is recognised by its index. */
export function cardAcceptance(out) {
  const o = isObj(out) ? out : {};
  const data = isObj(o.node) && isObj(o.node.data) ? o.node.data : {};
  const list = Array.isArray(data.acceptance) && data.acceptance.length ? data.acceptance : Array.isArray(o.acceptance) ? o.acceptance : [];
  return list.filter((l) => typeof l === 'string' || isCheckRow(l));
}

export async function trackRun(inp) {
  try {
    const name = inp.tool_name || '';
    const sid = actorKey(inp);
    const out = toolPayload(inp.tool_response);
    if (name.endsWith('graph_next_work')) {
      if (out.state !== 'claimed') return null;
      const node = out.node || {},
        run = out.run || {};
      if (node.node_id && run.run_id) {
        clearEvidence(sid);
        const hints = out.acceptance_evidence || out.criteria_hints || [];
        saveRun(sid, {
          graph_id: out.graph_id,
          node_id: node.node_id,
          run_id: run.run_id,
          key: node.key,
          title: node.title,
          type: typeof node.type === 'string' ? node.type : undefined,
          lease_expires_at: run.lease_expires_at,
          acceptance_evidence: (Array.isArray(hints) ? hints : []).filter(isObj),
          acceptance: cardAcceptance(out),
          branch: cardBranch(out) || undefined,
          claimed_at: new Date().toISOString(),
        });
        if (inp.session_id && sid !== inp.session_id) {
          try {
            privateWrite(join(dataDir(), `${inp.session_id}.live`), '');
          } catch {}
        }
        const said = adoptCardBranch(inp.cwd, cardBranch(out));
        if (said) return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: said } };
      }
    } else if (name.endsWith('graph_report')) {
      clearRun(sid);
      if (inp.session_id && sid !== inp.session_id) {
        try {
          rmSync(join(dataDir(), `${inp.session_id}.live`));
        } catch {}
      }
    } else if (name.endsWith('graph_heartbeat')) {
      if (out.state === 'reclaimed' || out.state === 'finished') clearRun(sid);
      else if (out.state === 'ok') countHeartbeat(sid);
    }
  } catch {}
  return null;
}

/** Count a heartbeat the server accepted on the run this session holds; the report carries the count (data.heartbeats),
 *  because the server's run row shows no heartbeat field and `enforcer conformance --status` read heartbeat FAIL. */
export function countHeartbeat(sid, now = new Date()) {
  try {
    const run = loadRun(sid);
    if (!run) return;
    run.heartbeats = (Number.isInteger(run.heartbeats) ? run.heartbeats : 0) + 1;
    run.last_heartbeat_at = now.toISOString();
    saveRun(sid, run);
  } catch {}
}
