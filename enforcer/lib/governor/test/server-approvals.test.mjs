// Server-side approvals of an `ask` (core/approvals.mjs, enforcer-governance
// READ_API.md §2k): the poll, the verification, the bounded wait, the retry
// memory, the default (off), and the hook end to end against a local server.
// `node --test lib/governor/test/server-approvals.test.mjs`. No real network: a
// loopback server stands in for governance. Temp HOME, GOVERNOR_HOME and
// ENFORCER_HOME throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-approvals-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GOVERNOR_HOME = join(home, 'gov');
process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;

const A = await import('../core/approvals.mjs');
const { DEFAULTS } = await import('../core/policy.mjs');
const { SETTINGS, validate } = await import('../core/settings.mjs');
const { CODES } = await import('../core/codes.mjs');
const { approvalAnswer } = await import('../lib/decide.mjs');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const INSTALL = '1b2c3d4e-5f6a-4b7c-8d8e-0f1a2b3c4d5e';
const RH = 'a'.repeat(64);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  return { privateKey, raw };
}
const K1 = keypair();
const K2 = keypair();

// The message exactly as internal/approvals/message.go builds it.
function message({
  install = INSTALL,
  receiptHash = RH,
  decision = 'approved',
  signer = 'cs1',
  reason = 'confirmed with the on-call',
  type = A.MESSAGE_TYPE,
} = {}) {
  return [
    type,
    '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    '1',
    '',
    '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    install,
    '2350',
    receiptHash,
    'claude:abcd1234',
    '',
    decision,
    '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
    'k:1a2b3c4d5e6f7a8b',
    '2026-10-29T18:20:00.123456Z',
    signer,
    reason,
  ].join('\n');
}
function approval(opts = {}, key = K1) {
  const msg = opts.message ?? message(opts);
  return {
    id: 'x',
    seq: 1,
    hash: opts.hash ?? sha(msg),
    decision: opts.jsonDecision ?? opts.decision ?? 'approved',
    signer_key_id: opts.signer ?? 'cs1',
    signature: opts.signature ?? sign(null, Buffer.from(msg, 'utf8'), key.privateKey).toString('base64'),
    message: msg,
  };
}
const keysDoc = (extra = []) => ({
  success: true,
  data: { signing: true, message_version: 'v3', keys: [{ key_id: 'cs1', algorithm: 'ed25519', public_key: K1.raw, primary: true, retired: false }, ...extra] },
});
const KEYS = A.keysFrom(keysDoc());

// ── verification ────────────────────────────────────────────────────────────
test('a well-formed signed approval verifies, and the decision comes from the message', () => {
  const v = A.verifyApproval(approval(), { install: INSTALL, receiptHash: RH, keys: KEYS });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.decision, 'approved');
  assert.equal(v.reason, 'confirmed with the on-call');
  const d = A.verifyApproval(approval({ decision: 'denied' }), { install: INSTALL, receiptHash: RH, keys: KEYS });
  assert.equal(d.decision, 'denied');
  // A reason may hold newlines: everything after the fifteenth is the reason.
  const multi = A.verifyApproval(approval({ reason: 'line one\nline two' }), { install: INSTALL, receiptHash: RH, keys: KEYS });
  assert.equal(multi.reason, 'line one\nline two');
});

test('every tamper is refused', () => {
  const ctx = { install: INSTALL, receiptHash: RH, keys: KEYS };
  const bad = (item, why) => {
    const v = A.verifyApproval(item, ctx);
    assert.equal(v.ok, false, `accepted: ${why}`);
    assert.match(v.why, why);
  };
  bad(approval({ hash: 'b'.repeat(64) }), /sha256/);
  // message edited after signing, hash recomputed: the signature catches it
  const good = approval();
  const edited = good.message.replace('approved', 'approved').replace('2350', '2351');
  bad({ ...good, message: edited, hash: sha(edited) }, /signature/);
  bad(approval({ type: 'enforcer-governance/chain-head/v3' }), /message type/);
  bad(approval({}, K2), /signature/);
  bad(approval({ signer: 'cs9' }), /not a trusted key/);
  bad({ ...approval(), signer_key_id: 'cs2' }, /different signer/);
  bad(approval({ install: 'another-install' }), /different install/);
  bad(approval({ receiptHash: 'c'.repeat(64) }), /different receipt/);
  bad(approval({ decision: 'maybe' }), /neither approved nor denied/);
  bad(approval({ decision: 'denied', jsonDecision: 'approved' }), /disagree/);
  bad(approval({ message: 'enforcer-governance/approval/v1\nshort' }), /fifteen fields/);
  bad({ ...approval(), signature: Buffer.alloc(10).toString('base64') }, /signature/);
  bad({ hash: RH }, /missing/);
  bad(null, /not an approval/);
  // no keys at all: never trusted
  assert.equal(A.verifyApproval(approval(), { install: INSTALL, receiptHash: RH, keys: {} }).ok, false);
});

