// Every hook against a local stub of the graph API. No key, no network, no Jev.
// Ported from test/run.sh: each check keeps its label. The checks share one state directory and run in order.
import { realpathSync } from 'node:fs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub } from './stub-graph.mjs';
import { checkPr } from '../../src/graph/hooks/attach.mjs';
import { isGraphTool } from '../../src/graph/hooks/common.mjs';
import { MANIFEST_DIR } from '../../src/graph/hooks/version-check.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'bin/enforcer');

// --- isolation: a private HOME/TMPDIR, no harness or sign-in environment ---------------------------------------
const WORK = mkdtempSync(join(realpathSync(tmpdir()), 'run-test-'));
const HOME = join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const stub = await startStub();
after(async () => {
  await stub.close();
  rmSync(WORK, { recursive: true, force: true });
});

const baseEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(ENFORCER_|JEV_HOOKS_|GRAPH_|CLAUDE_PLUGIN_|TYPESAFE_|ISOLATED_)/.test(k)) baseEnv[k] = v;
Object.assign(baseEnv, { HOME, USERPROFILE: HOME, TMPDIR: WORK, npm_config_cache: join(WORK, 'npm-cache') });
const DATA = join(WORK, 'data');
const PROJ = join(WORK, 'proj');
mkdirSync(join(PROJ, '.enforcer'), { recursive: true });
writeFileSync(join(PROJ, '.enforcer', 'graph.json'), JSON.stringify({ graph_id: 'g1', base_url: stub.url, api_key_env: 'GRAPH_API_KEY' }) + '\n');
const env = {
  ...baseEnv,
  CLAUDE_PLUGIN_DATA: DATA,
  GRAPH_API_KEY: 'stub-key',
  CLAUDE_CONFIG_DIR: join(WORK, 'cc'), // Claude Code's own plugin bookkeeping, for session_start's notices: never the real one
  ENFORCER_BASE_URL: stub.url,
  ENFORCER_HOME: join(WORK, 'eh'), // version check: never the real server or sign-in
};
mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
const SID = 's1';
const runfile = (sid = SID) => join(DATA, 'runs', `${sid}.json`);
const evfile = join(DATA, 'evidence', `${SID}.jsonl`);

// event handler -> `enforcer hook <event> <handler>`
const EVENT = {
  session_start: 'session-start',
  remember_on_compact: 'pre-compact',
  open_run_guard: 'stop',
  attach_evidence: 'pre-tool-use',
  track_run: 'post-tool-use',
  capture_evidence: 'post-tool-use',
  heartbeat: 'post-tool-use',
};
let rc = 0;
function hook(handler, input, extra = {}, unset = []) {
  const e = { ...env, ...extra };
  for (const k of unset) delete e[k];
  const args = [CLI, 'hook', EVENT[handler], ...(EVENT[handler] === 'post-tool-use' ? [handler] : [])];
  // async: the stub graph server lives in this process, so a blocking spawn would starve it
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env: e });
    let o = '';
    c.stdout.on('data', (d) => {
      o += d;
    });
    c.stderr.on('data', () => {});
    c.on('close', (code) => {
      rc = code;
      resolve(o.trim());
    });
    c.stdin.on('error', () => {});
    c.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const cap = (input) => hook('capture_evidence', input);
const json = (s) => JSON.parse(s);
const updated = (out) => json(out).hookSpecificOutput.updatedInput;
const readRun = (sid) => JSON.parse(readFileSync(runfile(sid), 'utf8'));
const stale = (sid) => {
  const d = readRun(sid);
  d.last_hb = 1;
  writeFileSync(runfile(sid), JSON.stringify(d));
}; // lease third long spent
const records = (f = evfile) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const tool = (name, tool_input, tool_response, sid = SID, extra = {}) => ({
  session_id: sid,
  tool_name: name,
  tool_input,
  ...(tool_response !== undefined ? { tool_response } : {}),
  ...extra,
});
const NEXT = 'mcp__enforcer-graph__graph_next_work';
const REPORT = 'mcp__enforcer-graph__graph_report';
const bashIn = (cmd, resp, sid = SID) => tool('Bash', { command: cmd }, resp, sid);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const card = {
  state: 'claimed',
  graph_id: 'g1',
  node: { node_id: 'n1', key: 'api-contract', title: 'Pin the contract' },
  run: { run_id: 'r1', attempt: 1, lease_expires_at: '2030-01-01T00:00:00Z' },
  acceptance: ['a', 'b'],
};
const cardStr = JSON.stringify(card);
const claim = (sid = SID, name = NEXT, resp = cardStr) => hook('track_run', tool(name, {}, resp, sid));
const sessionStartIn = (cwd, sid = SID) => ({ session_id: sid, cwd, hook_event_name: 'SessionStart', source: 'startup' });
const hbIn = (toolName, sid = SID) => ({ session_id: sid, cwd: PROJ, tool_name: toolName, tool_input: {} });

// --- session start ------------------------------------------------------------------------------------------------
let out;
test('session_start: prints the frontier', async () => {
  out = await hook('session_start', sessionStartIn(PROJ));
  assert.match(out, /frontier \(runnable now, not claimed\): api-contract, legal-and-key/);
});
test('session_start: prints running and failed', async () => {
  assert.match(out, /running: schema-judgment/);
  assert.match(out, /failed.*broken/);
});
test('session_start: silent without a graph config', async () => {
  assert.equal(await hook('session_start', sessionStartIn('/')), '');
});
test('session_start: silent on 401 (fails open)', async () => {
  assert.equal(await hook('session_start', sessionStartIn(PROJ), { GRAPH_API_KEY: 'wrong' }), '');
});

