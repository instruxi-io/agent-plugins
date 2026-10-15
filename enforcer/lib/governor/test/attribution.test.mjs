// A session's project, told to the control plane at SessionStart
// (core/attribution.mjs).
//
// What matters here is mostly what must NOT happen: it must not send anything
// when signed out or when shipping is off, must not hold a session start open
// past a short timeout, must not retry or queue, and must shrug off a server
// that has never heard of the endpoint (404) -- the server ships separately,
// and a governor released first has to be harmless against it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'gov-attribution-'));
process.env.GOVERNOR_HOME = join(home, 'g');
process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;
mkdirSync(process.env.GOVERNOR_HOME, { recursive: true });
mkdirSync(process.env.ENFORCER_HOME, { recursive: true });

const PATH = '/api/v1/governance/ingest/attributions';
let mode = 'ok'; // ok | 404 | 500 | hang
let posts = []; // every attribution request the server saw
const hung = [];
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    if (req.url === PATH && req.method === 'POST') {
      posts.push({ auth: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(body || '{}') });
      if (mode === 'hang') {
        hung.push(res);
        return;
      }
      if (mode === '404') {
        res.writeHead(404);
        return res.end('Cannot POST ' + PATH);
      }
      if (mode === '500') {
        res.writeHead(500);
        return res.end('export failed');
      }
      const { agent, client = '', harness, session_id } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const registration = session_id ? { registration: { harness, session_id, trust: 2, registered_at: '2026-10-15T12:00:00Z' } } : {};
      return res.end(JSON.stringify({ success: true, data: { agent, client: client.replace(/^\?/, ''), client_guessed: client[0] === '?', ...registration } }));
    }
    if (req.url === '/api/v1/enforcer/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: { account_id: 'acct-1', person: { primary_email: 'ada@acme.dev' } } }));
    }
    if (req.url.startsWith('/api/v1/governance/settings')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: { settings: {} } }));
    }
    if (req.url.startsWith('/api/v1/governance/otlp/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const signIn = () =>
  writeFileSync(
    join(process.env.ENFORCER_HOME, 'credentials.json'),
    JSON.stringify({
      enforcer: { base_url: base, oauth: { client_id: 'client-1', access_token: 'at-1', expires_at: '2999-01-01T00:00:00Z' } },
    }),
  );
const signOut = () => writeFileSync(join(process.env.ENFORCER_HOME, 'credentials.json'), JSON.stringify({ enforcer: {} }));
// Decisioning is off by default; the rule cases here need it on.
const setConfig = (c) => writeFileSync(join(process.env.GOVERNOR_HOME, 'config.json'), JSON.stringify({ budgetOn: true, rulesOn: true, policyOn: true, ...c }));
const files = () => readdirSync(process.env.GOVERNOR_HOME).sort();

const { createGovernor } = await import('../core/index.mjs');
const { ATTRIBUTION_TIMEOUT_MS } = await import('../core/attribution.mjs');
const gov = createGovernor({ harness: 'test' });
const session = { agent: 'claude:0f3c9a1b', cwd: '/w/acme-api' };

let pass = 0;
const ok = async (label, fn) => {
  posts = [];
  mode = 'ok';
  await fn();
  pass++;
  console.log('  ok  ' + label);
};

await ok('signed out: nothing is sent', async () => {
  signOut();
  setConfig({});
  const r = await gov.session.start(session);
  assert.equal(posts.length, 0);
  assert.equal(r.sent, false);
});

await ok('signed in: ONE request per session start, carrying the derived project', async () => {
  signIn();
  setConfig({});
  const r = await gov.session.start(session);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { agent: 'claude:0f3c9a1b', client: '?acme-api' }, 'unmapped: the folder, marked as a guess');
  assert.equal(posts[0].auth, 'Bearer at-1');
  assert.match(posts[0].type, /^application\/json/);
  assert.deepEqual(r, { sent: true, status: 200, client: 'acme-api' });
});

await ok('a configured mapping names the project, as a receipt would', async () => {
  setConfig({ clients: { '/w/acme-api': 'acme' } });
  await gov.session.start({ agent: 'claude:11112222', cwd: '/w/acme-api/src' });
  assert.deepEqual(
    posts.map((p) => p.body),
    [{ agent: 'claude:11112222', client: 'acme' }],
  );
  setConfig({});
});

await ok('shipping switched off: nothing is sent', async () => {
  setConfig({ shipOn: false });
  const r = await gov.session.start(session);
  assert.equal(posts.length, 0);
  assert.equal(r.skipped, 'shipping is switched off (shipOn)');
  setConfig({});
});

await ok('an older caller (no event) and a session with no directory send nothing', async () => {
  assert.equal(await gov.session.start(), undefined, 'start() with no event resolves as it always did');
  await gov.session.start({ agent: 'claude:0f3c9a1b' });
  assert.equal(posts.length, 0);
});

await ok('an old server (404) is harmless: no throw, no retry, no queue, no error recorded', async () => {
  // Warm the managed/identity caches so the only thing start() does is attribute.
  await gov.session.start(session);
  const before = files();
  posts = [];
  mode = '404';
  const r = await gov.session.start(session);
  assert.deepEqual(r, { sent: true, status: 404 });
  assert.equal(posts.length, 1, 'sent once, not retried');
  assert.deepEqual(files(), before, 'nothing written: no outbox entry, no failure mark, no receipt');
  assert.equal(existsSync(join(process.env.GOVERNOR_HOME, 'receipts.jsonl')), false, 'not a receipt');
  // The next start sends once more -- because it is a new start, not a resend.
  await gov.session.start(session);
  assert.equal(posts.length, 2);
});

await ok('a server error is ignored the same way', async () => {
  mode = '500';
  const r = await gov.session.start(session);
  assert.deepEqual(r, { sent: true, status: 500 });
  assert.equal(posts.length, 1);
});

await ok('a server that never answers cannot hold the session start past the timeout', async () => {
  mode = 'hang';
  const t0 = Date.now();
  // Raced against a guard, so a missing timeout FAILS here instead of hanging
  // the suite.
  let guard;
  const r = await Promise.race([
    gov.session.start(session),
    new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error('session start is still waiting on the server')), ATTRIBUTION_TIMEOUT_MS + 3000);
    }),
  ]);
  clearTimeout(guard);
  const took = Date.now() - t0;
  assert.equal(r.sent, false);
  assert.match(r.detail, /no answer within/);
  assert.ok(took >= ATTRIBUTION_TIMEOUT_MS - 50 && took < ATTRIBUTION_TIMEOUT_MS + 1000, `took ${took}ms`);
  assert.equal(posts.length, 1, 'and it is not retried');
});