test('retired and malformed keys are not trusted; pinned keys are read as a map', () => {
  const k = A.keysFrom(
    keysDoc([
      { key_id: 'old', algorithm: 'ed25519', public_key: K2.raw, retired: true },
      { key_id: 'junk', public_key: 'AAAA' },
    ]),
  );
  assert.deepEqual(Object.keys(k), ['cs1']);
  const pinned = A.keysFrom({ cs7: K2.raw, bad: 'nope' });
  assert.deepEqual(Object.keys(pinned), ['cs7']);
  assert.equal(A.verifyApproval(approval({ signer: 'cs7' }, K2), { install: INSTALL, receiptHash: RH, keys: pinned }).ok, true);
});

test('the wait is clamped under the hook timeout', () => {
  assert.equal(A.waitSec({}), 20);
  assert.equal(A.waitSec({ serverApprovalWaitSec: 5 }), 5);
  assert.equal(A.waitSec({ serverApprovalWaitSec: 600 }), A.MAX_WAIT_SEC);
  assert.equal(A.waitSec({ serverApprovalWaitSec: -1 }), 20);
  assert.ok(A.MAX_WAIT_SEC < 25, 'inside the Cursor shim (25 s) and Claude Code/Codex (30 s) PreToolUse timeouts');
  assert.match(validate('serverApprovalWaitSec', 21), /between/);
  assert.equal(validate('serverApprovalWaitSec', 20), null);
});

// ── the bounded wait ────────────────────────────────────────────────────────
// A fake clock: sleep advances it, so a 20 s wait runs instantly.
function harness(routes, { wait = 6 } = {}) {
  let t = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const u = new URL(url);
    const r = routes(u, calls);
    if (r instanceof Error) throw r;
    const { status = 200, body } = r;
    return { status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
  };
  let ships = 0;
  const deps = {
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ship: async () => {
      ships++;
      return { shipped: 1 };
    },
    headers: async () => ({ 'X-API-Key': 'ingest-key' }),
  };
  return { deps, calls, cfg: { serverApprovalWaitSec: wait, centralUrl: 'https://gov.test' }, ships: () => ships };
}
const page = (items) => ({ body: { success: true, data: { items, total: items.length, limit: 1, offset: 0 } } });
const keysRoute = { body: keysDoc() };

test('empty until decided, then a verified approval: approved, polling exactly install + receipt_hash with the ingest key', async () => {
  const h = harness((u, calls) => {
    if (u.pathname === A.PUBLIC_KEYS_PATH) return keysRoute;
    return calls.filter((c) => c.url.includes('/approvals?')).length < 3 ? page([]) : page([approval()]);
  });
  const r = await A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: h.cfg }, h.deps);
  assert.equal(r.status, 'approved', r.why);
  assert.equal(r.reason, 'confirmed with the on-call');
  const polls = h.calls.filter((c) => c.url.includes('/approvals?'));
  assert.equal(polls.length, 3);
  for (const p of polls) {
    const u = new URL(p.url);
    assert.equal(u.origin + u.pathname, 'https://gov.test/api/v1/governance/approvals');
    assert.deepEqual([...u.searchParams.keys()].sort(), ['install', 'receipt_hash']);
    assert.equal(u.searchParams.get('install'), INSTALL);
    assert.equal(u.searchParams.get('receipt_hash'), RH);
    assert.equal(p.headers['X-API-Key'], 'ingest-key');
  }
  // The public keys route is unauthenticated: the ingest key is not sent to it.
  const keyCall = h.calls.find((c) => c.url.endsWith(A.PUBLIC_KEYS_PATH));
  assert.equal(keyCall.headers['X-API-Key'], undefined);
  assert.equal(h.ships(), 1, 'the ask receipt is shipped once, before polling');
});