// --- track_run: next_work writes the run file, in each tool_response shape ----------------------------------------------
test('track_run: content-block response writes the run file', async () => {
  await hook('track_run', tool(NEXT, { graph: 'g1' }, [{ type: 'text', text: cardStr }]));
  assert.ok(existsSync(runfile()) && statSync(runfile()).size > 0);
  assert.equal(readRun().run_id, 'r1');
  rmSync(runfile(), { force: true });
});
test('track_run: string response writes the run file', async () => {
  await hook('track_run', tool(NEXT, {}, cardStr));
  assert.ok(existsSync(runfile()) && statSync(runfile()).size > 0);
});
test('track_run: a wait card writes nothing', async () => {
  rmSync(runfile(), { force: true });
  await hook('track_run', tool(NEXT, {}, { state: 'wait', graph_id: 'g1' }));
  assert.equal(existsSync(runfile()), false);
});

// --- heartbeat cadence and control channel -------------------------------------------------------------------------------
test('heartbeat: the first tool call after a claim beats once, the next eight within the lease send no HTTP', async () => {
  await claim();
  stub.clear();
  await hook('heartbeat', hbIn('Bash'));
  assert.equal(stub.logText().split('/runs/r1/heartbeat').length - 1, 1);
  stub.clear();
  for (let i = 0; i < 8; i++) await hook('heartbeat', hbIn('Bash'));
  assert.ok(!stub.logText().includes('heartbeat'));
});
let hbOut, hbMs;
test('heartbeat: a call after lease/3 elapsed heartbeats over HTTP', async () => {
  stale(SID);
  hbOut = await hook('heartbeat', hbIn('Bash'));
  const samples = [];
  // median of 5 further timed calls (each over HTTP): one cold or loaded sample must not fail the budget
  for (let i = 0; i < 5; i++) {
    stale(SID);
    const t = Date.now();
    await hook('heartbeat', hbIn('Bash'));
    samples.push(Date.now() - t);
  }
  hbMs = median(samples);
  assert.ok(stub.logText().includes('/nodes/n1/runs/r1/heartbeat'));
});
test('heartbeat: silent on ok', async () => assert.equal(hbOut, ''));
test('heartbeat: median of 5 under 500ms budget', async () => {
  // a node process starts in ~40ms; the budget is the python-era 500ms, widened by the cost of bare node on a busy host
  const bare = median(
    Array.from({ length: 5 }, () => {
      const t = Date.now();
      spawnSync(process.execPath, ['-e', '0'], { env });
      return Date.now() - t;
    }),
  );
  assert.ok(hbMs < 500 + bare, `${hbMs} ms (bare node ${bare} ms)`);
});
test('heartbeat: graph tools do not count or heartbeat', async () => {
  assert.equal(await hook('heartbeat', hbIn('mcp__enforcer-graph__graph_plan_status')), '');
});
test('heartbeat: cancel_requested says so in one line', async () => {
  stale(SID);
  stub.hb = 'cancel_requested';
  out = await hook('heartbeat', hbIn('Read'));
  assert.match(out, /systemMessage/);
  assert.match(out, /cancellation was requested for node api-contract/);
});
test('heartbeat: cancel_requested keeps the run file', async () => assert.ok(statSync(runfile()).size > 0));
test('heartbeat: reclaimed tells the model to stop', async () => {
  stale(SID);
  stub.hb = 'reclaimed';
  out = await hook('heartbeat', hbIn('Read'));
  assert.match(out, /another harness now owns it/);
});
test('heartbeat: reclaimed forgets the run', async () => assert.equal(existsSync(runfile()), false));

