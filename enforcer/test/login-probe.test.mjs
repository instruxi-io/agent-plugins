// The probe after a browser sign-in: an HTTP 431 (token too large for the server's headers) fails the sign-in;
// anything else that is not an answer only warns. No network: the fetch is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'login-probe-'));
process.env.HOME = home;
process.env.ENFORCER_HOME = join(home, '.enforcer');
delete process.env.ENFORCER_API_KEY;

const { whoAmI, signInProbeResult } = await import('../bin/login.mjs');

const stub = (status, body = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
};
const TOKEN = `tok-${'x'.repeat(3530)}`;
const headers = { Authorization: `Bearer ${TOKEN}` };

test('a 431 from auth/me fails the sign-in and points at a smaller preset', async () => {
  const { calls, fetchImpl } = stub(431);
  const me = await whoAmI('http://enforcer.test', { headers, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://enforcer.test/api/v1/enforcer/auth/me');
  assert.equal(calls[0].init.headers.Authorization, headers.Authorization);
  assert.deepEqual(me, { error: 'HTTP 431', status: 431 });
  const r = signInProbeResult(me, { preset: 'admin', headerLength: headers.Authorization.length });
  assert.equal(r.fail, true);
  const text = r.lines.join('\n');
  assert.match(text, /^Sign-in failed: the admin preset's token \(a 3541-character Authorization header\) is too large/);
  assert.match(text, /HTTP 431/);
  assert.match(text, /--for plan/);
  assert.match(text, /--for work/);
  assert.doesNotMatch(text, /Signed in\b/);
  assert.ok(!text.includes(TOKEN), 'never prints the token');
});

test('a network failure or another status only warns, so an offline sign-in still saves', async () => {
  for (const me of [null, { error: 'HTTP 503', status: 503 }]) {
    const r = signInProbeResult(me, { preset: 'work' });
    assert.equal(r.fail, false);
    assert.match(r.lines.join('\n'), /^Warning: could not confirm the new sign-in/);
  }
});

test('an accepted token passes with no extra lines', async () => {
  const { fetchImpl } = stub(200, { data: { account_id: 'acc-1' } });
  const me = await whoAmI('http://enforcer.test', { headers, fetchImpl });
  assert.deepEqual(me, { account_id: 'acc-1' });
  assert.deepEqual(signInProbeResult(me, { preset: 'work' }), { fail: false, lines: [] });
});