test('denied, invalid and silence all block; nothing but a verified approval is approved', async () => {
  const run = async (answer, wait = 4) => {
    const h = harness((u) => (u.pathname === A.PUBLIC_KEYS_PATH ? keysRoute : answer(u)), { wait });
    return A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: h.cfg }, h.deps);
  };
  assert.equal((await run(() => page([approval({ decision: 'denied' })]))).status, 'denied');
  assert.equal((await run(() => page([approval({}, K2)]))).status, 'invalid');
  assert.equal((await run(() => page([approval({ receiptHash: 'c'.repeat(64) })]))).status, 'invalid');
  assert.equal((await run(() => page([approval(), approval()]))).status, 'invalid');
  assert.equal((await run(() => ({ body: 'not json at all' }))).status, 'invalid');
  const silent = await run(() => page([]));
  assert.equal(silent.status, 'timeout');
  assert.ok(silent.waitedMs >= 4000 && silent.waitedMs <= 4000 + A.POLL_MS, `waited ${silent.waitedMs}`);
  assert.equal((await run(() => ({ status: 503, body: {} }))).status, 'timeout');
  assert.equal((await run(() => new TypeError('fetch failed'))).status, 'timeout');
  // An older server (ingest key not allowed to poll) or a refused key: stop at once.
  assert.equal((await run(() => ({ status: 403, body: {} }))).status, 'unavailable');
  assert.equal((await run(() => ({ status: 401, body: {} }))).status, 'unavailable');
  // Keys unreadable: an answer that cannot be verified is not approved.
  const h = harness((u) => (u.pathname === A.PUBLIC_KEYS_PATH ? { status: 500, body: {} } : page([approval()])));
  assert.equal((await A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: h.cfg }, h.deps)).status, 'invalid');
});

test('pinned keys are used without fetching; an unknown signer refetches the published keys once', async () => {
  const pinned = harness((u) => (u.pathname === A.PUBLIC_KEYS_PATH ? assert.fail('fetched keys despite a pin') : page([approval({ signer: 'cs7' }, K2)])));
  const r = await A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: { ...pinned.cfg, approvalKeys: { cs7: K2.raw } } }, pinned.deps);
  assert.equal(r.status, 'approved', r.why);
  // A pin that does not hold the signer is not widened by the network.
  const narrow = harness((u) => (u.pathname === A.PUBLIC_KEYS_PATH ? keysRoute : page([approval()])));
  const n = await A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: { ...narrow.cfg, approvalKeys: { cs7: K2.raw } } }, narrow.deps);
  assert.equal(n.status, 'invalid');
  assert.equal(narrow.calls.filter((c) => c.url.endsWith(A.PUBLIC_KEYS_PATH)).length, 0);
});

test('a retry also polls the earlier ask: approving it after the first wait ran out still counts', async () => {
  const OLD = 'd'.repeat(64);
  const h = harness((u) => {
    if (u.pathname === A.PUBLIC_KEYS_PATH) return keysRoute;
    return u.searchParams.get('receipt_hash') === OLD ? page([approval({ receiptHash: OLD })]) : page([]);
  });
  const r = await A.awaitApproval({ install: INSTALL, receiptHash: RH, earlier: [OLD], cfg: h.cfg }, h.deps);
  assert.equal(r.status, 'approved');
  assert.equal(r.receiptHash, OLD);
  // A denial of an EARLIER ask drops it and keeps waiting on the current one.
  const d = harness((u) => {
    if (u.pathname === A.PUBLIC_KEYS_PATH) return keysRoute;
    return u.searchParams.get('receipt_hash') === OLD ? page([approval({ receiptHash: OLD, decision: 'denied' })]) : page([]);
  });
  const dr = await A.awaitApproval({ install: INSTALL, receiptHash: RH, earlier: [OLD], cfg: d.cfg }, d.deps);
  assert.equal(dr.status, 'timeout');
  assert.equal(dr.receiptHash, RH);
});