// --- remember on compact ------------------------------------------------------------------------------------------------
const transcript = join(WORK, 'transcript.jsonl');
test('remember_on_compact: posts one graph-scoped summary observation', async () => {
  await claim();
  writeFileSync(
    transcript,
    [
      { type: 'user', message: { role: 'user', content: 'work the plan' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Contract drafted; two shapes left to pin.' }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  stub.clear();
  await hook('remember_on_compact', { session_id: SID, cwd: PROJ, transcript_path: transcript, hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.ok(/graphs\/[^/\s]+\/observations/.test(stub.logText()) || stub.logText().includes('/nodes/n1/observations'));
});
test('remember_on_compact: body carries the last assistant message', async () => assert.ok(stub.logText().includes('two shapes left to pin')));
test('remember_on_compact: source names the session', async () => assert.ok(stub.logText().includes('claude-code:compact:s1')));
test('remember_on_compact: no run held, no HTTP', async () => {
  stub.clear();
  await hook('remember_on_compact', { session_id: 'nobody', cwd: PROJ, transcript_path: transcript, hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(stub.log.length, 0);
});

// --- stop guard ------------------------------------------------------------------------------------------------------------
test('open_run_guard: blocks a stop with a run open and unreported', async () => {
  out = await hook('open_run_guard', { session_id: SID, last_assistant_message: 'Done for today.', stop_hook_active: false });
  assert.match(out, /"decision": *"block"/);
  assert.match(out, /api-contract/);
});
test('open_run_guard: never blocks twice', async () => {
  assert.equal(await hook('open_run_guard', { session_id: SID, last_assistant_message: 'Done for today.', stop_hook_active: true }), '');
});
test('open_run_guard: an explicit still-running marker passes', async () => {
  assert.equal(
    await hook('open_run_guard', { session_id: SID, last_assistant_message: 'Progress is in graph_remember.\nstill running: r1', stop_hook_active: false }),
    '',
  );
});
test('track_run: graph_report clears the run file', async () => {
  await hook('track_run', tool(REPORT, { node_id: 'n1', run_id: 'r1', status: 'succeeded' }, '{"run":{}}'));
  assert.equal(existsSync(runfile()), false);
});
test('open_run_guard: silent once the run is reported', async () => {
  assert.equal(await hook('open_run_guard', { session_id: SID, last_assistant_message: 'Done for today.', stop_hook_active: false }), '');
});

// --- evidence capture: what actually ran, recorded as it happens ------------------------------------------------------------
const reportIn = (input = { report: 'x' }, sid = SID, extra = {}) => ({ session_id: sid, tool_name: REPORT, tool_input: input, ...extra });
test('capture: no run open, nothing captured', async () => {
  rmSync(runfile(), { force: true });
  rmSync(evfile, { force: true });
  await cap(bashIn('go test ./...', { stdout: 'ok enforcer-graph/internal/nodes', stderr: '', interrupted: false }));
  assert.equal(existsSync(evfile), false);
});
test('attach: no capture file, the report goes through untouched but for the client stamp', async () => {
  out = await hook('attach_evidence', reportIn({ node_id: 'n1', report: 'done' }));
  const u = updated(out);
  assert.deepEqual(u, { node_id: 'n1', report: 'done', client: u.client });
  assert.ok(!('evidence' in u));
});
test('capture: a run is open, the command is captured', async () => {
  await claim();
  await cap(bashIn('go build ./...', { stdout: '', stderr: '', interrupted: false }));
  assert.ok(statSync(evfile).size > 0 && readFileSync(evfile, 'utf8').includes('go build ./...'));
});
test('capture: a zero-exit command records exit 0', async () => {
  const r = records().at(-1);
  assert.ok(r.kind === 'command' && r.exit === 0);
});
test('capture: a Read and a Grep are not evidence of doing', async () => {
  await cap(tool('Read', { file_path: '/x/y.go' }, { file: { content: 'package x' } }));
  await cap(tool('Grep', { pattern: 'func' }, { numFiles: 3 }));
  assert.equal(records().length, 1);
});
// a failing Bash reaches the hook as the string "Error: Exit code N\n<output>"
test('capture: a Bash failure keeps its exit code and its output', async () => {
  await cap(bashIn('go vet ./...', 'Error: Exit code 1\ninternal/nodes/x.go:12: unreachable code'));
  const r = records().at(-1);
  assert.ok(r.exit === 1 && r.output.includes('unreachable code') && r.cmd === 'go vet ./...');
});
test('capture: an Edit records the path and what it wrote', async () => {
  await cap(tool('Edit', { file_path: '/w/nodes.go', old_string: 'a', new_string: 'b := runnable(ctx)' }, { filePath: '/w/nodes.go' }));
  const r = records().at(-1);
  assert.ok(r.kind === 'file' && r.path === '/w/nodes.go' && r.excerpt.includes('runnable(ctx)'));
});
test('capture: output is clipped, never unbounded', async () => {
  await cap(bashIn('cat big', { stdout: 'x'.repeat(9000), stderr: 'and a tail on stderr' }));
  assert.equal(records().at(-1).output.length, 4000);
});
test('capture: a clipped output keeps its END, where the verdict is', async () => {
  const o = records().at(-1).output;
  assert.ok(o.endsWith('and a tail on stderr') && o.startsWith('xxx') && o.includes('characters elided]'));
});
test('capture: a long go test -v keeps its ok line', async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.01s)`);
  await cap(bashIn('go test -v ./internal/stream/', { stdout: lines.join('\n') + '\nPASS\nok  \tenforcer-graph/internal/stream\t6.812s', stderr: '' }));
  const o = records().at(-1).output;
  assert.ok(o.length === 4000 && o.trimEnd().endsWith('6.812s') && o.includes('=== RUN   TestCase0'));
});

// --- selection at report time -----------------------------------------------------------------------------------------------
test('attach: rewrites the arguments through updatedInput', async () => {
  out = await hook('attach_evidence', reportIn({ node_id: 'n1', run_id: 'r1', status: 'succeeded', report: '1. done' }));
  const o = json(out).hookSpecificOutput,
    u = o.updatedInput;
  assert.ok(o.hookEventName === 'PreToolUse' && u.report === '1. done' && u.node_id === 'n1' && Array.isArray(u.evidence) && u.evidence.length);
});
// updatedInput REPLACES the whole argument object, so a key this hook does not echo is lost on the way to the server.
test('attach: an outputs argument survives the rewrite unchanged', async () => {
  out = await hook(
    'attach_evidence',
    reportIn({ node_id: 'n1', run_id: 'r1', status: 'succeeded', report: '1. done', outputs: { variance: 0.004, chosen: 'ENG-7' } }),
  );
  const u = updated(out);
  assert.deepEqual(u.outputs, { variance: 0.004, chosen: 'ENG-7' });
  assert.ok(u.evidence.length && u.report === '1. done');
});
// the worker's verbatim command records are MERGED with the capture; only prose notes are dropped.
test("attach: a worker's verbatim command record is merged, a prose note is not", async () => {
  const u = updated(
    await hook(
      'attach_evidence',
      reportIn({
        report: 'x',
        evidence: [
          { kind: 'note', text: 'trust me' },
          { kind: 'command', cmd: 'worker-cmd', exit: 0, output: 'theirs' },
        ],
      }),
    ),
  );
  assert.ok(!u.evidence.some((e) => e.text === 'trust me'));
  assert.ok(u.evidence.some((e) => e.cmd === 'worker-cmd' && e.output === 'theirs'));
  assert.ok(u.evidence.some((e) => String(e.cmd).includes('go vet')));
});
test('attach: context mode hands the capture over verbatim instead', async () => {
  const o = json(await hook('attach_evidence', reportIn({ report: 'x' }), { GRAPH_EVIDENCE_MODE: 'context' })).hookSpecificOutput;
  assert.ok(!('updatedInput' in o) && o.additionalContext.includes('VERBATIM') && o.additionalContext.includes('go vet'));
});

// thirty commands, one of them failing early: the cap keeps the failure and puts it first
test('attach: capped at the twenty the server accepts', async () => {
  rmSync(evfile, { force: true });
  for (let i = 1; i <= 30; i++) {
    if (i === 3) await cap(bashIn('go test ./internal/traverse', 'Error: Exit code 2\nFAIL bounds'));
    else await cap(bashIn(`echo step-${i}`, { stdout: 'ok', stderr: '', interrupted: false }));
  }
  await cap(tool('Write', { file_path: '/w/late.go', content: 'package late' }, { filePath: '/w/late.go' }));
  out = await hook('attach_evidence', reportIn());
  assert.equal(updated(out).evidence.length, 20);
});
test('attach: the cap keeps the failing command, and first', async () => {
  const e = updated(out).evidence;
  assert.ok(e[0].exit === 2 && e[0].cmd === 'go test ./internal/traverse');
});
test('attach: the most recent commands survive the cap', async () => {
  const cmds = updated(out).evidence.map((i) => i.cmd);
  assert.ok(cmds.includes('echo step-30') && !cmds.includes('echo step-1'));
});

// --- the capture is cleared when the run closes ---------------------------------------------------------------------------------
test('capture: the file is cleared when the run is reported', async () => {
  await hook('track_run', tool(REPORT, {}, '{"run":{}}'));
  assert.ok(!existsSync(evfile) && !existsSync(runfile()));
});
test('capture: a reclaimed lease clears the capture too', async () => {
  await claim();
  await cap(bashIn('ls', { stdout: 'a', stderr: '', interrupted: false }));
  stub.hb = 'reclaimed';
  stale(SID);
  await hook('heartbeat', hbIn('Read'));
  assert.equal(existsSync(evfile), false);
  stub.hb = 'ok';
});

// --- hooks fail open ---------------------------------------------------------------------------------------------------------------
test('capture_evidence: garbage stdin is silent and exit 0', async () => {
  out = await cap('not json');
  assert.ok(out === '' && rc === 0);
});
test('attach_evidence: garbage stdin is silent and exit 0', async () => {
  out = await hook('attach_evidence', 'not json');
  assert.ok(out === '' && rc === 0);
});
test('capture_evidence: an unwritable data dir is silent and exit 0', async () => {
  out = await hook('capture_evidence', bashIn('ls', { stdout: 'a', stderr: '', interrupted: false }), { CLAUDE_PLUGIN_DATA: '/proc/nonexistent/data' });
  assert.ok(out === '' && rc === 0);
});
test('attach_evidence: an unwritable data dir still only stamps the client, exit 0', async () => {
  out = await hook('attach_evidence', reportIn(), { CLAUDE_PLUGIN_DATA: '/proc/nonexistent/data' });
  assert.equal(rc, 0);
  assert.deepEqual(Object.keys(updated(out)).sort(), ['client', 'report']);
});
test('capture_evidence: runs on every tool call, under 500ms', async () => {
  const bare = median(
    Array.from({ length: 5 }, () => {
      const t = Date.now();
      spawnSync(process.execPath, ['-e', '0'], { env });
      return Date.now() - t;
    }),
  );
  const t = Date.now();
  await cap(bashIn('echo hi', { stdout: 'hi', stderr: '', interrupted: false }));
  const ms = Date.now() - t;
  assert.ok(ms < 500 + bare, `${ms} ms (bare node ${bare} ms)`);
  await hook('track_run', tool(REPORT, {}, '{"run":{}}'));
});

// --- fail open with the API down ----------------------------------------------------------------------------------------------------
test('heartbeat: API down is silent and exit 0', async () => {
  await claim();
  stale(SID);
  out = await hook('heartbeat', hbIn('Read'), { GRAPH_BASE_URL: 'http://127.0.0.1:1' });
  assert.ok(out === '' && rc === 0);
});
test('any hook: garbage stdin is silent and exit 0', async () => {
  out = await hook('session_start', 'not json', {}, ['ENFORCER_BASE_URL']); // unconfigured: no server named, nothing to say
  assert.ok(out === '' && rc === 0);
});

// --- a claimed pull request is resolved, not taken on trust (2026-09-20) ------------------------------------------------------------
// A fake gh on PATH: no network, no GitHub sign-in, no real HOME.
const fakebin = join(WORK, 'fakebin');
mkdirSync(fakebin, { recursive: true });
writeFileSync(
  join(fakebin, 'gh'),
  `#!/bin/sh
if [ "$3" = "11" ]; then
  echo '{"state":"MERGED","title":"a merged change","mergedAt":"2026-01-01T00:00:00Z","url":"https://github.com/instruxi-io/enforcer-governor/pull/11"}'
else
  echo "GraphQL: Could not resolve to a PullRequest with the number of $3." >&2; exit 1
fi
`,
);
chmodSync(join(fakebin, 'gh'), 0o755);
const prJson = (url) => {
  const prev = process.env.PATH;
  process.env.PATH = `${fakebin}:${prev}`;
  try {
    const r = checkPr(url);
    return r ? JSON.stringify(r) : '';
  } finally {
    process.env.PATH = prev;
  }
};
test('pr: a pull request that does not exist is recorded as NOT FOUND', async () => {
  assert.match(prJson('https://github.com/instruxi-io/enforcer-graph/pull/999999'), /NOT FOUND/);
});
test('pr: a real pull request resolves to its state and title', async () => {
  out = prJson('https://github.com/instruxi-io/enforcer-governor/pull/11');
  assert.ok(out.includes('merged') && out.includes('state=MERGED'));
});
test('pr: a non-URL is not a claim to check', async () => assert.equal(prJson('not a url'), ''));
test('pr: an unreachable repo fails open or records it, never crashes', async () => {
  prJson('https://github.com/instruxi-io/definitely-not-a-repo-xyz/pull/1');
});

// --- a fact gets the RECENT record, not the whole run (2026-09-20) ------------------------------------------------------------------
test('remember: only the most recent records are attached, not the whole run', async () => {
  mkdirSync(join(DATA, 'evidence'), { recursive: true });
  mkdirSync(join(DATA, 'runs'), { recursive: true });
  writeFileSync(
    join(DATA, 'evidence', 'sess-rem.jsonl'),
    Array.from({ length: 8 }, (_, i) => JSON.stringify({ kind: 'command', cmd: `step ${i}`, exit: 0, output: `out ${i}` })).join('\n') + '\n',
  );
  writeFileSync(join(DATA, 'runs', 'sess-rem.json'), JSON.stringify({ graph_id: 'g', node_id: 'n', run_id: 'r', key: 'k' }));
  out = await hook('attach_evidence', {
    session_id: 'sess-rem',
    tool_name: 'mcp__enforcer-graph__graph_remember',
    tool_input: { graph: 'g', node_id: 'n', body: 'The default lease is 300 seconds.' },
  });
  const n = (updated(out).evidence || []).length;
  assert.ok(n <= 3 && n >= 1, `got ${n} of 8`);
});
test('remember: the fact itself is passed through untouched', async () => assert.ok(out.includes('The default lease is 300 seconds')));
test('report: still gets the whole captured run, not the recency window', async () => {
  const outr = await hook('attach_evidence', {
    session_id: 'sess-rem',
    tool_name: 'mcp__enforcer-graph__graph_report',
    tool_input: { graph: 'g', node_id: 'n', run_id: 'r', status: 'succeeded', report: 'done' },
  });
  const nr = (updated(outr).evidence || []).length;
  assert.ok(nr > 3, `got ${nr}`);
  rmSync(join(DATA, 'evidence'), { recursive: true, force: true });
  rmSync(join(DATA, 'runs'), { recursive: true, force: true });
});

// --- two subagents in ONE session ----------------------------------------------------------------------------------------------------
// Hooks fire in the PARENT session's context for a SUBAGENT's tool call, so keying by session_id put both agents in one run file
// and one evidence file. Both agents share a session_id and differ only by agent_id, which is how Claude Code presents them.
const AK = (id) => createHash('sha256').update(`agent_id:${id}`).digest('hex').slice(0, 32);
const sclaim = (agent, suffix) =>
  hook('track_run', {
    session_id: SID,
    agent_id: agent,
    cwd: PROJ,
    hook_event_name: 'PostToolUse',
    tool_name: NEXT,
    tool_input: { graph: 'g1' },
    tool_response: {
      state: 'claimed',
      graph_id: 'g1',
      node: { node_id: `n-${suffix}`, key: `k-${suffix}` },
      run: { run_id: `r-${suffix}`, lease_expires_at: '2099-01-01T00:00:00Z' },
    },
  });
const scap = (agent, command) =>
  cap({
    session_id: SID,
    agent_id: agent,
    cwd: PROJ,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: 'ok', stderr: '' },
  });
const evlines = (agent) => {
  const f = join(DATA, 'evidence', `${AK(agent)}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
};
let rep;
test('two subagents in one session hold TWO run files, not one', async () => {
  await sclaim('agent-A', 'a');
  await sclaim('agent-B', 'b');
  const n = readdirSync(join(DATA, 'runs')).filter((f) => f.endsWith('.json')).length;
  assert.equal(n, 2);
});
test("agent A's run file still names its own node", async () => assert.ok(readFileSync(join(DATA, 'runs', `${AK('agent-A')}.json`), 'utf8').includes('k-a')));
test("agent B's run file names B's node, not A's", async () => assert.ok(readFileSync(join(DATA, 'runs', `${AK('agent-B')}.json`), 'utf8').includes('k-b')));
test('agent A captured only its own two records', async () => {
  await scap('agent-A', 'go test ./a');
  await scap('agent-A', 'go build ./a');
  await scap('agent-B', 'go test ./b');
  assert.equal(evlines('agent-A'), 2);
});
test('agent B captured only its own one record', async () => assert.equal(evlines('agent-B'), 1));
test("A's report carries A's 2 records and none of B's", async () => {
  rep = await hook('attach_evidence', {
    session_id: SID,
    agent_id: 'agent-A',
    cwd: PROJ,
    hook_event_name: 'PreToolUse',
    tool_name: REPORT,
    tool_input: { graph: 'g1', node_id: 'n-a', run_id: 'r-a', status: 'succeeded', report: 'done' },
  });
  assert.equal((updated(rep).evidence || []).length, 2);
});
test("A's report does not carry B's command", async () => assert.ok(rep.includes('go test ./a') && !rep.includes('go test ./b')));
test("A reporting did not clear B's evidence", async () => {
  assert.equal(evlines('agent-B'), 1);
  rmSync(join(DATA, 'evidence'), { recursive: true, force: true });
  rmSync(join(DATA, 'runs'), { recursive: true, force: true });
});

// --- the Enforcer OAuth sign-in instead of a key ---------------------------------------------------------------------------------------
// No GRAPH_API_KEY: the hooks read the shared sign-in file /enforcer:login writes, and refresh it when the access token is close to expiry.
const EH = join(WORK, 'enforcer');
mkdirSync(EH, { recursive: true });
const SIGNIN = join(EH, 'credentials.json');
const creds = (access, expires) =>
  writeFileSync(
    SIGNIN,
    JSON.stringify(
      {
        enforcer: {
          base_url: stub.url,
          oauth: {
            access_token: access,
            refresh_token: 'rt-1',
            expires_at: expires,
            token_endpoint: `${stub.url}/token`,
            client_id: 'mcp_test',
            scope: 'enforcer:read',
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
mkdirSync(join(WORK, 'oproj', '.enforcer'), { recursive: true });
writeFileSync(join(WORK, 'oproj', '.enforcer', 'graph.json'), '{"graph_id":"g1"}\n');
const ohook = (input) => hook('session_start', input, { ENFORCER_HOME: EH }, ['GRAPH_API_KEY', 'ENFORCER_API_KEY']);
const start = sessionStartIn(join(WORK, 'oproj'));
test('oauth: a signed-in machine needs no key (base_url from the sign-in)', async () => {
  creds('stub-token', '2099-01-01T00:00:00.000Z');
  assert.match(await ohook(start), /frontier \(runnable now/);
});
test('oauth: an expired token is refreshed and the call succeeds', async () => {
  creds('expired-token', '2000-01-01T00:00:00.000Z');
  stub.clear();
  assert.match(await ohook(start), /frontier \(runnable now/);
});
test('oauth: the rotated pair is written back', async () => {
  const d = JSON.parse(readFileSync(SIGNIN, 'utf8')).enforcer.oauth;
  assert.ok(d.access_token === 'stub-token-2' && d.refresh_token === 'rt-2');
});
test('oauth: the file stays 0600', async () => assert.equal((statSync(SIGNIN).mode & 0o777).toString(8), '600'));
test('oauth: the refresh used the refresh_token grant', async () =>
  assert.ok(stub.log.some((r) => r.path === '/token' && r.body.grant_type === 'refresh_token')));
test('oauth: a refused refresh says to sign in again, and does not block', async () => {
  creds('expired-token', '2000-01-01T00:00:00.000Z');
  const d = JSON.parse(readFileSync(SIGNIN, 'utf8'));
  d.enforcer.oauth.refresh_token = 'revoked';
  writeFileSync(SIGNIN, JSON.stringify(d));
  assert.match(await ohook(start), /run \/enforcer:login/);
});
test('oauth: signed out and no key is silent', async () => {
  rmSync(SIGNIN, { force: true });
  assert.equal(await ohook(start), '');
});

// --- graph tools are recognised under every server name that carries them -------------------------------------------------------------------
for (const name of ['mcp__plugin_enforcer_enforcer__graph_next_work', 'mcp__enforcer__graph_next_work', 'mcp__enforcer-graph__graph_next_work']) {
  test(`track_run: ${name} writes the run file`, async () => {
    rmSync(runfile(), { force: true });
    await hook('track_run', tool(name, {}, cardStr));
    assert.ok(existsSync(runfile()) && statSync(runfile()).size > 0);
  });
}
const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
const SERVERS = ['plugin_enforcer_enforcer', 'enforcer', 'enforcer-graph'];
const eventSrc = readFileSync(join(ROOT, 'src/event.mjs'), 'utf8');
const rx = (name) => {
  const m = new RegExp(`const ${name} = /(.*)/;`).exec(eventSrc);
  return new RegExp(`^(?:${m[1]})$`);
};
test('hooks.json matchers cover all three server names, and nothing else', async () => {
  rmSync(runfile(), { force: true });
  const pre = rx('PRE_GRAPH'),
    post = rx('POST_GRAPH');
  for (const s of SERVERS) {
    assert.ok(pre.test(`mcp__${s}__graph_report`) && pre.test(`mcp__${s}__graph_remember`));
    for (const t of ['next_work', 'report', 'heartbeat']) assert.ok(post.test(`mcp__${s}__graph_${t}`));
  }
  assert.ok(!pre.test('mcp__other__graph_report') && !post.test('mcp__enforcer__enforcer_whoami'));
});
test('heartbeat: skips graph tools under the plugin server name too', async () => {
  assert.ok(isGraphTool('mcp__plugin_enforcer_enforcer__graph_report') && !isGraphTool('Bash'));
});
test("attach: the attach hook's timeout covers the upload budget and the PR check", async () => {
  const t = hooksJson.PreToolUse.flatMap((m) => m.hooks)
    .filter((h) => h.command.includes('event pre-tool-use'))
    .map((h) => h.timeout)[0];
  assert.ok(t >= 25, String(t));
});

test('agent + skill: a structured graph_remember before any failed report; the remediation/triage loop documented', async () => {
  assert.ok(readFileSync(join(ROOT, 'agents/graph-worker.md'), 'utf8').includes('Before ANY `failed` report, `graph_remember`'));
  assert.ok(/^## When a node fails: remember, remediate, triage/m.test(readFileSync(join(ROOT, 'skills/graph/SKILL.md'), 'utf8')));
});
test('dispatch: --help works and names the flags', async () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin/enforcer'), 'dispatch', '--help'], { cwd: ROOT, env: baseEnv, encoding: 'utf8' });
  assert.ok((r.stdout || '').includes('--workers'));
});

// --- client attestation: every claim, heartbeat and report says hooks=on (X-Graph-Client, enforcer-graph 089) ---------------------------------
const ver = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).version;
const want = `enforcer-graph-plugin/${ver}; hooks=on`;
for (const t of ['next_work', 'heartbeat', 'report']) {
  for (const pre of ['mcp__plugin_enforcer_enforcer__', 'mcp__enforcer__', 'mcp__enforcer-graph__']) {
    test(`client: stamped on ${pre}graph_${t}`, async () => {
      await hook('session_start', { session_id: `client-${t}` }); // the self-check marker hooks=on needs
      const u = updated(
        await hook('attach_evidence', { session_id: `client-${t}`, tool_name: `${pre}graph_${t}`, tool_input: { graph: 'g1', client: 'made-up' } }),
      );
      assert.ok(u.client === want && u.graph === 'g1', JSON.stringify(u));
    });
  }
}
test('client: no self-check marker -> hooks=off:no-capture-yet, never hooks=on', async () => {
  out = await hook('attach_evidence', { session_id: 'client-unmarked', tool_name: 'mcp__enforcer__graph_next_work', tool_input: { graph: 'g1' } });
  assert.ok(out.includes('hooks=off:no-capture-yet') && !out.includes('hooks=on'));
});
test('client: not stamped on graph_remember (it takes no client)', async () => {
  out = await hook('attach_evidence', { session_id: 'client-r', tool_name: 'mcp__plugin_enforcer_enforcer__graph_remember', tool_input: { graph: 'g1' } });
  assert.ok(!out.includes('hooks=on'));
});
test('client: other graph tools are left alone', async () => {
  assert.equal(
    await hook('attach_evidence', { session_id: 'client-p', tool_name: 'mcp__plugin_enforcer_enforcer__graph_plan_status', tool_input: { graph: 'g1' } }),
    '',
  );
});
test('client: context mode (rewrites not applied) does not pretend to stamp', async () => {
  out = await hook(
    'attach_evidence',
    { session_id: 'client-c', tool_name: 'mcp__plugin_enforcer_enforcer__graph_next_work', tool_input: { graph: 'g1' } },
    { GRAPH_EVIDENCE_MODE: 'context' },
  );
  assert.ok(!out.includes('updatedInput'));
});
test('client: hooks.json routes next_work, heartbeat and report through the stamping hook', async () => {
  const pre = rx('PRE_GRAPH');
  for (const s of SERVERS) for (const t of ['next_work', 'heartbeat', 'report']) assert.ok(pre.test(`mcp__${s}__graph_${t}`));
});
test("client: the hook's own HTTP heartbeat sends X-Graph-Client", async () => {
  const SID2 = 'client-hb';
  await hook('track_run', tool(NEXT, {}, cardStr, SID2));
  stub.clear();
  stub.hb = 'ok';
  stale(SID2);
  await hook('heartbeat', hbIn('Bash', SID2));
  const r = stub.log.filter((x) => x.path.includes('/heartbeat'));
  // the shared API client names itself enforcer-plugin/<version>; the attestation is its `hooks=on` suffix
  const ok = (c) => c === `enforcer-plugin/${ver}; hooks=on` || c === want;
  assert.ok(r.length && r.every((x) => ok(x.client)), JSON.stringify(r.map((x) => x.client)));
  rmSync(runfile(SID2), { force: true });
});

// --- session_start version check: one line per mismatch, silent when aligned, workspace from the sign-in --------------------------------------
const MK = join(WORK, 'mkt');
const CC = env.CLAUDE_CONFIG_DIR;
const W = (p, d) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof d === 'string' ? d : JSON.stringify(d));
};
const manifestTools = () => JSON.parse(readFileSync(join(ROOT, 'lib/api/spec/mcp-manifest.json'), 'utf8')).tools.map((t) => t.name);
const installedPath = join(CC, 'plugins', 'installed_plugins.json');
const ss = () => hook('session_start', sessionStartIn('/'));
const noticeFile = join(DATA, 'notices.json');
let raw;
test('version check: one line per stale install, with scope and the update command', async () => {
  mkdirSync(join(CC, 'plugins'), { recursive: true });
  mkdirSync(env.ENFORCER_HOME, { recursive: true });
  W(join(MK, MANIFEST_DIR, 'marketplace.json'), {
    name: 'instruxi',
    plugins: [
      { name: 'enforcer', source: './enforcer' },
      { name: 'enforcer-graph', source: './enforcer-graph' },
      { name: 'gov', source: { source: 'github', repo: 'x/y' } },
    ],
  });
  W(join(MK, 'enforcer-graph', MANIFEST_DIR, 'plugin.json'), { name: 'enforcer-graph', version: '9.1.0' });
  W(join(MK, 'enforcer', MANIFEST_DIR, 'plugin.json'), { name: 'enforcer', version: '0.5.0' });
  W(join(CC, 'plugins', 'known_marketplaces.json'), { instruxi: { installLocation: MK } });
  W(installedPath, {
    version: 2,
    plugins: {
      'enforcer-graph@instruxi': [
        { scope: 'user', version: '0.15.0' },
        { scope: 'local', version: '0.13.0' },
        { scope: 'project', version: '9.1.0' },
      ],
    },
  });
  stub.health = { version: '0.9.14', tools: manifestTools() };
  raw = await ss();
  out = json(raw).systemMessage;
  assert.equal(out.split('\n').filter((l) => /^enforcer-graph .* installed \(/.test(l)).length, 2);
  assert.ok(out.includes('enforcer-graph 0.15.0 installed (user) — 9.1.0 available: claude plugin update enforcer-graph@instruxi'));
  assert.ok(out.includes('enforcer-graph 0.13.0 installed (local) — 9.1.0 available'));
});
test('version check: an install at the marketplace version is not reported', async () => assert.ok(!out.includes('9.1.0 installed')));
test('version check: enforcer-graph without enforcer is told exactly what to install', async () =>
  assert.ok(out.includes('claude plugin install enforcer@instruxi')));
test('version check: notices reach the person (systemMessage)', async () => assert.ok(raw.includes('systemMessage')));
test('version check: each notice is said once', async () => assert.equal(await ss(), ''));
test('version check: aligned (no sign-in), nothing to say', async () => {
  W(installedPath, { version: 2, plugins: { 'enforcer-graph@instruxi': [{ version: '9.1.0', auto: true }], 'enforcer@instruxi': [{ version: '0.5.0' }] } });
  rmSync(noticeFile, { force: true });
  assert.equal(await ss(), '');
});
test('version check: MCP tools the plugin does not know are one line', async () => {
  stub.health = { version: '0.9.14', tools: [...manifestTools(), 'gizmo_a', 'gizmo_b', 'zeta'] };
  rmSync(noticeFile, { force: true });
  out = json(await ss()).systemMessage;
  assert.equal(out.split('\n').filter((l) => l.startsWith('MCP ')).length, 1);
  assert.match(out, /MCP 0\.9\.14 serves tools this plugin \(.*\) does not know: gizmo_\*, zeta/);
});
test("version check: prints the sign-in's workspace", async () => {
  stub.health = { version: '0.9.14', tools: manifestTools() };
  const b64 = (d) => Buffer.from(JSON.stringify(d)).toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ tenant: 'Acme', tenant_id: 't-1', role: 'admin' })}.x`;
  writeFileSync(
    join(env.ENFORCER_HOME, 'credentials.json'),
    JSON.stringify({ enforcer: { oauth: { access_token: jwt, expires_at: '2099-01-01T00:00:00Z' } } }),
  );
  rmSync(noticeFile, { force: true });
  out = json(await ss()).hookSpecificOutput.additionalContext;
  assert.equal(out, 'enforcer workspace: Acme (t-1) · role admin');
  rmSync(join(CC, 'plugins'), { recursive: true, force: true });
  rmSync(env.ENFORCER_HOME, { recursive: true, force: true });
});

// --- evidence merge and run scoping (0.19.0) ----------------------------------------------------------------------------------------------------
const MS = 'mrg';
const mrun = (o) => {
  mkdirSync(join(DATA, 'runs'), { recursive: true });
  writeFileSync(join(DATA, 'runs', `${MS}.json`), JSON.stringify(o));
};
const mbash = (cmd, stdout) => bashIn(cmd, { stdout, stderr: '', interrupted: false }, MS);
const mcap = (cmd, stdout) => cap(mbash(cmd, stdout));
const mrep = (evidence) => hook('attach_evidence', { session_id: MS, tool_name: REPORT, tool_input: { report: 'x', evidence } });
const mev = join(DATA, 'evidence', `${MS}.jsonl`);
test('merge: 8 passed records plus 2 captured leave 10, none with output dropped', async () => {
  rmSync(mev, { force: true });
  mrun({ graph_id: 'g', node_id: 'n', run_id: 'rA', key: 'a' });
  await mcap('echo cap-one', 'cap-one');
  await mcap('echo cap-two', 'cap-two');
  const eight = Array.from({ length: 8 }, (_, i) => ({ kind: 'command', cmd: `worker-${i}`, exit: 0, output: `passed ${i}` }));
  const e = updated(await mrep(eight)).evidence;
  const w = e.filter((x) => (x.cmd || '').startsWith('worker-'));
  assert.ok(e.length === 10 && w.length === 8 && w.every((x) => x.output) && e[0].cmd === 'echo cap-one');
});
test('merge: a passed record duplicating a captured cmd+exit is deduped', async () => {
  out = await mrep([
    { kind: 'command', cmd: 'echo cap-one', exit: 0, output: 'cap-one' },
    { kind: 'command', cmd: 'w', exit: 0, output: 'o' },
  ]);
  const e = updated(out).evidence;
  assert.ok(e.length === 3 && e.filter((x) => x.cmd === 'echo cap-one').length === 1);
});
test('capture: Bash results are {kind:command, cmd, exit, output} and carry no run tag after attach', async () => {
  const e = updated(out).evidence[0];
  assert.ok(e.kind === 'command' && e.exit === 0 && e.output === 'cap-one' && !('_run' in e));
});
// gates survive the bound
test('capture: under the cap the oldest deciding gate (verify.sh) is kept', async () => {
  rmSync(mev, { force: true });
  await mcap('bash scripts/verify.sh', 'VERIFY OK');
  for (let i = 1; i <= 30; i++) await mcap(`ls dir-${i}`, 'x');
  const e = updated(await mrep([])).evidence;
  assert.ok(e.length === 20 && e.some((x) => x.cmd === 'bash scripts/verify.sh'));
});
test('capture: a PR URL in a tool result is attached as an artifact record', async () => {
  rmSync(mev, { force: true });
  await mcap('gh pr create', 'https://github.com/instruxi-io/claude-plugins/pull/31');
  const e = updated(await mrep([])).evidence;
  assert.ok(e.some((x) => x.kind === 'artifact' && x.url === 'https://github.com/instruxi-io/claude-plugins/pull/31'));
});
// scoping: a claim starts a clean capture, and another run's records are never attached
test("scope: results from before this run's claim are not attached", async () => {
  await mcap('echo other-nodes-work', 'x');
  await hook('track_run', {
    session_id: 'mrg',
    tool_name: NEXT,
    tool_input: { graph: 'g' },
    tool_response: { state: 'claimed', graph_id: 'g', node: { node_id: 'nB', key: 'b' }, run: { run_id: 'rB', lease_expires_at: '2099-01-01T00:00:00Z' } },
  });
  await mcap('echo mine-only', 'mine');
  const e = updated(await mrep([])).evidence;
  assert.deepEqual(
    e.map((x) => x.cmd),
    ['echo mine-only'],
  );
});
test('scope: a record tagged with another run is never attached', async () => {
  mrun({ graph_id: 'g', node_id: 'nB', run_id: 'rB', key: 'b' });
  appendFileSync(mev, JSON.stringify({ kind: 'command', cmd: 'stale-from-rA', exit: 0, output: 'z', _run: 'rA' }) + '\n');
  out = await mrep([]);
  assert.ok(!out.includes('stale-from-rA') && out.includes('mine-only'));
});

test('hooks gate: actor key + graph tools ungated (node)', async () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'test/hooks.test.mjs')], { cwd: ROOT, env: baseEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
