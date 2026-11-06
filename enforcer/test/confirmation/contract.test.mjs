// Portable confirmation contract. Fixtures: test/fixtures/confirmation/*.
// Proves the host gate in contract.mjs. Does not open Cursor, Grok, or the MCP server.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { toCursor } from '../../hooks/cursor/shim.mjs';
import {
  ANNOTATION_SHAPE,
  INTENTIONAL_UNCONFIRMED_WRITES,
  KNOWN_SIDE_EFFECTS,
  MUST_CONFIRM,
  advertise,
  annotationsForEffect,
  applyDecision,
  classify,
} from './contract.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ok = (m) => console.log('  ok  ' + m);
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const manifest = read('lib/api/spec/mcp-manifest.json');
const lock = read('lib/api/spec.lock.json');
const tools = new Map(manifest.tools.map((t) => [t.name, t]));
const tool = (name) => {
  const t = tools.get(name);
  assert.ok(t, `${name} is in the locked MCP manifest`);
  return t;
};

const FIVE = ['graph_next_work', 'graph_heartbeat', 'graph_report', 'graph_remember', 'update_task'];

assert.deepEqual([...INTENTIONAL_UNCONFIRMED_WRITES], FIVE);
assert.deepEqual([...MUST_CONFIRM], ['enforcer_api_write']);
assert.deepEqual(
  KNOWN_SIDE_EFFECTS.map((s) => s.tool),
  ['workspace_switch'],
);
assert.deepEqual([...ANNOTATION_SHAPE], ['readOnlyHint', 'destructiveHint', 'idempotentHint']);
assert.equal(lock.sources.mcp.repo, 'enforcer-v3-mcp');
assert.equal(lock.sources.mcp.path, 'tool-names.json');
assert.match(lock.sources.mcp.ref, /^[0-9a-f]{40}$/);
ok(`pin matches the five exceptions; advertisements come from tool-names.json @ ${lock.sources.mcp.ref}`);

// ── every locked tool ───────────────────────────────────────────────────────
const exceptions = new Set(FIVE);
const unconfirmedMutations = [];
for (const t of manifest.tools) {
  const ad = advertise(t);
  const c = classify(ad);
  assert.equal(c.shapeOk, true, t.name);
  assert.deepEqual(Object.keys(ad.annotations).sort(), [...ANNOTATION_SHAPE].sort(), t.name);
  assert.equal(ad.annotations.readOnlyHint, t.effect === 'read', t.name);
  assert.equal(ad.annotations.destructiveHint, t.effect === 'destructive', t.name);
  assert.equal(ad.annotations.idempotentHint, t.effect === 'read', t.name);
  assert.equal(ad.annotations.readOnlyHint && ad.annotations.destructiveHint, false, t.name);
  if (c.exception) {
    assert.equal(t.effect, 'write', `${t.name} is an unconfirmed write, not a read or a destructive tool`);
    assert.equal(c.requiresConfirmation, false, t.name);
    assert.equal(c.pureRead, false, t.name);
    assert.equal(ad._meta, undefined, t.name);
    unconfirmedMutations.push(t.name);
  } else if (t.effect === 'read' && !ad.knownSideEffect) {
    assert.equal(c.pureRead, true, t.name);
    assert.equal(c.requiresConfirmation, false, t.name);
    assert.equal(c.misAdvertisedRead, false, t.name);
    assert.equal(ad._meta, undefined, t.name);
  } else {
    assert.equal(c.pureRead, false, t.name);
    assert.equal(c.requiresConfirmation, true, t.name);
    if (t.effect === 'read') assert.equal(ad._meta, undefined, t.name);
    else assert.equal(ad._meta['anthropic/requiresUserInteraction'], true, t.name);
  }
  if (t.effect === 'destructive' || MUST_CONFIRM.includes(t.name)) {
    assert.equal(c.requiresConfirmation, true, t.name);
    assert.equal(c.exception, false, t.name);
  }
}
assert.deepEqual([...unconfirmedMutations].sort(), [...FIVE].sort());
const sideNames = new Set(KNOWN_SIDE_EFFECTS.map((s) => s.tool));
for (const name of FIVE) assert.equal(sideNames.has(name), false, `${name} is not also a known side-effect read`);
ok('the five names are the only unconfirmed mutations; destructive tools and enforcer_api_write stay confirmed');

// Anthropic metadata does not decide the gate. Flipping it leaves the class unchanged.
{
  const write = advertise(tool('graph_decide'));
  const stripped = { ...write, _meta: undefined };
  const forced = { ...write, _meta: { 'anthropic/requiresUserInteraction': false } };
  assert.deepEqual(classify(stripped), classify(write));
  assert.deepEqual(classify(forced), classify(write));
  const loop = advertise(tool('graph_next_work'));
  const flagged = { ...loop, _meta: { 'anthropic/requiresUserInteraction': true } };
  assert.equal(classify(flagged).requiresConfirmation, false);
  assert.deepEqual(classify(flagged), classify(loop));
}
ok('the gate ignores Anthropic requiresUserInteraction; the five stay unconfirmed without that flag');

