// PostToolUse on the graph MCP tools: records the run a session holds.
import { isCheckRow } from '../../repo-checks.mjs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { actorKey, dataDir, privateWrite } from '../state.mjs';
import { saveRun, clearRun } from '../run.mjs';
import { clearEvidence } from '../evidence.mjs';
import { toolPayload, isObj } from './common.mjs';

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
          acceptance: (Array.isArray(out.acceptance) ? out.acceptance : []).filter((l) => typeof l === 'string' || isCheckRow(l)),
          claimed_at: new Date().toISOString(),
        });
        if (inp.session_id && sid !== inp.session_id) {
          try {
            privateWrite(join(dataDir(), `${inp.session_id}.live`), '');
          } catch {}
        }
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
    }
  } catch {}
  return null;
}
