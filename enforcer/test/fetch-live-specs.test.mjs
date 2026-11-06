// The deployed swagger fetch must not turn "the edge does not publish the spec" into a contract pass,
// and it must not keep the historical URL that used to work by quietly pointing somewhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALTERNATE_EVIDENCE,
  MARKER,
  SIGNAL_AUTH,
  SIGNAL_UNEXPOSED,
  aggregate,
  classifySwagger,
  defaultHealthUrl,
  defaultSwaggerUrl,
  fetchLiveSpecs,
  readHealth,
  refuseUnexposedMarker,
} from '../scripts/fetch-live-specs.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVICES = ['graph', 'enforcer', 'files', 'governance'];
const NGINX =
  '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n';
const SPEC = JSON.stringify({ swagger: '2.0', paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } });

function tmp() {
  return mkdtempSync(join(tmpdir(), 'live-specs-'));
}
function res(status, body, contentType) {
  return {
    status,
    headers: { get: (n) => (n === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}
function healthBody(service, version) {
  const body = { status: 'ok', service: `enforcer-${service}`, checks: { db: 'ok' } };
  if (version) body.version = version;
  return JSON.stringify(body);
}

function router(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: init?.headers?.authorization || '' });
    const found = reply(url);
    if (!found) throw new Error(`unexpected ${url}`);
    return found;
  };
  return { calls, fetchImpl };
}

test('default swagger URLs stay the ones the nightly used when they returned documents', () => {
  const base = 'https://api.instruxi.dev';
  assert.equal(defaultSwaggerUrl(base + '/', 'graph'), 'https://api.instruxi.dev/api/v1/graph/swagger/doc.json');
  assert.equal(defaultSwaggerUrl(base, 'enforcer'), 'https://api.instruxi.dev/api/v1/enforcer/swagger/doc.json');
  assert.equal(defaultSwaggerUrl(base, 'files'), 'https://api.instruxi.dev/api/v1/files/swagger/doc.json');
  assert.equal(defaultSwaggerUrl(base, 'governance'), 'https://api.instruxi.dev/api/v1/governance/swagger/doc.json');
  assert.equal(defaultHealthUrl(base, 'graph'), 'https://api.instruxi.dev/api/v1/graph/health');
});

test('nginx HTML 404 is the edge-unexposed class; a cloudflare page and an app JSON 404 are not that class', () => {
  assert.equal(classifySwagger({ status: 404, contentType: 'text/html', body: NGINX }).class, 'edge-unexposed');
  const cloudflare = '<html><head><title>404 Not Found</title></head><body>Cloudflare</body></html>';
  assert.equal(classifySwagger({ status: 404, contentType: 'text/html', body: cloudflare }).class, 'unexpected');
  const app = JSON.stringify({ error: 'Not Found', message: 'Cannot GET /api/v1/graph/swagger/doc.json', success: false });
  assert.equal(classifySwagger({ status: 404, contentType: 'application/json', body: app }).class, 'not-mounted');
  assert.equal(classifySwagger({ status: 404, contentType: 'text/plain', body: 'Cannot GET /api/v1/files/swagger/doc.json' }).class, 'not-mounted');
  assert.equal(classifySwagger({ status: 401, contentType: 'application/json', body: '{"error":"missing_token"}' }).class, 'auth');
  assert.equal(classifySwagger({ status: 200, contentType: 'text/html', body: '<html>login</html>' }).class, 'invalid');
  assert.equal(classifySwagger({ status: 200, contentType: 'application/json', body: SPEC }).class, 'document');
});

test('health ok requires the service document, and only a hex version is kept', () => {
  assert.equal(readHealth(200, healthBody('graph')).ok, true);
  assert.equal(
    readHealth(200, '{"status":"ok","checks":{"db":"ok"},"version":"37d2ee44abcc32dd46c8da11669ed9d73dbaeda2"}').version,
    '37d2ee44abcc32dd46c8da11669ed9d73dbaeda2',
  );
  assert.equal(readHealth(200, '{"status":"ok"}').ok, false);
  assert.equal(readHealth(200, '{"status":"ok","service":"enforcer-graph","version":"1.2.3"}').version, null);
  assert.equal(readHealth(500, healthBody('graph')).ok, false);
});