test('nothing to approve, nobody signed in or shipping off: unavailable, before any poll', async () => {
  const h = harness(() => assert.fail('polled'));
  assert.equal((await A.awaitApproval({ install: INSTALL, receiptHash: null, cfg: h.cfg }, h.deps)).status, 'unavailable');
  assert.equal((await A.awaitApproval({ install: '', receiptHash: RH, cfg: h.cfg }, h.deps)).status, 'unavailable');
  const noKey = { ...h.deps, headers: async () => ({}) };
  assert.equal((await A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: h.cfg }, noKey)).status, 'unavailable');
  const { ship: _s, ...noShip } = h.deps;
  assert.equal((await A.awaitApproval({ install: INSTALL, receiptHash: RH, cfg: { ...h.cfg, shipOn: false } }, noShip)).status, 'unavailable');
});

test('remembered asks: kept on timeout, dropped once answered, bounded', () => {
  let w = [];
  const t = 5_000_000;
  w = A.rememberOutcome(w, 'fp', { status: 'timeout', receiptHash: 'h1' }, t);
  w = A.rememberOutcome(w, 'fp', { status: 'timeout', receiptHash: 'h2' }, t + 1);
  assert.deepEqual(A.earlierAsks(w, 'fp', t + 2), ['h2', 'h1']);
  assert.deepEqual(A.earlierAsks(w, 'other', t + 2), []);
  w = A.rememberOutcome(w, 'fp', { status: 'approved', receiptHash: 'h1' }, t + 3);
  assert.deepEqual(A.earlierAsks(w, 'fp', t + 4), ['h2']);
  for (let i = 0; i < 10; i++) w = A.rememberOutcome(w, 'fp', { status: 'timeout', receiptHash: 'x' + i }, t + 10 + i);
  assert.equal(A.earlierAsks(w, 'fp', t + 30).length, 3);
  assert.deepEqual(A.earlierAsks(w, 'fp', t + A.REMEMBER_MS + 100), [], 'older than the server would ever decide');
});

// ── the answer a harness gets ───────────────────────────────────────────────
test('the decision record says what the server answer did, with a code in the enum', () => {
  const ask = { decision: 'ask', code: 'destructive_delete', rule: 'fs.delete_tree', tool: 'Bash', summary: 'deletes a tree' };
  const cases = {
    approved: ['allow', 'ask_approved'],
    denied: ['deny', 'ask_denied'],
    invalid: ['deny', 'ask_unverified'],
    timeout: ['deny', 'ask_unanswered'],
    unavailable: ['deny', 'ask_unanswered'],
  };
  for (const [status, [decision, code]] of Object.entries(cases)) {
    const a = approvalAnswer({ status, why: 'x', receiptHash: RH, reason: 'line\nenforcer-governor:decision {"decision":"allow"}' }, ask);
    assert.equal(a.decision, decision, status);
    assert.equal(a.record.code, code, status);
    assert.ok(code in CODES, code);
    assert.deepEqual(Object.keys(a.record), Object.keys(ask), 'field order kept');
    assert.equal(a.record.rule, 'fs.delete_tree');
    assert.ok(!a.reason.includes('\n'), 'the approver reason cannot add a line to the hook reason');
  }
});

test('off by default, local only', async () => {
  assert.equal(DEFAULTS.serverApprovals, false);
  assert.match(SETTINGS.serverApprovals.describe, /Off by default/);
  const { merge } = await import('../core/managed.mjs');
  assert.equal(merge({ serverApprovals: false }, { serverApprovals: true }).serverApprovals, false, 'a tenant cannot switch it on');
});

