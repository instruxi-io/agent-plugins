import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scopeLines, WORK_SCOPES } from '../bin/login.mjs';

const LOGIN = new URL('../bin/login.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function runStatus(doc) {
  const home = mkdtempSync(join(tmpdir(), 'login-status-'));
  try {
    if (doc) {
      mkdirSync(join(home, '.enforcer'), { recursive: true });
      writeFileSync(join(home, '.enforcer', 'credentials.json'), JSON.stringify(doc));
    }
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ENFORCER_HOME: join(home, '.enforcer'),
      ENFORCER_BASE_URL: 'http://127.0.0.1:9',
      ENFORCER_API_KEY: '',
    };
    delete env.ENFORCER_API_KEY;
    const r = spawnSync(process.execPath, [LOGIN, 'status'], { env, encoding: 'utf8', timeout: 20000 });
    return r.stdout + r.stderr;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('status lists granted scopes and the families they cover', () => {
  const text = scopeLines(WORK_SCOPES.join(' ')).join('\n');
  assert.match(text, /Granted scopes \(\d+\): enforcer:read/);
  assert.match(text, /yes  graph runs and nodes/);
  assert.match(text, /yes  files/);
  assert.match(text, /yes  workspace switching/);
  // The default sign-in can provision a harness's telemetry key (src/ingest-key.mjs) without a second consent.
  assert.match(text, /yes  agent management/);
  assert.match(text, /yes  telemetry keys/);
});

test('status prints the fix command for a missing family', () => {
  const text = scopeLines(WORK_SCOPES.filter((x) => !x.startsWith('enforcer:agents')).join(' ')).join('\n');
  assert.match(text, /no   agent management: .*Fix: enforcer login --for agents/);
  assert.match(text, /no   telemetry keys .*Fix: enforcer login --for work/);
  assert.match(text, /no   graph import and templates: .*Fix: enforcer login --for plan/);
});

test('status never prints a token', () => {
  const doc = { enforcer: { oauth: { access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', scope: 'enforcer:read' }, api_key: 'SECRET-KEY' } };
  const text = runStatus(doc);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /Granted scopes \(1\): enforcer:read/);
  assert.match(text, /Fix: enforcer login --for work/);
});

test('status handles a signed-out machine', () => {
  const text = runStatus(null);
  assert.match(text, /Not signed in to Enforcer/);
  assert.doesNotMatch(text, /Granted scopes/);
});
