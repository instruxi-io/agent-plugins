// PreToolUse on graph_next_work / graph_heartbeat / graph_report / graph_remember.
// Stamps `client`, attaches captured evidence and usage, gates succeeded reports on the card's evidence hints.
// A hook cannot edit the model's arguments; it returns the whole argument object through updatedInput.
// Fails open: nothing captured, no data dir, garbage input -> no output.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { actorKey, stateBase } from '../state.mjs';
import { loadRun } from '../run.mjs';
import { loadEvidence, stripInternal, stripRunner, selectEvidence, mergeEvidence, isFinal, EVIDENCE_CAP } from '../evidence.mjs';
import { redact } from '../redact.mjs';
import { OUTPUT_CLIP } from '../clip.mjs';
import { apiFetch } from '../../../lib/api/client.mjs';
import { authHeaders } from '../../credentials.mjs';
import { runEvidence } from '../../evidence-run.mjs';
import { isCheckRow, rowLabel } from '../../repo-checks.mjs';
// Which lines run is decided by the one shared allow list (src/acceptance-allowlist.mjs), through runEvidence.
export { ACCEPTANCE_SHAPES } from '../../acceptance-allowlist.mjs';
import { findConfig, isGraphTool, isObj, actorTranscript, transcriptUsage, typedUsage } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const pluginVersion = () => {
  try {
    return String(JSON.parse(readFileSync(join(here, '../../../plugin.json'), 'utf8')).version || 'unknown');
  } catch {
    return 'unknown';
  }
};
export const CLIENT_BASE = () => `enforcer-graph-plugin/${pluginVersion()}`;
const CLIENT_TOOLS = ['graph_next_work', 'graph_heartbeat', 'graph_report'];
const REMEMBER_RECENT = 3;
const UPLOAD_BUDGET_MS = 10_000;
const PR_URL = /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const mode = () => (process.env.GRAPH_EVIDENCE_MODE || 'input').trim().toLowerCase();

export const GATE_NOTE = 'this is a gate: decide it with graph_decide, do not report it';
const NOTE = (n) => `enforcer-graph: ${n} evidence item(s) captured from your own tool results were attached to this report. Do not hand-write evidence.`;
const HANDOFF = (js) =>
  "enforcer-graph: this harness cannot rewrite an MCP tool's arguments, so pass the following captured evidence as the `evidence` argument of graph_report VERBATIM - do not edit, summarise, reorder or add to it. It was captured from your own tool results while the run was open.\n\n" +
  js;

export const stampsClient = (tool) => isGraphTool(tool) && CLIENT_TOOLS.some((t) => String(tool).endsWith(t));

/** Client attestation: hooks=on only once a capture or the self-check left a marker for this actor/session. */
export function clientFor(inp) {
  inp = inp || {};
  const keys = [actorKey(inp), inp.session_id].filter(Boolean);
  const ok = keys.some((k) => existsSync(join(stateBase(), 'attest', String(k))));
  return ok ? `${CLIENT_BASE()}; hooks=on` : `${CLIENT_BASE()}; hooks=off:no-capture-yet`;
}
export const withClient = (args, inp) => ({ ...(isObj(args) ? args : {}), client: clientFor(inp) });

/** Resolve a claimed PR with gh; an unresolvable PR is a finding, any other failure returns null. */
export function checkPr(url, run = defaultGh) {
  const m = PR_URL.exec(url || '');
  if (!m) return null;
  const [, owner, repo, num] = m;
  const r = run(['pr', 'view', num, '-R', `${owner}/${repo}`, '--json', 'state,title,mergedAt,url']);
  if (!r) return null;
  if (r.status !== 0) {
    const err = String(r.stderr || '')
      .trim()
      .split('\n')
      .filter(Boolean);
    if (!err.length) return null;
    return { kind: 'artifact', url, label: 'pull request NOT FOUND', output: `gh pr view ${num} -R ${owner}/${repo} -> ${err[err.length - 1].slice(0, 200)}` };
  }
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  return {
    kind: 'artifact',
    url: d.url || url,
    label: `pull request ${String(d.state || '?').toLowerCase()}: ${String(d.title || '').slice(0, 120)}`,
    output: `gh pr view ${num} -R ${owner}/${repo} -> state=${d.state} merged=${d.mergedAt || 'no'}`,
  };
}
function defaultGh(args) {
  try {
    const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 10_000 });
    return r.error ? null : r;
  } catch {
    return null;
  }
}