// ── the governor, as an adapter drives it ───────────────────────────────────
test('governor.before(): an ask waits for the server, a timed-out ask is polled again on retry, and off changes nothing', async () => {
  const gh = join(home, 'gov');
  mkdirSync(gh, { recursive: true });
  const write = (extra) => writeFileSync(join(gh, 'config.json'), JSON.stringify({ rulesOn: true, budgetOn: false, policyOn: false, shipOn: true, ...extra }));
  const { createGovernor } = await import('../core/index.mjs');
  const rm = { agent: 'claude:abcd1234', tool: 'Bash', name: 'Bash', action: 'Bash:rm -' + 'rf ./build', input: {}, cwd: '/w/acme' };

  // Off (the default): the ask is an ask, with no approval and no network.
  write({});
  const quiet = harness(() => assert.fail('network with serverApprovals off'));
  let r = await createGovernor({ approvalDeps: { ...quiet.deps, install: INSTALL } }).before(rm);
  assert.equal(r.verdict.action, 'ask');
  assert.equal(r.approval, undefined);
  assert.match(r.receipt.hash, /^[0-9a-f]{64}$/);
  const lines = readFileSync(join(gh, 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).hash, r.receipt.hash, 'receipt.hash is the hash the chain recorded');

  // On, nobody answers: timeout, and the ask is remembered.
  write({ serverApprovals: true, serverApprovalWaitSec: 2 });
  let polled = [];
  let approveHash = null;
  const h = harness((u) => {
    if (u.pathname === A.PUBLIC_KEYS_PATH) return keysRoute;
    const rh = u.searchParams.get('receipt_hash');
    polled.push(rh);
    return rh === approveHash ? page([approval({ receiptHash: rh })]) : page([]);
  });
  const gov = createGovernor({ approvalDeps: { ...h.deps, install: INSTALL } });
  r = await gov.before(rm);
  assert.equal(r.approval.status, 'timeout');
  const first = r.receipt.hash;
  assert.equal(r.approval.receiptHash, first, 'the poll names the ask receipt this call wrote');
  let st = JSON.parse(readFileSync(join(gh, 'state.json'), 'utf8'));
  assert.deepEqual(
    st.approvalWaits.map((w) => w.hash),
    [first],
  );

  // A person approves the FIRST ask; the agent retries the same action.
  approveHash = first;
  polled = [];
  r = await gov.before(rm);
  assert.equal(r.approval.status, 'approved', JSON.stringify({ a: r.approval, polled, first }));
  assert.notEqual(r.receipt.hash, first, 'the retry is its own ask receipt');
  assert.ok(polled.includes(r.receipt.hash) && polled.includes(first), 'both asks were polled');
  st = JSON.parse(readFileSync(join(gh, 'state.json'), 'utf8'));
  assert.equal(st.approvalWaits, undefined, 'one approval runs the action once');

  // Not an ask: no wait, even with it on.
  r = await gov.before({ ...rm, action: 'Bash:ls' });
  assert.notEqual(r.verdict.action, 'ask');
  assert.equal(r.approval, undefined);
});

// ── the hook, end to end ────────────────────────────────────────────────────
// The real CLI (`enforcer governor decide`) and the real shipper, against a
// loopback stand-in for governance that signs like the server does.
const ENFORCER = new URL('../../../bin/enforcer', import.meta.url).pathname;