test('all four edge 404s with healthy services are the unexposed signal and write no specs', async () => {
  const { calls, fetchImpl } = router((url) => {
    if (url.endsWith('/swagger/doc.json')) return res(404, NGINX, 'text/html');
    if (url.endsWith('/health')) {
      const service = url.split('/api/v1/')[1].split('/')[0];
      const version = service === 'enforcer' ? '37d2ee44abcc32dd46c8da11669ed9d73dbaeda2' : null;
      return res(200, healthBody(service, version), 'application/json');
    }
    return null;
  });
  const dir = tmp();
  const lines = [];
  const log = { log: (s) => lines.push(s), error: (s) => lines.push(s) };
  const got = await fetchLiveSpecs(dir, { fetchImpl, env: {}, log });
  assert.equal(got.exitCode, 10);
  assert.equal(got.mode, 'unexposed');
  assert.deepEqual(readdirSync(dir), [MARKER]);
  const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
  assert.equal(marker.signal, SIGNAL_UNEXPOSED);
  assert.equal(marker.evaluated_contract, false);
  assert.equal(marker.alternate_evidence, ALTERNATE_EVIDENCE);
  assert.deepEqual(
    marker.services.map((s) => s.service),
    SERVICES,
  );
  assert.ok(marker.services.every((s) => s.swagger_class === 'edge-unexposed' && s.swagger_status === 404 && s.health_ok === true));
  assert.equal(marker.services.find((s) => s.service === 'enforcer').deployed_version, '37d2ee44abcc32dd46c8da11669ed9d73dbaeda2');
  assert.ok(lines.some((l) => l.includes(SIGNAL_UNEXPOSED)));
  assert.ok(calls.some((c) => c.url === 'https://api.instruxi.dev/api/v1/graph/swagger/doc.json'));
  assert.ok(calls.some((c) => c.url === 'https://api.instruxi.dev/api/v1/governance/health'));
  assert.ok(calls.every((c) => c.authorization === ''));
});

test('an app that no longer mounts swagger, with health up, is the same unexposed signal', async () => {
  const { fetchImpl } = router((url) => {
    if (url.endsWith('/swagger/doc.json')) {
      return res(404, JSON.stringify({ error: 'Not Found', message: `Cannot GET ${url}` }), 'application/json');
    }
    if (url.endsWith('/health')) return res(200, healthBody('x'), 'application/json');
    return null;
  });
  const got = await fetchLiveSpecs(tmp(), { fetchImpl, env: {}, log: { log() {}, error() {} } });
  assert.equal(got.mode, 'unexposed');
  assert.equal(got.exitCode, 10);
});

test('a non-nginx HTML 404 is not declared intentionally unexposed', async () => {
  const { fetchImpl } = router((url) => {
    if (url.endsWith('/swagger/doc.json')) return res(404, '<html><title>404 Not Found</title><body>Cloudflare</body></html>', 'text/html');
    if (url.endsWith('/health')) return res(200, healthBody('x'), 'application/json');
    return null;
  });
  const dir = tmp();
  const got = await fetchLiveSpecs(dir, { fetchImpl, env: {}, log: { log() {}, error() {} } });
  assert.equal(got.exitCode, 1);
  assert.equal(got.mode, 'failed');
  assert.deepEqual(readdirSync(dir), []);
});

test('edge 404 while health is down fails instead of claiming the spec is intentionally private', async () => {
  const { fetchImpl } = router((url) => {
    if (url.endsWith('/swagger/doc.json')) return res(404, NGINX, 'text/html');
    if (url.endsWith('/health')) return res(503, '{"status":"down"}', 'application/json');
    return null;
  });
  const dir = tmp();
  const got = await fetchLiveSpecs(dir, { fetchImpl, env: {}, log: { log() {}, error() {} } });
  assert.equal(got.exitCode, 1);
  assert.equal(existsSyncMarker(dir), false);
});