// ── workspace_switch ────────────────────────────────────────────────────────
{
  const ws = tool('workspace_switch');
  const ad = advertise(ws);
  const c = classify(ad);
  assert.equal(c.pureRead, false);
  assert.equal(c.requiresConfirmation, true);
  assert.equal(c.exception, false);
  assert.equal(ad.knownSideEffect.persists, 'preferred_tenant_id');
  assert.equal(ad.knownSideEffect.via, 'updateMyPerson');
  // The locked effect is what the annotation builder advertises. A read-only
  // hint on this tool is a mis-advertisement; a write hint is not a pure read either.
  assert.equal(c.misAdvertisedRead, ws.effect === 'read');
  assert.equal(ad.annotations.readOnlyHint, ws.effect === 'read');
  if (ws.effect === 'read') {
    assert.equal(c.advertisedPureRead, true);
    assert.equal(ad._meta, undefined);
  } else {
    assert.equal(ad.annotations.readOnlyHint, false);
    assert.equal(c.advertisedPureRead, false);
  }
  console.log(`  note  locked workspace_switch effect=${ws.effect} misAdvertisedRead=${c.misAdvertisedRead}`);
  const honest = advertise(ws, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  const honestClass = classify(honest);
  assert.equal(honestClass.advertisedPureRead, false);
  assert.equal(honestClass.misAdvertisedRead, false);
  assert.equal(honestClass.pureRead, false);
  assert.equal(honestClass.requiresConfirmation, true);
  const partial = advertise(ws, { readOnlyHint: true, destructiveHint: false, idempotentHint: false });
  assert.equal(classify(partial).pureRead, false);
  assert.equal(classify(partial).misAdvertisedRead, true);
  assert.equal(classify(partial).requiresConfirmation, true);
}
ok('workspace_switch is not a pure read; a read-only hint is reported as a mis-advertised read');

// ── fixture scenarios: deny and cancel leave state alone; approve applies one call ──
function world() {
  const state = { preferred_tenant_id: null, calls: [] };
  const invoke = (call) => {
    state.calls.push(call);
    if (call.name === 'workspace_switch') state.preferred_tenant_id = call.arguments.tenant_id;
  };
  return { state, invoke };
}

const scenarios = JSON.parse(readFileSync(new URL('../fixtures/confirmation/scenarios.json', import.meta.url), 'utf8')).scenarios;
for (const s of scenarios) {
  const { state, invoke } = world();
  const out = applyDecision({
    advertisement: advertise(tool(s.tool)),
    request: { name: s.tool, arguments: s.arguments },
    approved: s.approved,
    decision: s.decision,
    invoke,
  });
  assert.equal(out.dispatched, s.dispatched, s.id);
  assert.equal(out.reason, s.reason, s.id);
  if (s.dispatched) {
    assert.equal(state.calls.length, 1, s.id);
    assert.equal(state.calls[0].name, s.tool, s.id);
    assert.deepEqual(state.calls[0].arguments, s.arguments, s.id);
    assert.deepEqual(out.call, { name: s.tool, arguments: s.arguments }, s.id);
  } else {
    assert.equal(state.calls.length, 0, s.id);
    assert.equal(out.call, undefined, s.id);
  }
  if ('preferredTenant' in s) assert.equal(state.preferred_tenant_id, s.preferredTenant, s.id);
}
ok(`${scenarios.length} fixture scenarios: deny and cancel mutate nothing; approve dispatches the approved call once`);

// One approval is one call. A second approval is a second call, not a replay of the first.
{
  const { state, invoke } = world();
  const request = { name: 'graph_decide', arguments: { graph: 'g1', node: 'n1', decision: 'go' } };
  const once = () => applyDecision({ advertisement: advertise(tool('graph_decide')), request, decision: 'approve', invoke });
  assert.equal(once().dispatched, true);
  assert.equal(state.calls.length, 1);
  assert.equal(once().dispatched, true);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls[0], state.calls[1]);
}
ok('each approval dispatches one call; two approvals are two calls');

// Argument key order does not make an approved call into a different call.
{
  const { state, invoke } = world();
  const out = applyDecision({
    advertisement: advertise(tool('enforcer_api_write')),
    request: { name: 'enforcer_api_write', arguments: { body: { id: 'a' }, operation: 'createThing' } },
    approved: { name: 'enforcer_api_write', arguments: { operation: 'createThing', body: { id: 'a' } } },
    decision: 'approve',
    invoke,
  });
  assert.equal(out.dispatched, true);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0].arguments, { operation: 'createThing', body: { id: 'a' } });
}
ok('an approval matches the requested call regardless of argument key order');

