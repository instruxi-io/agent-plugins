// The pinned upstream API contracts under lib/api: the lock names five sources,
// every spec file still hashes to what the lock says, and the Swagger 2 ->
// OpenAPI 3 conversion behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swagger2ToOpenapi3 } from '../lib/api/convert.mjs';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/api');
const lock = JSON.parse(readFileSync(resolve(api, 'spec.lock.json'), 'utf8'));

test('lock lists five sources with ref and sha256', () => {
  assert.deepEqual(Object.keys(lock.sources).sort(), ['files', 'governance', 'graph', 'mcp', 'v3']);
  for (const [name, s] of Object.entries(lock.sources)) {
    // 8 to 40: mcp may be an abbreviated tip when the private repo cannot be fetched.
    // Every other source in this lock is still a full 40-character SHA.
    assert.match(s.ref, /^[0-9a-f]{8,40}$/, `${name} ref`);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, `${name} sha256`);
    assert.ok(s.repo && s.path && s.file, `${name} repo/path/file`);
  }
});

test('spec files match the lock', () => {
  for (const [name, s] of Object.entries(lock.sources)) {
    const got = createHash('sha256')
      .update(readFileSync(resolve(api, s.file)))
      .digest('hex');
    assert.equal(got, s.sha256, `${s.file} differs from the lock (run npm run sync:spec): ${name}`);
  }
  for (const n of ['graph', 'v3', 'files', 'governance']) {
    const doc = JSON.parse(readFileSync(resolve(api, lock.sources[n].file), 'utf8'));
    assert.match(doc.openapi, /^3\./);
    assert.ok(Object.keys(doc.paths).length > 0, `${n} has paths`);
  }
  const m = JSON.parse(readFileSync(resolve(api, lock.sources.mcp.file), 'utf8'));
  assert.ok(Array.isArray(m.tools) && m.tools.length > 0);
});

test('swagger 2 input converts to openapi 3', () => {
  const out = swagger2ToOpenapi3({
    swagger: '2.0',
    info: { title: 't', version: '1' },
    host: 'h.test',
    basePath: '/api',
    schemes: ['https'],
    paths: {
      '/x/{id}': {
        post: {
          operationId: 'op',
          consumes: ['application/json'],
          produces: ['application/json'],
          parameters: [
            { name: 'id', in: 'path', required: true, type: 'string' },
            { name: 'q', in: 'query', type: 'integer' },
            { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Thing' } },
          ],
          responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Thing' } } },
        },
      },
    },
    definitions: { Thing: { type: 'object', properties: { a: { type: 'string', 'x-nullable': true } } } },
  });
  assert.equal(out.openapi, '3.0.0');
  assert.equal(out.servers[0].url, 'https://h.test/api');
  const op = out.paths['/x/{id}'].post;
  assert.deepEqual(
    op.parameters.map((p) => p.name),
    ['id', 'q'],
  );
  assert.deepEqual(op.parameters[0], { name: 'id', in: 'path', required: true, schema: { type: 'string' } });
  assert.equal(op.requestBody.content['application/json'].schema.$ref, '#/components/schemas/Thing');
  assert.equal(op.responses[200].content['application/json'].schema.$ref, '#/components/schemas/Thing');
  assert.equal(out.components.schemas.Thing.properties.a.nullable, true);
  assert.equal(out.definitions, undefined);
  assert.throws(() => swagger2ToOpenapi3({ openapi: '3.0.0' }), /Swagger 2/);
});