test('a generic health ok body does not bless an unpublished swagger route', async () => {
  const { fetchImpl } = router((url) => {
    if (url.endsWith('/swagger/doc.json')) return res(404, NGINX, 'text/html');
    if (url.endsWith('/health')) return res(200, '{"status":"ok"}', 'application/json');
    return null;
  });
  const got = await fetchLiveSpecs(tmp(), { fetchImpl, env: {}, log: { log() {}, error() {} } });
  assert.equal(got.exitCode, 1);
  assert.equal(got.mode, 'failed');
});

test('documents are written only when every service returns one, and health is not required then', async () => {
  const { calls, fetchImpl } = router((url) => (url.endsWith('/swagger/doc.json') ? res(200, SPEC, 'application/json') : null));
  const dir = tmp();
  const got = await fetchLiveSpecs(dir, { fetchImpl, env: { CONTRACT_SPEC_BEARER: 'sekret' }, log: { log() {}, error() {} } });
  assert.equal(got.exitCode, 0);
  assert.equal(got.mode, 'fetched');
  assert.deepEqual(readdirSync(dir).sort(), ['files.json', 'governance.json', 'graph.json', 'v3.json']);
  assert.equal(existsSyncMarker(dir), false);
  assert.ok(calls.every((c) => c.url.endsWith('/swagger/doc.json') && c.authorization === 'Bearer sekret'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')).paths['/health'].get.responses[200].description, 'ok');
});

test('one live document and three edge 404s is a failure, not a partial contract and not the unexposed signal', async () => {
  const { fetchImpl } = router((url) => {
    if (url.endsWith('/graph/swagger/doc.json')) return res(200, SPEC, 'application/json');
    if (url.endsWith('/swagger/doc.json')) return res(404, NGINX, 'text/html');
    if (url.endsWith('/health')) return res(200, healthBody('x'), 'application/json');
    return null;
  });
  const dir = tmp();
  const got = await fetchLiveSpecs(dir, { fetchImpl, env: {}, log: { log() {}, error() {} } });
  assert.equal(got.exitCode, 1);
  assert.deepEqual(readdirSync(dir), []);
});

test('401 on every route with no bearer is auth-required and still not a contract', async () => {
  const { fetchImpl } = router((url) => (url.endsWith('/swagger/doc.json') ? res(401, '{"error":"missing_token"}', 'application/json') : null));
  const dir = tmp();
  const got = await fetchLiveSpecs(dir, { fetchImpl, env: {}, log: { log() {}, error() {} } });
  assert.equal(got.exitCode, 11);
  assert.equal(got.mode, 'auth-required');
  const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
  assert.equal(marker.signal, SIGNAL_AUTH);
  assert.equal(marker.evaluated_contract, false);
  assert.equal(existsSyncMarker(dir), true);
  assert.equal(
    readdirSync(dir).some((n) => n.endsWith('.json') && n !== MARKER),
    false,
  );
});

test('a bearer that is still refused fails closed', async () => {
  const { fetchImpl } = router((url) => (url.endsWith('/swagger/doc.json') ? res(401, '{"error":"missing_token"}', 'application/json') : null));
  const dir = tmp();
  const lines = [];
  const got = await fetchLiveSpecs(dir, {
    fetchImpl,
    env: { CONTRACT_SPEC_BEARER: 'sekret' },
    log: { log: (s) => lines.push(s), error: (s) => lines.push(s) },
  });
  assert.equal(got.exitCode, 1);
  assert.equal(got.mode, 'auth-rejected');
  assert.equal(existsSyncMarker(dir), false);
  assert.ok(lines.some((l) => l.includes('CONTRACT_SPEC_BEARER')));
  assert.ok(lines.every((l) => !l.includes('sekret')));
});

test('a per-service URL override replaces only that service', async () => {
  const { calls, fetchImpl } = router((url) => (url.endsWith('/swagger/doc.json') ? res(200, SPEC, 'application/json') : null));
  await fetchLiveSpecs(tmp(), {
    fetchImpl,
    env: { CONTRACT_URL_GRAPH: 'https://specs.example/graph/swagger/doc.json' },
    log: { log() {}, error() {} },
  });
  assert.ok(calls.some((c) => c.url === 'https://specs.example/graph/swagger/doc.json'));
  assert.ok(calls.some((c) => c.url === 'https://api.instruxi.dev/api/v1/files/swagger/doc.json'));
});

test('the marker is refused even when spec files sit beside it and even if it claims the contract was evaluated', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'graph.json'), SPEC);
  writeFileSync(join(dir, MARKER), JSON.stringify({ signal: SIGNAL_UNEXPOSED, evaluated_contract: true, alternate_evidence: ALTERNATE_EVIDENCE }));
  assert.throws(() => refuseUnexposedMarker(dir), new RegExp(SIGNAL_UNEXPOSED));
  assert.throws(() => refuseUnexposedMarker(dir), /not a deployed contract/);
  const clean = tmp();
  refuseUnexposedMarker(clean);
  refuseUnexposedMarker('');
});