// A denied switch followed by an approved read does not persist the tenant.
{
  const { state, invoke } = world();
  const denied = applyDecision({
    advertisement: advertise(tool('workspace_switch')),
    request: { name: 'workspace_switch', arguments: { tenant_id: 'ten_b' } },
    decision: 'deny',
    invoke,
  });
  const read = applyDecision({
    advertisement: advertise(tool('workspace_current')),
    request: { name: 'workspace_current', arguments: {} },
    invoke,
  });
  assert.equal(denied.dispatched, false);
  assert.equal(read.dispatched, true);
  assert.equal(read.classification.pureRead, true);
  assert.equal(state.preferred_tenant_id, null);
  assert.deepEqual(state.calls, [{ name: 'workspace_current', arguments: {} }]);
}
ok('a denied workspace_switch leaves preferred_tenant_id unset; a later read is not that write');

// The five exceptions: an explicit deny still wins, and a missing decision is one call.
for (const name of FIVE) {
  const args = { marker: name };
  const fresh = () => world();
  const denied = fresh();
  assert.equal(
    applyDecision({ advertisement: advertise(tool(name)), request: { name, arguments: args }, decision: 'deny', invoke: denied.invoke }).dispatched,
    false,
    name,
  );
  assert.equal(denied.state.calls.length, 0, name);
  const open = fresh();
  const proceeded = applyDecision({ advertisement: advertise(tool(name)), request: { name, arguments: args }, invoke: open.invoke });
  assert.equal(proceeded.reason, 'no-confirmation-required', name);
  assert.deepEqual(open.state.calls, [{ name, arguments: args }], name);
}
ok('each of the five writes once when unprompted, and not at all when denied');

// A pure read with no decision is one call and is not a mutation. Deny skips it.
{
  const ad = advertise(tool('workspace_list'));
  assert.equal(classify(ad).pureRead, true);
  const { state, invoke } = world();
  const out = applyDecision({ advertisement: ad, request: { name: 'workspace_list', arguments: {} }, invoke });
  assert.equal(out.dispatched, true);
  assert.equal(out.classification.pureRead, true);
  const stopped = world();
  applyDecision({
    advertisement: ad,
    request: { name: 'workspace_list', arguments: {} },
    decision: 'deny',
    invoke: stopped.invoke,
  });
  assert.equal(stopped.state.calls.length, 0);
  assert.equal(state.calls.length, 1);
}
ok('a truthful read needs no confirmation; a deny still skips the call');

// Incomplete hints fail closed.
{
  const bare = { name: 'graph_post', effect: 'write', annotations: {}, knownSideEffect: null };
  const c = classify(bare);
  assert.equal(c.shapeOk, false);
  assert.equal(c.pureRead, false);
  assert.equal(c.requiresConfirmation, true);
  const { state, invoke } = world();
  const out = applyDecision({ advertisement: bare, request: { name: 'graph_post', arguments: { body: 'x' } }, invoke });
  assert.equal(out.dispatched, false);
  assert.equal(state.calls.length, 0);
}
ok('missing hints are not a pure read; the call waits for approval');

// Effect mapping stays the three-boolean shape, including a destructive tool.
{
  assert.deepEqual(annotationsForEffect('read'), { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  assert.deepEqual(annotationsForEffect('write'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  assert.deepEqual(annotationsForEffect('destructive'), { readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  assert.throws(() => annotationsForEffect('admin'), /unknown effect/);
}
ok('annotation shape is the three MCP hints, one set per effect');

// ── hook versus bare remote connector ───────────────────────────────────────
{
  const mcp = read('mcp.json');
  assert.equal(mcp.mcpServers.enforcer.type, 'streamable-http');
  assert.match(mcp.mcpServers.enforcer.url, /^https:\/\//);
  assert.equal(mcp.mcpServers.enforcer.command, undefined);
  assert.equal(mcp.hooks, undefined);
  const plugin = read('.cursor-plugin/plugin.json');
  assert.equal(plugin.mcpServers, './mcp.json');
  assert.equal(plugin.hooks, './hooks/cursor/hooks.json');
  const hooks = read('hooks/cursor/hooks.json');
  assert.match(hooks.hooks.preToolUse[0].command, /hooks\/cursor\/shim\.mjs" preToolUse$/);
  assert.equal(hooks.hooks.preToolUse[0].failClosed, true);
  const src = readFileSync(new URL('./contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"][^'"]*shim/);
  assert.doesNotMatch(src, /from ['"][^'"]*governor/);
  const asked = toCursor(
    'preToolUse',
    { hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'writes a tenant preference' } },
    { tool_name: 'mcp__cursor__workspace_switch' },
  );
  assert.equal(asked.permission, 'deny');
  assert.equal(asked.updated_input, undefined);
  assert.match(asked.user_message, /needs approval/);
}
ok('mcp.json has no hooks; the shim ask→deny answer is a local hook result and does not dispatch');

console.log('  note  UNVERIFIED: no Cursor desktop/web dialog, Run Mode, allowlist, or Grok Bot connector was exercised');
console.log('  note  UNVERIFIED: enforcer-v3-mcp tools.ts was not read (private repo); hints are derived from the locked effect');