export function withUsage(args, usage, legacy = true) {
  args = isObj(args) ? { ...args } : {};
  if (legacy) args.data = { ...(isObj(args.data) ? args.data : {}), usage };
  const typed = typedUsage(usage);
  if (typed && !isObj(args.usage)) args.usage = typed;
  return args;
}

export function overrideEntries(ov) {
  const out = [];
  for (const e of Array.isArray(ov) ? ov : [ov]) {
    if (!isObj(e) || !Number.isInteger(e.line)) return null;
    out.push({ line: e.line, reason: String(e.reason || '') });
  }
  return out.length ? out : null;
}

export function evidenceGaps(hints, evidence) {
  const recs = (evidence || []).filter(isObj);
  const cmds = recs.filter((e) => e.kind === 'command');
  const text = (e) =>
    ['cmd', 'output', 'url', 'label', 'excerpt', 'path']
      .map((k) => String(e[k] || ''))
      .join(' ')
      .toLowerCase();
  const hasPr = recs.some((e) => {
    const t = text(e);
    return (t.includes('land-pr') && t.includes('merge')) || t.includes('pull request merged') || (t.includes('merged=') && !t.includes('merged=no'));
  });
  const hasFile = recs.some((e) => e.kind === 'file' || /^(cat |sed -n|head |tail )/.test(String(e.cmd || '').trimStart()));
  const gaps = [];
  (hints || []).forEach((h, i) => {
    if (!isObj(h)) return;
    const n = i + 1,
      crit = String(h.criterion || '').slice(0, 80);
    if (h.kind === 'pr' && !hasPr) gaps.push([n, crit, "wants land-pr.sh's merged output; attach the command that ran land-pr.sh"]);
    else if (h.kind === 'file' && !hasFile) gaps.push([n, crit, 'wants the file body; attach `cat <file>` (or a Read/Edit of it), not a listing or diff stat']);
    else if ((h.kind === 'check' || h.kind === 'prose') && !cmds.length)
      gaps.push([n, crit, 'wants a command whose verbatim output shows it; run the deciding command and attach it']);
  });
  return gaps;
}

// The whole acceptance pass must fit inside hooks.json's PreToolUse timeout (30 s) with room for the
// PR check and uploads after it: Claude Code kills a hook that overruns and the report then goes out
// WITHOUT the evidence this hook was about to attach (2026-10-07: three zero-evidence reports, each
// judged no_evidence, while `cd enforcer && npm test` ran for minutes inside the hook).
const ACCEPT_LINE_MS = 8_000;
const ACCEPT_BUDGET_MS = 15_000;
const ACCEPT_HEADROOM_MS = 1_000;
const ACCEPT_MIN_MS = 500;
// Cheap read-only commands run first so a slow suite never starves the one-second `ls` the judge asks for.
const FAST = /^\s*(ls|cat|grep|wc|head|tail|test|stat|git\s+(log|status|rev-parse|tag|diff)|gh\s+(pr|run)\s+(view|list|checks))\b/;
const NOTE_REASONS = /not an allowed command shape/;

/** Run the claimed node's acceptance lines in the worktree within a time budget: command records (each tagged
 *  `line`, the 1-based acceptance line, so it is the line's final record), a note per refused write, and a note per
 *  line the budget did not reach. A line that already has a final record under this run (the worker ran
 *  `enforcer evidence run` before reporting; `deps.have`, 0-based) is neither run again nor noted: that run had
 *  minutes, this hook has seconds, and the note "did not finish within the report hook" on a line the worker had
 *  already proved cost three good runs their verdict on 2026-10-13. Never throws. */
