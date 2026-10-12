// Switching sign-ins: a replacing sign-in revokes the previous access token so
// the tool server 401s and reconnects; a fake issuer through fetchImpl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-login-switch-'));
process.env.HOME = home;
process.env.ENFORCER_HOME = join(home, '.enforcer');
process.env.GOVERNOR_HOME = join(home, '.g');

const { replacementNotice, RECONNECT_LINE } = await import('../bin/login.mjs');
const base = 'http://issuer.test';
const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeIssuer({ revocation = true, revokeStatus = 200, throwOnRevoke = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? new URLSearchParams(opts.body).get('token') : null });
    if (String(url).endsWith('/.well-known/oauth-authorization-server')) {
      return res(200, { issuer: base, token_endpoint: base + '/token', ...(revocation ? { revocation_endpoint: base + '/revoke' } : {}) });
    }
    if (String(url) === base + '/revoke') {
      if (throwOnRevoke) throw new Error('network down');
      return res(revokeStatus);
    }
    return res(404);
  };
  return { calls, fetchImpl };
}
const oldCred = { access_token: 'old-token', client_id: 'c1' };
const newCred = { access_token: 'new-token', client_id: 'c1' };
const revokes = (calls) => calls.filter((c) => c.url === base + '/revoke');

test('a replacing sign-in revokes the previous token', async () => {
  const { calls, fetchImpl } = fakeIssuer();
  const lines = await replacementNotice(oldCred, newCred, base, fetchImpl);
  assert.equal(revokes(calls).length, 1);
  assert.equal(revokes(calls)[0].body, 'old-token');
  assert.ok(lines.includes(RECONNECT_LINE));
});

test('a first sign-in revokes nothing', async () => {
  const { calls, fetchImpl } = fakeIssuer();
  const lines = await replacementNotice(null, newCred, base, fetchImpl);
  assert.equal(calls.length, 0);
  assert.deepEqual(lines, []);
});

test('a revocation failure still completes the login', async () => {
  for (const opts of [{ throwOnRevoke: true }, { revokeStatus: 500 }]) {
    const { fetchImpl } = fakeIssuer(opts);
    const lines = await replacementNotice(oldCred, newCred, base, fetchImpl);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], RECONNECT_LINE);
  }
  const none = fakeIssuer({ revocation: false });
  const lines = await replacementNotice(oldCred, newCred, base, none.fetchImpl);
  assert.equal(revokes(none.calls).length, 0);
  assert.match(lines[0], /no revocation endpoint/);
});

test('the reconnect line prints only when the credential was replaced', async () => {
  const { fetchImpl } = fakeIssuer();
  assert.ok(!(await replacementNotice(null, newCred, base, fetchImpl)).includes(RECONNECT_LINE));
  assert.ok(!(await replacementNotice(oldCred, oldCred, base, fetchImpl)).includes(RECONNECT_LINE));
  assert.ok((await replacementNotice(oldCred, newCred, base, fetchImpl)).includes(RECONNECT_LINE));
});