await ok('an unreachable control plane is a silent no-op', async () => {
  writeFileSync(
    join(process.env.ENFORCER_HOME, 'credentials.json'),
    JSON.stringify({
      enforcer: { base_url: 'http://127.0.0.1:9', oauth: { client_id: 'client-1', access_token: 'at-1', expires_at: '2999-01-01T00:00:00Z' } },
    }),
  );
  setConfig({ ingestUrl: 'http://127.0.0.1:9' });
  const r = await gov.session.start(session);
  assert.equal(r.sent, false);
  signIn();
  setConfig({});
});

const full = '0f3c9a1b-7d2e-4c11-9a55-3e8b1f0c2d44';

await ok('with the full session id, the same request announces the session under the harness', async () => {
  const r = await gov.session.start({ ...session, session: full });
  assert.equal(posts.length, 1, 'still one request');
  assert.deepEqual(posts[0].body, { agent: 'claude:0f3c9a1b', client: '?acme-api', harness: 'test', session_id: full });
  assert.deepEqual(r, { sent: true, status: 200, client: 'acme-api', trust: 2 });
});

await ok("the event names the harness that is running, over the governor's own", async () => {
  await gov.session.start({ ...session, session: full, harness: 'grok-cli' });
  // '' is an adapter saying it cannot tell: the project goes, no announcement.
  await gov.session.start({ ...session, session: full, harness: '' });
  assert.deepEqual(
    posts.map((p) => p.body),
    [
      { agent: 'claude:0f3c9a1b', client: '?acme-api', harness: 'grok-cli', session_id: full },
      { agent: 'claude:0f3c9a1b', client: '?acme-api' },
    ],
  );
});