export function acceptanceRecords(inp, run, deps = {}) {
  try {
    const lines = Array.isArray(run && run.acceptance) ? run.acceptance.filter((l) => typeof l === 'string' || isCheckRow(l)) : [];
    if (!lines.length || !inp.cwd || !existsSync(inp.cwd)) return [];
    const have = deps.have instanceof Set ? deps.have : new Set();
    let cwd = inp.cwd;
    try {
      const g = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5000 });
      if (g.status === 0 && g.stdout.trim()) cwd = g.stdout.trim();
    } catch {}
    const lineMs = deps.acceptanceTimeoutMs ?? ACCEPT_LINE_MS;
    let deadline = Date.now() + (deps.acceptanceBudgetMs ?? ACCEPT_BUDGET_MS);
    if (Number.isFinite(deps.deadline)) deadline = Math.min(deadline, deps.deadline - ACCEPT_HEADROOM_MS); // the hook's shared deadline
    const fast = (l) => typeof l === 'string' && FAST.test(l);
    const order = lines.map((l, i) => i).sort((a, b) => (fast(lines[b]) ? 1 : 0) - (fast(lines[a]) ? 1 : 0));
    const node = { key: run.key, node_id: run.node_id, data: { acceptance: lines } };
    const items = [],
      notes = [];
    for (const i of order) {
      if (have.has(i)) continue;
      const left = deadline - Date.now();
      if (left < ACCEPT_MIN_MS) {
        notes.push({ kind: 'note', text: `acceptance line ${i + 1} was not run (time budget of the report hook): ${rowLabel(lines[i]).slice(0, 200)}` });
        continue;
      }
      const r = runEvidence(node, {
        cwd,
        graph: run.graph_id || '',
        only: i,
        timeoutMs: Math.min(lineMs, left),
        retryDelayMs: 0,
        run: deps.acceptanceRun,
      });
      for (const { line_index, ...rec } of r.items) {
        // A line the budget cut short is NOT a failed command: the judge reads exit 124 with no summary as a failure, while the
        // worker's own run of the same command is already among the captured records. Say what happened instead.
        if (rec.exit === 124)
          notes.push({
            kind: 'note',
            text: `acceptance line ${line_index + 1} did not finish within the report hook's ${Math.round(Math.min(lineMs, left) / 1000)} s; judge it from the worker's own captured run: ${rowLabel(lines[line_index]).slice(0, 200)}`,
          });
        else items.push({ ...rec, line: line_index + 1 });
      }
      for (const s of r.skipped)
        if (NOTE_REASONS.test(s.reason) || isCheckRow(lines[s.line_index]))
          notes.push({ kind: 'note', text: `acceptance line ${s.line_index + 1} was not run (${s.reason}): ${rowLabel(lines[s.line_index]).slice(0, 200)}` });
    }
    return [...items, ...notes];
  } catch {
    return [];
  }
}

const deny = (why) => ({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'enforcer-graph: ' + why });

export function evidenceBlock(inp, evidence) {
  const ti = inp.tool_input || {};
  if (ti.status !== 'succeeded') return null;
  const gaps = evidenceGaps((loadRun(actorKey(inp)) || {}).acceptance_evidence, evidence);
  if (!gaps.length) return null;
  const ov = ti.evidence_override;
  if (ov) {
    const entries = overrideEntries(ov);
    const unmet = gaps.map((g) => g[0]).sort((a, b) => a - b);
    if (!entries)
      return deny(
        `evidence_override must be {line: <acceptance line index>, reason: ...} (or a list of them); a bare true or a missing line is refused. Unmet lines: [${unmet.join(', ')}]`,
      );
    if (entries.some((e) => !e.reason.trim())) return deny('evidence_override needs a reason for every line.');
    const have = new Set(entries.map((e) => e.line));
    const missing = unmet.filter((n) => !have.has(n));
    if (missing.length) return deny(`evidence_override does not cover unmet lines [${missing.join(', ')}].`);
    return null;
  }
  const msg = gaps.map(([n, c, fix]) => `criterion ${n} (${c}) ${fix}`).join('; ');
  return deny(
    "report blocked, the evidence misses what the card's hints ask for: " +
      msg +
      '. Run it, then report again; or pass evidence_override: {line: <index>, reason: ...}.',
  );
}

// ---- enforcer-files upload of output longer than the clip ----
export const filesBaseUrl = (cfg) =>
  String(process.env.GRAPH_FILES_BASE_URL || (cfg || {}).files_base_url || '')
    .trim()
    .replace(/\/+$/, '');
