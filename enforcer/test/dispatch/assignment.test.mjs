// Enforceable node assignment (enforcer-graph 43f32e7c): the vendored graph spec carries assignment_mode and
// 409 node_reserved, and the dispatcher skips that refusal instead of spending an attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher, defaultArgs } from '../../src/dispatch/run.mjs';
import { APIError, nodeReserved } from '../../src/dispatch/api.mjs';
import { isPrivate, reservedForAssignee } from '../../src/dispatch/model.mjs';
import { resolveRoute, validateRoutes } from '../../src/dispatch/routes.mjs';
import { mergeTarget } from '../../src/dispatch/select.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'assign-'));
const mkArgs = (state, o = {}) =>
  defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), killGrace: 0.2, ...o });
const say = (lines) => (m) => lines.push(m);
const spec = JSON.parse(readFileSync(new URL('../../lib/api/spec/graph.json', import.meta.url), 'utf8'));
const reservedBody = JSON.stringify({ error: 'node_reserved', detail: 'this node is reserved for its assignee' });
const reservedObject = JSON.stringify({ error: { code: 'node_reserved', detail: 'this node is reserved for its assignee' } });

test('vendored graph spec publishes assignment_mode and 409 node_reserved', () => {
  const node = spec.components.schemas['internal_nodes.Node'].properties;
  assert.deepEqual(node.assignment_mode.enum, ['advisory', 'required']);
  assert.deepEqual(node.claim_block.enum, ['node_reserved']);
  assert.equal(node.claim_block.nullable, true);
  assert.equal(node.private.type, 'boolean');
  assert.equal(node.viewer_can_claim.type, 'boolean');
  for (const path of ['/graphs/{graphId}/nodes/{nodeId}/claim', '/graphs/{graphId}/nodes/{nodeId}/runs']) {
    const op = spec.paths[path].post;
    assert.ok(op.responses['409'], `${path} has 409`);
    assert.match(op.description, /409 node_reserved/);
  }
  const types = readFileSync(new URL('../../lib/api/graph.d.ts', import.meta.url), 'utf8');
  assert.match(types, /enforcer-graph@43f32e7c2d0f60e977c4cc843ae02738e43035b1/);
  assert.match(types, /assignment_mode\?: "advisory" \| "required"/);
  assert.match(types, /claim_block\?: "node_reserved" \| null/);
  assert.match(types, /private\?: boolean/);
  assert.match(types, /viewer_can_claim\?: boolean/);
  const lock = JSON.parse(readFileSync(new URL('../../lib/api/spec.lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.sources.graph.ref, '43f32e7c2d0f60e977c4cc843ae02738e43035b1');
});

test('nodeReserved matches only 409 node_reserved', () => {
  assert.equal(nodeReserved(new APIError(409, reservedBody)), true);
  assert.equal(nodeReserved(new APIError(409, reservedObject)), true);
  assert.equal(nodeReserved(new APIError(409, '{"error":"node_not_runnable","detail":"prerequisites"}')), false);
  assert.equal(nodeReserved(new APIError(409, 'node_reserved')), false);
  assert.equal(nodeReserved(new APIError(500, reservedBody)), false);
  assert.equal(nodeReserved(new APIError(404, reservedBody)), false);
  assert.equal(nodeReserved(new Error('node_reserved')), false);
});

test('private fails closed when the server field or data.private is true', async () => {
  assert.equal(isPrivate({ private: true, data: {} }), true);
  assert.equal(isPrivate({ private: true, data: { private: false } }), true);
  assert.equal(isPrivate({ private: false, data: { private: true } }), true);
  assert.equal(isPrivate({ data: { private: true } }), true);
  assert.equal(isPrivate({ private: false, data: { private: false } }), false);
  assert.equal(isPrivate({ private: 'true', data: { private: 'true' } }), false);
  assert.equal(isPrivate({}), false);
  assert.equal(isPrivate(null), false);
  const hosted = validateRoutes({ version: 1, routes: { deep: { harness: 'claude', model: 'opus' } } }, 'test');
  const serverPrivate = { id: 'id-k', key: 'k', type: 'task', status: 'ready', private: true, data: { tier: 'deep', private: false } };
  const pick = await resolveRoute(serverPrivate, hosted, { harness: 'claude' }, null);
  assert.equal(pick.refuse, true);
  assert.match(pick.reason, /private node has no endpoint route/);
  const payloadPrivate = { id: 'id-k', key: 'k', type: 'task', status: 'ready', private: false, data: { tier: 'deep', private: true } };
  const other = await resolveRoute(payloadPrivate, null, { harness: 'claude' }, null);
  assert.equal(other.refuse, true);
  const lines = [];
  const d = new Dispatcher(
    {
      async nodes() {
        return [];
      },
    },
    mkArgs(tmp()),
    say(lines),
  );
  assert.equal(await d.launch(serverPrivate), 'refused');
  assert.equal(d.attempts.get('k'), undefined);
  assert.equal(d.workers.size, 0);
  assert.match(lines.join('\n'), /REFUSE k: private node has no endpoint route/);
});

test('a read that says the node is reserved is a skip, said once, and spends no attempt', async () => {
  assert.equal(reservedForAssignee({ claim_block: 'node_reserved' }), true);
  assert.equal(reservedForAssignee({ assignment_mode: 'required', viewer_can_claim: false }), true);
  assert.equal(reservedForAssignee({ assignment_mode: 'required', viewer_can_claim: true }), false);
  assert.equal(reservedForAssignee({ assignment_mode: 'advisory', viewer_can_claim: false }), false);
  assert.equal(reservedForAssignee({ claim_block: null, assignment_mode: 'advisory' }), false);
  const n = {
    id: 'id-k',
    key: 'k',
    type: 'task',
    status: 'ready',
    claim_block: 'node_reserved',
    assignment_mode: 'required',
    viewer_can_claim: false,
    data: { repo: 'agent-plugins' },
  };
  const api = {
    claims: 0,
    async nodes() {
      return [n];
    },
    async frontier() {
      return [n];
    },
    async claim() {
      this.claims++;
      throw new Error('should not claim');
    },
  };
  const lines = [];
  const d = new Dispatcher(api, mkArgs(tmp()), say(lines));
  const first = await d.tick();
  assert.deepEqual(first.launched, []);
  assert.equal(api.claims, 0);
  assert.equal(d.attempts.get('k') || 0, 0);
  assert.equal(d.workers.size, 0);
  assert.match(lines.join('\n'), /skip k: node reserved for its assignee/);
  assert.equal(
    lines.some((l) => /claim k refused|REFUSE k|FAILED/.test(l)),
    false,
  );
  const said = lines.length;
  const second = await d.tick();
  assert.deepEqual(second.launched, []);
  assert.equal(lines.length, said, 'a reserved node is skipped once, not once per pass');
  assert.equal(d.attempts.get('k') || 0, 0);
});

test('409 node_reserved on claim is a skip and spends no attempt; another 409 is still a claim error', async () => {
  const n = {
    id: 'id-merge-feat',
    key: 'merge-feat',
    type: 'merge',
    status: 'ready',
    data: { repo: 'agent-plugins', pr: 'https://github.com/instruxi-io/agent-plugins/pull/9' },
  };
  const pr = { url: 'https://github.com/instruxi-io/agent-plugins/pull/9', headRefName: 'graph/merge-feat', isCrossRepository: false };
  const land = async (body, status = 409) => {
    const lines = [];
    const api = {
      claims: 0,
      async claim() {
        this.claims++;
        throw new APIError(status, body);
      },
    };
    const d = new Dispatcher(api, mkArgs(tmp(), { prView: () => pr }), say(lines));
    d.graphKeys = new Set([n.key]);
    const outcome = await d.launchMerge(n, mergeTarget(n), '');
    return { outcome, lines, claims: api.claims, attempts: d.attempts.get(n.key) || 0, workers: d.workers.size };
  };
  for (const body of [reservedBody, reservedObject]) {
    const r = await land(body);
    assert.equal(r.outcome, 'skipped', body);
    assert.equal(r.claims, 1);
    assert.equal(r.attempts, 0);
    assert.equal(r.workers, 0);
    assert.match(r.lines.join('\n'), /skip merge-feat: node reserved for its assignee/);
    assert.equal(
      r.lines.some((l) => /claim merge-feat refused/.test(l)),
      false,
    );
  }
  const other = await land('{"error":"node_not_runnable","detail":"prerequisites"}');
  assert.equal(other.outcome, undefined);
  assert.equal(other.attempts, 1, 'a different 409 still counts as an attempt');
  assert.equal(other.workers, 0);
  assert.match(other.lines.join('\n'), /claim merge-feat refused: HTTP 409/);
  const requiredOnly = {
    id: 'id-k',
    key: 'k',
    type: 'task',
    status: 'ready',
    assignment_mode: 'required',
    viewer_can_claim: false,
    data: {},
  };
  const lines = [];
  const d = new Dispatcher(
    {
      async nodes() {
        return [];
      },
    },
    mkArgs(tmp()),
    say(lines),
  );
  assert.equal(await d.launch(requiredOnly), 'skipped');
  assert.equal(d.attempts.get('k') || 0, 0);
  assert.match(lines.join('\n'), /skip k: node reserved for its assignee/);
});
