// A caller killed in the middle of an OAuth refresh must not sign the machine out.
//
// The incident (2026-11-12): several Claude Code sessions on one machine, each running the plugin's
// hooks and headers helpers against ~/.enforcer/credentials.json. Minutes after each sign-in the
// refresh failed with "signed out: HTTP 400 invalid_grant" while refresh_expires_at was a month out.
// enforcer-v3's log showed, per family: "concurrent refresh within grace window — sibling successor
// minted", then "refresh token reuse detected — revoking family" for the family whose rotated-out
// token was still on disk. The rotated pair had been lost by the process that asked for it: a hook
// killed at its timeout, or one that exits (bin/enforcer `event`) once its deadline race is lost,
// after the server committed the rotation and before the file was written.
//
// The token server here keeps enforcer-v3's rules (internal/usecase/auth/tokens.go loadRefresh):
// a refresh token is single-use; a rotated-out token presented again within the grace window gets
// ONE sibling, a second presentation in the window is refused, and one after the window revokes
// the whole family. It holds its answer after committing a rotation so the test can kill the
// caller exactly inside the window that loses the pair.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform === 'win32') {
  console.log('  skip  POSIX process groups (kill -PGID) are what this suite exercises');
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRACE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the token server -------------------------------------------------------------------------
let seq = 0;
const tokens = new Map(); // token -> { family, current, supersededAt, forked }
const revoked = new Set(); // families
const log = [];
let hold = null; // { committed: resolve } while the next rotation's answer is to be held
const mint = (family) => {
  const t = `rt-${family}-${++seq}`;
  tokens.set(t, { family, current: true, supersededAt: null, forked: false });
  return t;
};
const pair = (family) => ({ access_token: `at-${family}-${seq + 1}`, refresh_token: mint(family), expires_in: 900, token_type: 'Bearer' });
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const rt = new URLSearchParams(body).get('refresh_token');
    const send = (status, j) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    const row = tokens.get(rt);
    if (!row || revoked.has(row.family)) {
      log.push('unknown_or_revoked');
      return send(400, { error: 'invalid_grant' });
    }
    if (!row.current) {
      if (Date.now() - row.supersededAt <= GRACE_MS) {
        if (!row.forked) {
          row.forked = true;
          log.push('fork');
          return send(200, pair(row.family));
        }
        log.push('race');
        return send(400, { error: 'invalid_grant' });
      }
      revoked.add(row.family);
      log.push('reuse_revoked_family');
      return send(400, { error: 'invalid_grant' });
    }
    row.current = false;
    row.supersededAt = Date.now();
    const answer = pair(row.family);
    log.push('rotate');
    if (hold) {
      // committed server-side; the answer is held so the caller can die before it arrives
      const h = hold;
      hold = null;
      h.committed();
      await sleep(1500);
    }
    try {
      send(200, answer);
    } catch {
      /* caller gone */
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- a machine: HOME with credentials.json, and callers that run authHeaders -------------------
const base = mkdtempSync(join(tmpdir(), 'refresh-kill-'));
const CALLER = join(base, 'caller.mjs');
writeFileSync(
  CALLER,
  [
    `import { authHeaders } from ${JSON.stringify(pathToFileURL(join(root, 'src', 'credentials.mjs')).href)};`,
    'const h = await authHeaders({ skewMs: Number(process.argv[2]) || undefined });',
    'process.stdout.write(JSON.stringify({ auth: h.Authorization ? h.Authorization.slice(7) : null }));',
    '',
  ].join('\n'),
);

let n = 0;
function machine() {
  const home = join(base, `home-${++n}`);
  mkdirSync(join(home, '.enforcer'), { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ENFORCER_HOME: join(home, '.enforcer'), ENFORCER_BASE_URL: BASE };
  delete env.ENFORCER_API_KEY;
  const file = join(home, '.enforcer', 'credentials.json');
  const family = `f${n}`;
  const rt = mint(family);
  writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      enforcer: {
        base_url: BASE,
        oauth: {
          access_token: `at-${family}-0`,
          refresh_token: rt,
          client_id: 'c',
          token_endpoint: `${BASE}/oauth/token`,
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
      },
    }),
    { mode: 0o600 },
  );
  const read = async () => JSON.parse(readFileSync(file, 'utf8')).enforcer.oauth;
  return { env, read, family, rt };
}
// One caller, in its own process group (as a hook is in the harness's), so the test can kill the group.
const call = (m, { inProcess, skewMs } = {}) => {
  const env = { ...m.env };
  if (inProcess) env.ENFORCER_REFRESH_INPROCESS = '1';
  else delete env.ENFORCER_REFRESH_INPROCESS;
  const child = spawn(process.execPath, [CALLER, String(skewMs || '')], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const done = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, out: out ? JSON.parse(out) : null })));
  return { child, done };
};
const killedMidRefresh = async (m, opts) => {
  const committed = new Promise((r) => (hold = { committed: r }));
  const c = call(m, opts);
  await committed; // the server has rotated the token; its answer is still in flight
  process.kill(-c.child.pid, 'SIGKILL'); // the harness kills the hook (its whole process group)
  return c.done;
};
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
};

let pass = 0;
const okAsync = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};

try {
  await okAsync('reproduction: refreshing in the caller, a killed caller loses the pair and the next refresh revokes the family', async () => {
    const m = machine();
    const r = await killedMidRefresh(m, { inProcess: true });
    assert.equal(r.signal, 'SIGKILL');
    await sleep(GRACE_MS + 100);
    assert.equal((await m.read()).refresh_token, m.rt, 'the rotated-out token is still on disk');
    const next = await call(m, { inProcess: true }).done;
    assert.equal(next.out.auth, null, 'signed out');
    assert.ok(revoked.has(m.family), 'the server revoked the family');
    assert.match((await m.read()).last_refresh_error.reason, /signed out: HTTP 400 invalid_grant/);
  });

  await okAsync('fix: the detached refresher saves the rotated pair although its caller was killed', async () => {
    const m = machine();
    const r = await killedMidRefresh(m, {});
    assert.equal(r.signal, 'SIGKILL');
    const o = await until(async () => {
      const x = await m.read();
      return x.refresh_token !== m.rt ? x : null;
    });
    assert.ok(o, 'the successor reached the file');
    assert.equal(o.last_refresh_error, undefined);
    await sleep(GRACE_MS + 100);
    // the next caller is served the saved token, and the family still refreshes (no reuse anywhere)
    const next = await call(m, {}).done;
    assert.equal(next.out.auth, o.access_token);
    const forced = await call(m, { skewMs: 3_600_000 }).done; // refresh again now
    assert.ok(forced.out.auth && forced.out.auth !== o.access_token, 'refreshed with the saved successor');
    assert.ok(!revoked.has(m.family), 'the family is alive');
  });

  await okAsync('fix: concurrent callers on one machine rotate once and all get the new token', async () => {
    const m = machine();
    const before = log.length;
    const outs = await Promise.all(Array.from({ length: 6 }, () => call(m, {}).done));
    const o = await m.read();
    assert.notEqual(o.refresh_token, m.rt);
    for (const r of outs) assert.equal(r.out.auth, o.access_token);
    assert.deepEqual(log.slice(before), ['rotate'], 'one rotation, no forks, no reuse');
    assert.ok(!revoked.has(m.family));
  });
} finally {
  server.close();
}

console.log(`\n  ${pass} passed, 0 failed\n  fail 0`);