const providerCache = new Map();

async function authFor(cfg) {
  if (cfg && cfg.api_key) return { 'X-API-Key': cfg.api_key };
  return authHeaders();
}
const freq = (url, init, auth, ms) =>
  apiFetch(url, { ...init, headers: { ...auth, Accept: 'application/json', ...(init.headers || {}) } }, { timeoutMs: ms, retries: 0 });

export async function uploadFullOutput(text, cfg, timeoutMs = UPLOAD_BUDGET_MS) {
  try {
    const base = filesBaseUrl(cfg);
    if (!base || timeoutMs <= 0) return null;
    const auth = await authFor(cfg);
    if (!Object.keys(auth).length) return null;
    let prov = providerCache.get(base);
    if (!prov) {
      const r = await freq(base + '/storage/provider', {}, auth, timeoutMs);
      const d = r.ok ? await r.json() : null;
      prov = d && d.configured ? d.provider : null;
      if (typeof prov !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(prov)) return null;
      providerCache.set(base, prov);
    }
    const name = `graph-evidence/${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}-${randomUUID().replace(/-/g, '').slice(0, 12)}.log`;
    const form = new FormData();
    form.append('file', new Blob([redact(text)[0]], { type: 'text/plain; charset=utf-8' }), name.split('/').pop());
    form.append('file_name', name);
    const r = await freq(`${base}/storage/file/${prov}/upload`, { method: 'POST', body: form }, auth, timeoutMs);
    const d = r.ok ? await r.json() : null;
    const fid = d && d.data && d.data.file_id;
    if (typeof fid === 'string' && UUID_RE.test(fid.trim())) return fid.trim().toLowerCase();
  } catch {}
  return null;
}

/** Upload each item's `raw`; `raw` is always removed so it never reaches the report. */
export async function attachFiles(items, cfg, upload = uploadFullOutput) {
  const deadline = Date.now() + UPLOAD_BUDGET_MS;
  const enabled = !!filesBaseUrl(cfg) && cfg != null;
  for (const it of items) {
    if (!isObj(it) || !('raw' in it)) continue;
    const raw = it.raw;
    delete it.raw;
    if (!enabled || typeof raw !== 'string' || raw.length <= OUTPUT_CLIP) continue;
    const fid = await upload(raw, cfg, deadline - Date.now());
    if (fid) {
      it.file = fid;
      it.file_bytes = Buffer.byteLength(raw);
    }
  }
  return items;
}

