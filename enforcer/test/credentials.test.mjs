// The edge credential, and specifically that its identifier is not the key.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-cred-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ENFORCER_API_KEY;
// Hermetic: a worker or CI shell may export these, and they would point the
// credential lookup outside the temp HOME this test builds.
delete process.env.GOVERNOR_HOME;
delete process.env.ENFORCER_HOME;
delete process.env.ENFORCER_PROFILE;
mkdirSync(join(home, '.enforcer-governor'), { recursive: true });

let pass = 0;
const ok = (label, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + label);
};
const okAsync = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};
const KEY = 'env3_' + 'x'.repeat(43);

const { enforcerKey, keyId, isFederated, authHeaders, saveCredentials, readCredentials, SHARED_DIR } = await import('../src/credentials.mjs');

ok('unauthenticated is a normal state, not an error', () => {
  // The governor enforces locally with no account at all; a credential only
  // buys federation.
  assert.equal(enforcerKey(), null);
  assert.equal(isFederated(), false);
  assert.equal(keyId(), null);
});

ok('reads a saved credential', () => {
  writeFileSync(join(home, '.enforcer-governor', 'credentials.json'), JSON.stringify({ enforcer: { api_key: KEY } }));
  assert.equal(enforcerKey(), KEY);
  assert.equal(isFederated(), true);
});

ok('the environment wins, for CI and containers', () => {
  process.env.ENFORCER_API_KEY = 'env3_fromenv';
  assert.equal(enforcerKey(), 'env3_fromenv');
  delete process.env.ENFORCER_API_KEY;
});

ok('key_id carries no key material', () => {
  // This value goes into every receipt and every log line, where it outlives
  // the key and travels further than it does.
  const id = keyId(KEY);
  assert.ok(id.startsWith('env3_'));
  assert.equal(id.includes('xxxxxx'), false, 'truncation would leak the secret');
  assert.ok(!KEY.includes(id.split('_')[1]), 'the id must not be a substring of the key');
});

ok('key_id is stable for the same key', () => {
  assert.equal(keyId(KEY), keyId(KEY));
  assert.notEqual(keyId(KEY), keyId('env3_' + 'y'.repeat(43)));
});

ok('malformed credentials do not throw', () => {
  writeFileSync(join(home, '.enforcer-governor', 'credentials.json'), 'not json');
  assert.equal(enforcerKey(), null);
});

const seedOauth = (endpoint) =>
  saveCredentials({
    enforcer: {
      oauth: {
        access_token: 'old',
        refresh_token: 'r1',
        client_id: 'c',
        token_endpoint: endpoint,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    },
  });

await okAsync('parallel refresh: one network call, both callers see the rotated pair', async () => {
  process.env.HOME = home;
  process.env.ENFORCER_HOME = join(home, '.enforcer');
  seedOauth('https://api.instruxi.dev/oauth/token');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 900 }) };
  };
  const [a, b] = await Promise.all([authHeaders({ fetchImpl }), authHeaders({ fetchImpl })]);
  assert.equal(calls, 1);
  assert.equal(a.Authorization, 'Bearer new');
  assert.equal(b.Authorization, 'Bearer new');
  assert.equal(readCredentials().enforcer.oauth.refresh_token, 'r2');
  if (process.platform !== 'win32') assert.equal(statSync(SHARED_DIR()).mode & 0o777, 0o700); // POSIX modes do not exist on Windows
});

await okAsync('http token_endpoint is refused', async () => {
  seedOauth('http://api.instruxi.dev/oauth/token');
  let calls = 0;
  const h = await authHeaders({
    fetchImpl: async () => {
      calls++;
      return { ok: false };
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(h, {});
});

await okAsync('token_endpoint on a foreign origin is refused', async () => {
  seedOauth('https://evil.example/token');
  let calls = 0;
  const h = await authHeaders({
    fetchImpl: async () => {
      calls++;
      return { ok: false };
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(h, {});
});

await okAsync('a held lock times out and the stale token is used', async () => {
  seedOauth('https://api.instruxi.dev/oauth/token');
  mkdirSync(join(SHARED_DIR(), '.refresh.lock'));
  let calls = 0;
  const h = await authHeaders({
    fetchImpl: async () => {
      calls++;
      return { ok: false };
    },
  });
  assert.equal(calls, 0);
  assert.equal(h.Authorization, 'Bearer old');
});

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const future = () => new Date(Date.now() + 30_000).toISOString(); // inside the refresh skew, not yet expired
const seedSoon = () => {
  try {
    rmdirSync(join(SHARED_DIR(), '.refresh.lock'));
  } catch {}
  seedOauth('https://api.instruxi.dev/oauth/token');
  const d = readCredentials();
  d.enforcer.oauth.expires_at = future();
  saveCredentials(d);
};

await okAsync('timeout keeps the old token', async () => {
  seedSoon();
  const fetchImpl = async () => {
    const e = new Error('t');
    e.name = 'TimeoutError';
    throw e;
  };
  const h = await authHeaders({ fetchImpl, backoffMs: 1 });
  assert.equal(h.Authorization, 'Bearer old');
  const o = readCredentials().enforcer.oauth;
  assert.equal(o.refresh_token, 'r1');
  assert.equal(o.access_token, 'old');
  assert.match(o.last_refresh_error.reason, /transient: TimeoutError/);
});

await okAsync('5xx keeps the old token and retries once', async () => {
  seedSoon();
  let calls = 0;
  const h = await authHeaders({
    fetchImpl: async () => {
      calls++;
      return resp(503, {});
    },
    backoffMs: 1,
  });
  assert.equal(calls, 2);
  assert.equal(h.Authorization, 'Bearer old');
  assert.equal(readCredentials().enforcer.oauth.refresh_token, 'r1');
});

await okAsync('invalid_grant signs out (after one retry)', async () => {
  seedSoon();
  let calls = 0;
  const h = await authHeaders({
    fetchImpl: async () => {
      calls++;
      return resp(400, { error: 'invalid_grant' });
    },
    backoffMs: 1,
  });
  assert.equal(calls, 2);
  assert.deepEqual(h, {});
  assert.match(readCredentials().enforcer.oauth.last_refresh_error.reason, /signed out: HTTP 400 invalid_grant/);
});

await okAsync('lost response after rotation recovers', async () => {
  seedSoon();
  // The server rotates r1 -> r2 and answers a replay of the last-used token with the same pair.
  let rotated = null;
  let drop = true;
  const fetchImpl = async (_u, { body }) => {
    const rt = new URLSearchParams(body).get('refresh_token');
    if (rt === 'r1') rotated = { access_token: 'new', refresh_token: 'r2', expires_in: 900 };
    else if (rt !== 'r2' || !rotated) return resp(400, { error: 'invalid_grant' });
    if (drop) {
      drop = false;
      const e = new Error('t');
      e.name = 'TimeoutError';
      throw e;
    } // response lost
    return resp(200, rotated);
  };
  const first = await authHeaders({ fetchImpl, backoffMs: 1 });
  assert.equal(first.Authorization, 'Bearer new'); // the in-call retry got the replay
  assert.equal(readCredentials().enforcer.oauth.refresh_token, 'r2');
  // and a client that never got any answer still holds r1, which the server replays
  seedSoon();
  drop = true;
  const second = await authHeaders({
    fetchImpl: async (u, o) => {
      if (drop) {
        drop = false;
        throw new Error('lost');
      }
      return fetchImpl(u, o);
    },
    backoffMs: 1,
  });
  assert.equal(second.Authorization, 'Bearer new');
});

console.log(`\n  ${pass} passed, 0 failed\n  fail 0`);