await ok('a session with no project to name is still announced', async () => {
  const r = await gov.session.start({ agent: 'claude:0f3c9a1b', session: full });
  assert.deepEqual(
    posts.map((p) => p.body),
    [{ agent: 'claude:0f3c9a1b', harness: 'test', session_id: full }],
  );
  assert.deepEqual(r, { sent: true, status: 200, trust: 2 });
});

await ok('a registration the server would refuse is left off, so the project still lands', async () => {
  // The agent id's short form is not the session's: the server refuses the
  // whole body, so only the attribution goes.
  await gov.session.start({ ...session, session: 'deadbeef-0000' });
  // 'unknown' is reserved for rows no profile matched; it announces nothing.
  await createGovernor().session.start({ ...session, session: full });
  assert.deepEqual(
    posts.map((p) => p.body),
    [
      { agent: 'claude:0f3c9a1b', client: '?acme-api' },
      { agent: 'claude:0f3c9a1b', client: '?acme-api' },
    ],
  );
});

await ok('neither a project nor a registrable session: nothing is sent', async () => {
  await createGovernor().session.start({ agent: 'claude:0f3c9a1b', session: full });
  assert.equal(posts.length, 0);
});

await ok("the running harness: Grok's shim, Claude Code's marker, else unknown to us", async () => {
  const { runningHarness } = await import('../adapters/claude-code/index.mjs');
  assert.equal(runningHarness({ ENFORCER_HARNESS: 'grok', CLAUDECODE: '1' }), 'grok-cli');
  assert.equal(runningHarness({ ENFORCER_HARNESS: 'codex' }), 'codex');
  assert.equal(runningHarness({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(runningHarness({ ENFORCER_HARNESS: 'claude' }), '', 'the default value of ENFORCER_HARNESS proves nothing');
  assert.equal(runningHarness({}), '', 'Codex today: same hooks, no marker');
});

// The hook itself: Claude Code's SessionStart JSON in, one attribution out,
// and the process exits promptly with the usual empty answer.
const hook = fileURLToPath(new URL('../hooks/session.mjs', import.meta.url));
// The harness markers are the test's to set, never inherited from whatever ran
// the suite (a Claude Code session exports CLAUDECODE=1).
const { CLAUDECODE: _cc, ENFORCER_HARNESS: _eh, ...cleanEnv } = process.env;
const runHook = (ev, env = { CLAUDECODE: '1' }) =>
  new Promise((resolve) => {
    // spawn, not spawnSync: the stub server lives in THIS process's event loop.
    const t0 = Date.now();
    const p = spawn(process.execPath, [hook], { env: { ...cleanEnv, HOME: home, ...env } });
    let out = '';
    p.stdout.on('data', (c) => {
      out += c;
    });
    p.on('close', (code) => resolve({ code, out, took: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(ev));
  });

await ok("SessionStart hook: sends the session's attribution once and answers as before", async () => {
  setConfig({ clients: { '/w/acme-api': 'acme' } });
  const r = await runHook({ hook_event_name: 'SessionStart', session_id: '0f3c9a1b-2222-4333-8444-555566667777', cwd: '/w/acme-api' });
  assert.equal(r.code, 0);
  const { systemMessage, ...answer } = JSON.parse(r.out);
  assert.deepEqual(answer, { hookSpecificOutput: { hookEventName: 'SessionStart', env: { ENFORCER_GOVERNOR: '1' } } });
  assert.match(systemMessage, /^Decisioning: (ON|OFF)/);
  assert.deepEqual(
    posts.map((p) => p.body),
    [{ agent: 'claude:0f3c9a1b', client: 'acme', harness: 'claude-code', session_id: '0f3c9a1b-2222-4333-8444-555566667777' }],
  );
  setConfig({});
});

await ok('SessionStart hook under Grok announces grok-cli; with no marker (Codex) it announces nothing', async () => {
  setConfig({ clients: { '/w/acme-api': 'acme' } });
  const ev = { hook_event_name: 'SessionStart', session_id: '0f3c9a1b-2222-4333-8444-555566667777', cwd: '/w/acme-api' };
  await runHook(ev, { ENFORCER_HARNESS: 'grok' });
  await runHook(ev, {});
  assert.deepEqual(
    posts.map((p) => p.body),
    [
      { agent: 'claude:0f3c9a1b', client: 'acme', harness: 'grok-cli', session_id: ev.session_id },
      { agent: 'claude:0f3c9a1b', client: 'acme' },
    ],
  );
  setConfig({});
});

await ok('SessionStart hook with no session id sends nothing (no one session to name)', async () => {
  const r = await runHook({ hook_event_name: 'SessionStart', cwd: '/w/acme-api' });
  assert.equal(r.code, 0);
  assert.equal(posts.length, 0);
});

await ok('SessionStart hook against a hung server still exits within the timeout', async () => {
  mode = 'hang';
  const r = await runHook({ hook_event_name: 'SessionStart', session_id: 'aaaabbbb-2222-4333-8444-555566667777', cwd: '/w/acme-api' });
  assert.equal(r.code, 0);
  assert.equal(posts.length, 1);
  assert.ok(r.took < ATTRIBUTION_TIMEOUT_MS + 2500, `hook took ${r.took}ms`);
});

await ok('SessionEnd sends no attribution', async () => {
  const r = await runHook({ hook_event_name: 'SessionEnd', session_id: '0f3c9a1b-2222-4333-8444-555566667777', cwd: '/w/acme-api' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '', 'SessionEnd has no hookSpecificOutput; Claude Code rejects any JSON for it');
  assert.equal(posts.length, 0);
});

// ── subagents are their own agents ──────────────────────────────────────────
const { toolEvent, agentOf } = await import('../adapters/claude-code/events.mjs');
const { governor: ccGov } = await import('../adapters/claude-code/index.mjs');
const cc = ccGov();
const SID = '0f3c9a1b-2222-4333-8444-555566667777';
const tdir = mkdtempSync(join(tmpdir(), 'gov-sub-'));
const parentT = join(tdir, SID + '.jsonl');
const subDir = join(tdir, SID, 'subagents');
mkdirSync(subDir, { recursive: true });
const usageLine = (id, out) =>
  JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: out } } }) + '\n';
const call = (extra, cmd = 'git status') =>
  cc.before(
    toolEvent({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: cmd },
      session_id: SID,
      transcript_path: parentT,
      cwd: '/w/acme-api',
      ...extra,
    }),
  );

await ok('two subagents, identical calls, all allowed', async () => {
  assert.equal(agentOf({ session_id: SID }), 'claude:0f3c9a1b');
  assert.notEqual(agentOf({ session_id: SID, agent_id: 'aaaa1111x' }), agentOf({ session_id: SID, agent_id: 'bbbb2222y' }));
  // Three identical calls from each agent are all allowed...
  for (let i = 0; i < 3; i++) {
    for (const id of ['aaaa1111x', 'bbbb2222y', undefined]) {
      const { verdict } = await call(id ? { agent_id: id } : {});
      assert.equal(verdict.action, 'allow', `${id || 'parent'} call ${i}: ${verdict.reason}`);
    }
  }
});

await ok('subagent budget is its own', async () => {
  // The parent has spent a fortune; a subagent must not inherit that.
  writeFileSync(parentT, usageLine('p1', 50_000_000));
  writeFileSync(join(subDir, 'agent-cccc3333z.jsonl'), usageLine('s1', 10));
  writeFileSync(join(subDir, 'agent-dddd4444w.jsonl'), usageLine('s2', 50_000_000));
  const sub = await call({ agent_id: 'cccc3333z' }, 'ls a');
  assert.equal(sub.verdict.action, 'allow', sub.verdict.reason);
  assert.ok(sub.spend.tokens < 1000, 'metered from its own transcript: ' + sub.spend.tokens);
  const big = await call({ agent_id: 'dddd4444w' }, 'ls b');
  assert.equal(big.verdict.action, 'deny', 'the subagent that spent it is stopped');
  const again = await call({ agent_id: 'cccc3333z' }, 'ls c');
  assert.equal(again.verdict.action, 'allow', 'its sibling is not');
});

for (const res of hung) {
  try {
    res.destroy();
  } catch {}
}
srv.close();
srv.closeAllConnections?.();
console.log(`\n  ${pass} passed`);