test('the contract test process fails closed on a marker directory', () => {
  const dir = tmp();
  for (const name of ['graph.json', 'v3.json', 'files.json', 'governance.json']) writeFileSync(join(dir, name), SPEC);
  writeFileSync(join(dir, MARKER), JSON.stringify({ signal: SIGNAL_UNEXPOSED, evaluated_contract: false, alternate_evidence: ALTERNATE_EVIDENCE }));
  const env = { ...process.env, CONTRACT_SPEC_DIR: dir };
  // A nested `node --test` inherits this and exits 0 without loading the file.
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', 'test/contract/contract.test.mjs'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(r.status, 0);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, new RegExp(SIGNAL_UNEXPOSED));
  assert.match(out, /not a deployed contract/);
  assert.doesNotMatch(out, /# tests 1[0-9]/);
});

test('classify and the signal jobs cannot be wired so an unexposed result runs the contract test', () => {
  const yml = readFileSync(join(ROOT, '../.github/workflows/contract-nightly.yml'), 'utf8');
  const body = (id) => {
    const start = yml.indexOf(`\n  ${id}:\n`);
    assert.ok(start >= 0, id);
    const rest = yml.slice(start + 1);
    const next = rest.slice(id.length + 3).search(/\n  [a-z0-9-]+:\n/);
    return next === -1 ? rest : rest.slice(0, id.length + 3 + next);
  };
  const probe = body('probe');
  const contract = body('deployed-contract');
  const unexposed = body('deployed-swagger-intentionally-unexposed');
  const auth = body('deployed-swagger-auth-required');
  const main = body('main');
  assert.match(probe, /\[ "\$code" -eq 10 \]; then mode=unexposed/);
  assert.match(probe, /\[ "\$code" -eq 11 \]; then mode=auth-required/);
  assert.match(probe, /\[ "\$code" -eq 0 \]; then mode=fetched/);
  assert.doesNotMatch(probe, /contract\.test\.mjs/);
  assert.match(contract, /mode == 'fetched'/);
  assert.match(contract, /--expect fetched/);
  assert.match(contract, /contract\.test\.mjs/);
  assert.match(unexposed, /mode == 'unexposed'/);
  assert.match(unexposed, /--expect unexposed/);
  assert.doesNotMatch(unexposed, /contract\.test\.mjs/);
  assert.match(auth, /mode == 'auth-required'/);
  assert.match(auth, /--expect auth-required/);
  assert.doesNotMatch(auth, /contract\.test\.mjs/);
  assert.match(main, /github.event_name != 'pull_request'/);
  assert.match(main, /SPEC_SYNC_TOKEN/);
  assert.doesNotMatch(yml, /continue-on-error:/);
  assert.doesNotMatch(yml, /CONTRACT_URL_/);
  assert.equal(aggregate([], { bearerConfigured: false }), 'failed');
});

function existsSyncMarker(dir) {
  return readdirSync(dir).includes(MARKER);
}
