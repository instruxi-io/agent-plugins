import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  SHARE_SCOPES,
  FAMILIES,
  presetScope,
  ceilingCovers,
  notGranted,
  notGrantedLines,
  extractNewApp,
  savedClient,
  scopeLines,
} from '../bin/login.mjs';

test('work, plan and agents ask for the plan-sharing scopes; admin takes everything offered', () => {
  assert.deepEqual(SHARE_SCOPES, ['enforcer:graph-sharing.write', 'enforcer:graph-work.write', 'enforcer:graph-skills.write']);
  for (const p of ['work', 'plan', 'agents']) for (const s of SHARE_SCOPES) assert.ok(PRESETS[p].includes(s), `${p}: ${s}`);
  for (const p of ['work', 'plan', 'agents']) {
    assert.ok(!PRESETS[p].includes('enforcer:write'), `${p} never asks for the umbrella write`);
    assert.ok(!PRESETS[p].some((s) => s.endsWith('.destructive')), `${p} asks for nothing destructive`);
  }
});

test('a server that does not offer them yet is not asked for them', () => {
  const scope = presetScope({ scopes_supported: ['enforcer:read', 'policy:self', 'enforcer:graph-runs.write'] }, 'work');
  for (const s of SHARE_SCOPES) assert.ok(!scope.includes(s));
  const now = presetScope({ scopes_supported: ['enforcer:read', 'policy:self', ...SHARE_SCOPES] }, 'work');
  for (const s of SHARE_SCOPES) assert.ok(now.split(' ').includes(s));
});

test('a recorded ceiling that lacks a requested scope is not reused; an unrecorded one is', () => {
  const want = 'enforcer:read enforcer:graph-sharing.write offline_access';
  assert.equal(ceilingCovers({ client_id: 'c', ceiling: 'enforcer:read' }, want), false);
  assert.equal(ceilingCovers({ client_id: 'c', ceiling: 'enforcer:read enforcer:graph-sharing.write' }, want), true);
  assert.equal(ceilingCovers({ client_id: 'c' }, want), true);
  assert.equal(ceilingCovers(null, want), true);
});

test('savedClient carries the recorded ceiling', () => {
  assert.deepEqual(savedClient({ enforcer: { oauth_client: { client_id: 'c', issuer: 'i', ceiling: 'enforcer:read' } } }), {
    client_id: 'c',
    issuer: 'i',
    ceiling: 'enforcer:read',
  });
  assert.deepEqual(savedClient({ enforcer: { oauth_client: { client_id: 'c' } } }), { client_id: 'c', issuer: null });
});

test('a narrowed grant is never silent', () => {
  const missing = notGranted('enforcer:read enforcer:graph-sharing.write offline_access', 'enforcer:read');
  assert.deepEqual(missing, ['enforcer:graph-sharing.write']);
  assert.deepEqual(notGranted('enforcer:read', 'enforcer:read policy:self'), []);
  const reused = notGrantedLines(missing, true);
  assert.match(reused[0], /^Not granted: enforcer:graph-sharing\.write$/);
  assert.match(reused[1], /--new-app/);
  assert.equal(notGrantedLines(missing, false).length, 2);
  assert.deepEqual(notGrantedLines([], true), []);
});

test('--new-app is parsed out of argv', () => {
  assert.deepEqual(extractNewApp(['browser', '--new-app']), { argv: ['browser'], newApp: true });
  assert.deepEqual(extractNewApp(['status']), { argv: ['status'], newApp: false });
});

test('status names the sharing family', () => {
  assert.ok(FAMILIES.some((f) => f.name.includes('sharing')));
  const lines = scopeLines('enforcer:read policy:self');
  assert.ok(lines.some((l) => /no\s+plan sharing, recruiting and skills: missing enforcer:graph-sharing\.write/.test(l)));
  assert.ok(scopeLines(['enforcer:read', ...SHARE_SCOPES].join(' ')).some((l) => /yes\s+plan sharing/.test(l)));
});
