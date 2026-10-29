// The dispatcher mints a one-day credential per worker and must be able to revoke it when the worker exits.
// enforcer-v3 answers the issue call with `{success, data: {credential: {id, ...}, secret}}` (IssuedCredential,
// enforcer-v3 internal/usecase/agents/views.go): reading `data.id` gave null, so nothing was ever revoked.
// A local HTTP server answers exactly that JSON, through the dispatcher's real API client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { API } from '../../src/dispatch/api.mjs';
import { mintWorkerCredential, revokeWorkerCredential, issuedCredentialId, WORKER_SCOPES } from '../../src/dispatch/launch.mjs';

const CRED_ID = '0b9a3f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const AGENT_ID = '5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const SECRET = 'ag_' + 'w'.repeat(40);

/** The v3 agent-credential routes, answering as enforcer-v3 does. */
async function fakeV3() {
  const s = { calls: [], live: new Set() };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      s.calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (status, j) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      if (req.method === 'POST' && req.url === `/agents/${AGENT_ID}/credentials`) {
        s.live.add(CRED_ID);
        // handler.IssuedAgentCredentialResponse{Success, Data: IssuedCredential{Credential, Secret}}
        return send(201, {
          success: true,
          data: {
            credential: {
              id: CRED_ID,
              agent_id: AGENT_ID,
              name: JSON.parse(body).name,
              scopes: WORKER_SCOPES,
              expires_at: '2026-10-29T00:00:00Z',
              created_at: '2026-10-28T00:00:00Z',
            },
            secret: SECRET,
          },
        });
      }
      if (req.method === 'DELETE' && req.url === `/agents/${AGENT_ID}/credentials/${CRED_ID}`) {
        s.live.delete(CRED_ID);
        return send(200, { success: true });
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  s.close = () => new Promise((r) => server.close(r));
  return s;
}

test('a worker credential minted against the real v3 response shape is revoked', async () => {
  const v3 = await fakeV3();
  try {
    const api = new API(v3.base, { retries: 0 });
    const warned = [];
    const cred = await mintWorkerCredential(api, { ENFORCER_WORKER_AGENT_ID: AGENT_ID }, 'worker-n1', { warn: (m) => warned.push(m) });
    assert.equal(cred.secret, SECRET);
    assert.equal(cred.id, CRED_ID, 'the id is read from data.credential.id');
    assert.equal(cred.agent, AGENT_ID);
    assert.deepEqual(warned, [], 'no warning when the id is there');
    assert.ok(v3.live.has(CRED_ID));
    assert.equal(await revokeWorkerCredential(api, cred), true);
    assert.deepEqual(
      v3.calls.map((c) => `${c.method} ${c.url}`),
      [`POST /agents/${AGENT_ID}/credentials`, `DELETE /agents/${AGENT_ID}/credentials/${CRED_ID}`],
    );
    assert.equal(v3.live.has(CRED_ID), false, 'the credential is gone on the server');
  } finally {
    await v3.close();
  }
});

test('a mint answered without an id is loud: a warning, and nothing to revoke', async () => {
  const api = { call: async () => ({ success: true, data: { credential: {}, secret: SECRET } }) };
  const warned = [];
  const cred = await mintWorkerCredential(api, { ENFORCER_WORKER_AGENT_ID: AGENT_ID }, 'worker-n2', { warn: (m) => warned.push(m) });
  assert.equal(cred.id, null);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /worker-n2.*without an id.*cannot be revoked.*expires on its own/);
  assert.ok(!warned[0].includes(SECRET), 'the warning never carries the secret');
  assert.equal(await revokeWorkerCredential(api, cred), false);
});

test('the older flat shapes are still read', () => {
  assert.equal(issuedCredentialId({ data: { credential: { id: 'c1' }, secret: 's' } }), 'c1');
  assert.equal(issuedCredentialId({ data: { id: 'c2', secret: 's' } }), 'c2');
  assert.equal(issuedCredentialId({ data: { credential_id: 'c3', secret: 's' } }), 'c3');
  assert.equal(issuedCredentialId({ data: { secret: 's' } }), null);
  assert.equal(issuedCredentialId(null), null);
});