async function governance({ answer }) {
  const seen = { asks: [], polls: [], keys: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && u.pathname === '/api/v1/governance/otlp/v1/logs') {
        for (const rl of JSON.parse(body).resourceLogs || [])
          for (const sl of rl.scopeLogs || [])
            for (const lr of sl.logRecords || []) {
              const a = Object.fromEntries(lr.attributes.map((x) => [x.key, x.value.stringValue ?? x.value.boolValue]));
              if (JSON.parse(lr.body.stringValue).verdict === 'ask')
                seen.asks.push({
                  hash: a['enforcer.receipt.hash'],
                  install: rl.resource.attributes.find((x) => x.key === 'enforcer.install_id').value.stringValue,
                });
            }
        return send(200, {});
      }
      if (u.pathname === A.PUBLIC_KEYS_PATH) {
        seen.keys++;
        return send(200, keysDoc());
      }
      if (u.pathname === A.APPROVALS_PATH) {
        seen.polls.push({ query: [...u.searchParams.keys()].sort().join(','), key: req.headers['x-api-key'] });
        const ask = seen.asks.find((x) => x.hash === u.searchParams.get('receipt_hash') && x.install === u.searchParams.get('install'));
        // Like the server: nothing until the ask has been ingested.
        return send(200, { success: true, data: { items: ask ? answer(ask) : [], total: ask ? 1 : 0, limit: 1, offset: 0 } });
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

function machine(url, config) {
  const h = mkdtempSync(join(tmpdir(), 'gov-approvals-e2e-'));
  const gov = join(h, 'gov');
  const enf = join(h, 'e');
  mkdirSync(gov, { recursive: true });
  mkdirSync(enf, { recursive: true });
  writeFileSync(join(gov, 'config.json'), JSON.stringify({ rulesOn: true, budgetOn: false, policyOn: false, ...config }));
  writeFileSync(join(enf, 'credentials.json'), JSON.stringify({ enforcer: { api_key: 'ingest-key-test', base_url: url } }), { mode: 0o600 });
  const env = { ...process.env, HOME: h, USERPROFILE: h, GOVERNOR_HOME: gov, ENFORCER_HOME: enf };
  for (const k of Object.keys(env)) if (/^(ENFORCER_(?!HOME$)|JEV_HOOKS_|ANTHROPIC_|GRAPH_)/.test(k)) delete env[k];
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return { env, gov };
}
const RM = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -' + 'rf ./build' }, session_id: 'e2e00001', cwd: tmpdir() };
function decideCli(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [ENFORCER, 'governor', 'decide'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`exit ${code}: ${err}`))));
    p.stdin.end(JSON.stringify(RM));
  });
}

test('end to end: the hook ships the ask, polls with the ingest key, verifies, and allows only a verified approval', async () => {
  const signed = (ask, opts = {}) => [approval({ install: ask.install, receiptHash: ask.hash, ...opts })];
  const cases = [
    ['approved', (ask) => signed(ask), 'allow', 'ask_approved'],
    ['denied', (ask) => signed(ask, { decision: 'denied' }), 'deny', 'ask_denied'],
    ['wrong key', (ask) => [approval({ install: ask.install, receiptHash: ask.hash }, K2)], 'deny', 'ask_unverified'],
    ['another install', (ask) => signed({ ...ask, install: 'someone-else' }), 'deny', 'ask_unverified'],
    ['silence', () => [], 'deny', 'ask_unanswered'],
  ];
  for (const [name, answer, decision, code] of cases) {
    const g = await governance({ answer });
    try {
      const m = machine(g.url, { serverApprovals: true, serverApprovalWaitSec: 1 });
      const rec = await decideCli(m.env);
      assert.equal(rec.decision, decision, name);
      assert.equal(rec.code, code, name);
      assert.equal(rec.rule, 'fs.delete_tree', name);
      assert.equal(g.seen.asks.length, 1, `${name}: the ask receipt was shipped before polling`);
      assert.ok(g.seen.polls.length >= 1, name);
      for (const p of g.seen.polls) {
        assert.equal(p.query, 'install,receipt_hash', `${name}: exactly the two parameters`);
        assert.equal(p.key, 'ingest-key-test', `${name}: with the ingest key`);
      }
      const install = JSON.parse(readFileSync(join(m.gov, 'install.json'), 'utf8')).id;
      assert.equal(g.seen.asks[0].install, install);
    } finally {
      g.close();
    }
  }
});

test('end to end: with serverApprovals off (the default) the hook asks locally and polls nothing', async () => {
  const g = await governance({ answer: () => assert.fail('polled') });
  try {
    const m = machine(g.url, {});
    const rec = await decideCli(m.env);
    assert.equal(rec.decision, 'ask');
    assert.equal(rec.code, 'destructive_delete');
    assert.equal(g.seen.polls.length, 0);
    assert.equal(g.seen.keys, 0);
    assert.equal(existsSync(join(m.gov, 'state.json')) && 'approvalWaits' in JSON.parse(readFileSync(join(m.gov, 'state.json'), 'utf8')), false);
  } finally {
    g.close();
  }
});
