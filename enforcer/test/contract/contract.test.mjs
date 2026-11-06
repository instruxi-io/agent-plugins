// The plugin's HTTP calls against the API specs.
//
//   node --test test/contract/contract.test.mjs                       the pinned specs (lib/api/spec, as locked)
//   CONTRACT_SPEC_DIR=/tmp/specs node --test test/contract/...        a directory of <service>.json (swagger 2 or OpenAPI 3):
//                                                                      the nightly's deployed and main specs (contract-nightly.yml)
//   A directory that holds deployed-swagger.json is an explicit "not evaluated" signal from
//   fetch-live-specs.mjs. It fails this file even if spec JSON is copied in beside the marker.
//
// test/contract/used.json is every call site the plugin makes (scripts/extract-api-usage.mjs); a call site the spec cannot
// serve is a bug in one of the two. Known, understood drift lives in known-drift.json, each entry with its reason; an entry
// that stops being true fails the test, so the list cannot rot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swagger2ToOpenapi3 } from '../../lib/api/convert.mjs';
import { extract, render, USED_PATH, SERVICES } from '../../scripts/extract-api-usage.mjs';
import { refuseUnexposedMarker } from '../../scripts/fetch-live-specs.mjs';
import { check, checkCall, hasField, matchPaths } from './check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const api = join(here, '../../lib/api');
const lock = JSON.parse(readFileSync(join(api, 'spec.lock.json'), 'utf8'));
const used = JSON.parse(readFileSync(USED_PATH, 'utf8'));
const known = JSON.parse(readFileSync(join(here, 'known-drift.json'), 'utf8')).drift;

function loadDocs() {
  const dir = process.env.CONTRACT_SPEC_DIR;
  if (dir) refuseUnexposedMarker(dir);
  const docs = {};
  for (const [service, name] of Object.entries(SERVICES)) {
    const file = dir ? join(dir, `${name}.json`) : join(api, lock.sources[name].file);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    docs[service] = raw.swagger ? swagger2ToOpenapi3(raw) : raw;
  }
  return docs;
}
const docs = loadDocs();
const source = process.env.CONTRACT_SPEC_DIR ? `specs in ${process.env.CONTRACT_SPEC_DIR}` : 'the pinned specs';

const violations = check(used.calls, docs);
const isKnown = (v) => known.some((k) => k.id === v.id && k.kind === v.kind && (k.field || '') === (v.field || ''));
const fresh = (kinds) => violations.filter((v) => kinds.includes(v.kind) && !isKnown(v));
const report = (vs) => vs.map((v) => `${v.id}: ${v.message}`).join('\n');

test('used manifest matches the code', () => {
  assert.equal(readFileSync(USED_PATH, 'utf8'), render(extract()), 'test/contract/used.json is stale: run `node scripts/extract-api-usage.mjs`');
});

test('every used call has an api-used declaration where it sends or reads fields', () => {
  assert.ok(used.calls.length >= 30, `${used.calls.length} call sites extracted`);
  assert.ok(used.calls.some((c) => c.sends.length) && used.calls.some((c) => c.reads.length) && used.calls.some((c) => c.headers.length));
});

test(`every used path exists in the spec (${source})`, () => {
  const bad = fresh(['path', 'method']);
  assert.equal(bad.length, 0, report(bad));
});

test(`every sent field is in the request schema (${source})`, () => {
  const bad = fresh(['sent']);
  assert.equal(bad.length, 0, report(bad));
});

test(`every read field is in the response schema (${source})`, () => {
  const bad = fresh(['read']);
  assert.equal(bad.length, 0, report(bad));
});

test(`every header the plugin names is in the spec (${source})`, () => {
  const bad = fresh(['header']);
  assert.equal(bad.length, 0, report(bad));
});

test('known drift is still drift', () => {
  for (const k of known) {
    assert.ok(k.reason && k.kind && k.id, `known-drift entry needs id, kind and reason: ${JSON.stringify(k)}`);
    assert.ok(
      violations.some((v) => v.id === k.id && v.kind === k.kind && (k.field || '') === (v.field || '')),
      `known drift no longer occurs (fixed? delete it from known-drift.json): ${k.id} ${k.kind} ${k.field || ''}`,
    );
  }
});

// The checker itself: each kind of break is caught, on a real operation of the pinned graph spec.
const graph = loadDocs().graph;
const claim = { id: 't', service: 'graph', method: 'POST', path: '/graphs/{}/nodes/{}/claim', sends: [], reads: [], headers: [] };

test('a missing path or method fails', () => {
  assert.equal(checkCall(claim, graph).length, 0);
  assert.equal(checkCall({ ...claim, path: '/graphs/{}/no-such-thing' }, graph)[0].kind, 'path');
  assert.equal(checkCall({ ...claim, method: 'DELETE' }, graph)[0].kind, 'method');
});

test('a sent field missing from the schema fails', () => {
  assert.deepEqual(checkCall({ ...claim, sends: ['runner'] }, graph), []);
  const v = checkCall({ ...claim, sends: ['runner', 'no_such_field'] }, graph);
  assert.equal(v.length, 1);
  assert.deepEqual([v[0].kind, v[0].field], ['sent', 'no_such_field']);
});

test('a read field missing from the schema fails', () => {
  const hb = { ...claim, path: '/graphs/{}/nodes/{}/runs/{}/heartbeat' };
  assert.deepEqual(checkCall({ ...hb, reads: ['data.state', 'data.lease_expires_at', 'warnings'] }, graph), []);
  const v = checkCall({ ...hb, reads: ['state'] }, graph); // `state` lives under `data`, not at the envelope
  assert.deepEqual([v[0]?.kind, v[0]?.field], ['read', 'state']);
});

test('a header not in the spec fails', () => {
  const hb = { ...claim, path: '/graphs/{}/nodes/{}/runs/{}/heartbeat' };
  assert.deepEqual(checkCall({ ...hb, headers: ['X-Graph-Client', 'Content-Type'] }, graph), []);
  assert.equal(checkCall({ ...hb, headers: ['X-Made-Up'] }, graph)[0].kind, 'header');
});

test('a free-form object accepts any key below it; a closed one does not', () => {
  const complete = { ...claim, path: '/graphs/{}/nodes/{}/runs/{}/complete' };
  assert.deepEqual(checkCall({ ...complete, sends: ['status', 'data.anything.at.all'] }, graph), []);
  assert.equal(checkCall({ ...complete, sends: ['status.nope'] }, graph)[0].kind, 'sent');
  assert.ok(hasField(graph, { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } } }, 'a.b'));
});

test('a {} in a used path stands for any spec segment', () => {
  assert.ok(matchPaths(docs.files, '/storage/file/{}/upload').length >= 1);
});