export async function decide(inp, deps = {}) {
  const tool = inp.tool_name || '';
  const isReport = tool.endsWith('graph_report'),
    isRemember = tool.endsWith('graph_remember'),
    isHeartbeat = tool.endsWith('graph_heartbeat');
  if (!(isReport || isRemember || isHeartbeat)) return null;
  const sid = actorKey(inp);
  const run = loadRun(sid) || {};
  const records = loadEvidence(sid, run.run_id);
  let usage = null;
  if (isHeartbeat) {
    usage = transcriptUsage(actorTranscript(inp), run.claimed_at);
    return usage && mode() !== 'context' ? { hookEventName: 'PreToolUse', updatedInput: withUsage(inp.tool_input, usage, false) } : null;
  }
  if (isReport) usage = transcriptUsage(actorTranscript(inp), run.claimed_at);
  // A gate is decided by a person through graph_decide, not judged: run no acceptance line, attach one note, pass the report through.
  if (isReport && run.type === 'gate') {
    const a = usage ? withUsage(inp.tool_input, usage) : inp.tool_input;
    return {
      hookEventName: 'PreToolUse',
      updatedInput: { ...(isObj(a) ? a : {}), evidence: [{ kind: 'note', text: GATE_NOTE }] },
      additionalContext: 'enforcer-graph: ' + GATE_NOTE,
    };
  }
  const have = new Set(records.filter(isFinal).map((r) => r.line - 1));
  const acc = isReport && (inp.tool_input || {}).status === 'succeeded' ? acceptanceRecords(inp, run, { ...deps, have }) : [];
  if (!records.length && !acc.length)
    return usage && mode() !== 'context' ? { hookEventName: 'PreToolUse', updatedInput: withUsage(inp.tool_input, usage) } : null;
  let evidence = isRemember
    ? selectEvidence(records.slice(-REMEMBER_RECENT).map(stripInternal), REMEMBER_RECENT)
    : selectEvidence([...acc, ...records.map(stripInternal).map(stripRunner).filter(Boolean)]);
  // A claimed PR is the one externally checkable claim: resolve it with gh, never trust the URL.
  const pr = isReport ? (inp.tool_input || {}).pr : null;
  const checked = typeof pr === 'string' && pr.trim() ? checkPr(pr, deps.gh) : null;
  if (checked) {
    evidence = evidence.filter((e) => !(e.kind === 'artifact' && e.url === checked.url && !String(e.label).includes('NOT FOUND')));
    evidence = [...evidence, checked];
  }
  if (isReport) evidence = mergeEvidence(evidence, (inp.tool_input || {}).evidence, EVIDENCE_CAP);
  // Decide BEFORE any upload: a denied report must leave no files behind.
  if (isReport) {
    const blocked = evidenceBlock(inp, evidence);
    if (blocked) return blocked;
    const ov = (inp.tool_input || {}).evidence_override;
    const entries = ov ? overrideEntries(ov) : null;
    if (entries) {
      const ti = { ...inp.tool_input };
      delete ti.evidence_override;
      ti.data = { ...(isObj(ti.data) ? ti.data : {}), overrides: entries };
      inp = { ...inp, tool_input: ti };
    }
  }
  let cfg = null;
  try {
    cfg = findConfig(inp.cwd);
  } catch {}
  try {
    evidence = await attachFiles(evidence, cfg, deps.upload);
  } catch {
    for (const it of evidence) if (isObj(it)) delete it.raw;
  }
  const out = { hookEventName: 'PreToolUse' };
  if (mode() === 'context') out.additionalContext = HANDOFF(JSON.stringify(evidence));
  else {
    const a = usage ? withUsage(inp.tool_input, usage) : inp.tool_input;
    out.updatedInput = { ...(isObj(a) ? a : {}), evidence };
    out.additionalContext = NOTE(evidence.length);
  }
  return out;
}

export function reclaimedNotice(inp) {
  const run = loadRun(actorKey(inp));
  return run && run.reclaimed
    ? `enforcer-graph: the lease on node ${run.key || run.node_id} was reclaimed (the heartbeat got 404/409). Stop; a report from this run will be refused. graph_remember any progress worth keeping, then graph_next_work.`
    : null;
}

// Postgres jsonb cannot hold U+0000, so one NUL byte anywhere in a report (often from captured
// command output) makes the server refuse the whole report with 500 and the evidence is lost
// (2026-10-07: four refused reports on a merged node). Strip it from every string we send.
const NUL = /\u0000/g;
export function stripNul(v) {
  if (typeof v === 'string') return v.includes('\u0000') ? v.replace(NUL, '') : v;
  if (Array.isArray(v)) return v.map(stripNul);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = stripNul(x);
    return o;
  }
  return v;
}

/** The PreToolUse answer ({hookSpecificOutput, systemMessage?}) or null. Never throws. */
export async function attachEvidence(inp, deps) {
  try {
    if (!isObj(inp)) return null;
    const tool = inp.tool_name || '';
    let out = null;
    try {
      out = await decide(inp, deps);
    } catch {}
    if (stampsClient(tool) && mode() !== 'context') {
      out = out || { hookEventName: 'PreToolUse' };
      out.updatedInput = withClient(out.updatedInput ?? inp.tool_input, inp);
    }
    const notice = isGraphTool(tool) ? reclaimedNotice(inp) : null;
    if (notice) {
      out = out || { hookEventName: 'PreToolUse' };
      out.additionalContext = ((out.additionalContext || '') + '\n' + notice).trim();
    }
    if (!out) return null;
    if (out.updatedInput !== undefined) out.updatedInput = stripNul(out.updatedInput);
    return notice ? { hookSpecificOutput: out, systemMessage: notice } : { hookSpecificOutput: out };
  } catch {
    return null;
  }
}
