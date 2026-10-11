// `node --test test/credential-routing.test.mjs`: a cloned repo cannot steer the operator's credential; a failed mint does not launch; workers do not see the sign-in.
// Temp dirs and a temp HOME only: no network, no live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfig } from '../src/graph/hooks/common.mjs';
import { workerEnv } from '../src/dispatch/launch.mjs';
import { redactLogsDir } from '../src/dispatch/logs.mjs';
import { Dispatcher, defaultArgs } from '../src/dispatch/run.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'crt-'));
const repoWith = (cfg) => {
  const d = tmp();
  mkdirSync(join(d, '.enforcer'));
  writeFileSync(join(d, '.enforcer', 'graph.json'), JSON.stringify(cfg));
  return d;
};
const withEnv = async (vars, fn) => {
  const keep = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(ENFORCER|GRAPH)_/.test(k)) delete process.env[k];
  process.env.HOME = tmp();
  process.env.USERPROFILE = process.env.HOME;
  Object.assign(process.env, vars);
  const errs = [];
  const w = process.stderr.write;
  process.stderr.write = (c) => (errs.push(String(c)), true);
  try {
    return await fn(errs);
  } finally {
    process.stderr.write = w;
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
};

test('a repo graph.json cannot point the credential at a foreign host', async () => {
  const d = repoWith({ graph_id: 'g', base_url: 'http://evil.example' });
  await withEnv({ GRAPH_API_KEY: 'k' }, (errs) => {
    const c = findConfig(d);
    assert.notEqual(c?.base_url, 'http://evil.example');
    assert.ok(errs.some((e) => e.includes('evil.example')));
  });
  const ok = repoWith({ graph_id: 'g', base_url: 'http://127.0.0.1:9' });
  await withEnv({ GRAPH_API_KEY: 'k' }, () => assert.equal(findConfig(ok).base_url, 'http://127.0.0.1:9'));
});

test('a repo graph.json cannot name a foreign secret as the key', async () => {
  const d = repoWith({ graph_id: 'g', base_url: 'http://localhost:1', api_key_env: 'AWS_SECRET_ACCESS_KEY' });
  await withEnv({ AWS_SECRET_ACCESS_KEY: 'topsecret' }, (errs) => {
    const c = findConfig(d);
    assert.ok(!c || c.api_key !== 'topsecret');
    assert.ok(errs.some((e) => e.includes('AWS_SECRET_ACCESS_KEY')));
  });
  const ok = repoWith({ graph_id: 'g', base_url: 'http://localhost:1', api_key_env: 'ENFORCER_MY_KEY' });
  await withEnv({ ENFORCER_MY_KEY: 'mine' }, () => assert.equal(findConfig(ok).api_key, 'mine'));
});

test('a failed token mint does not launch the worker', async () => {
  const state = tmp();
  const logs = [];
  const args = defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), agentKey: 'ag_FULLPOWER0123456789' });
  const api = {
    call: async () => {
      throw Object.assign(new Error('boom'), { status: 503 });
    },
  };
  const d = new Dispatcher(api, args, (m) => logs.push(m));
  d.say = (m) => logs.push(m);
  const keep = process.env.ENFORCER_WORKER_AGENT_ID;
  process.env.ENFORCER_WORKER_AGENT_ID = 'agent-1';
  try {
    const n = { key: 'n1', id: 'id1', type: 'task', title: 't', data: {} };
    try {
      await d.launch?.(n, {});
    } catch {
      /* the launch path may need more fixtures; the assertion is on what was recorded */
    }
  } finally {
    if (keep === undefined) delete process.env.ENFORCER_WORKER_AGENT_ID;
    else process.env.ENFORCER_WORKER_AGENT_ID = keep;
  }
  assert.equal(d.workers.size, 0);
  assert.ok(
    logs.some((l) => /worker token mint failed: 503/.test(l)),
    logs.join('\n'),
  );
});

test('workers get an empty ENFORCER_HOME and a .log is redacted', () => {
  const home = tmp();
  mkdirSync(join(home, '.enforcer'));
  writeFileSync(join(home, '.enforcer', 'credentials.json'), '{"enforcer":{"api_key":"x"}}');
  const empty = join(tmp(), 'home-n1');
  mkdirSync(empty);
  const env = workerEnv('g', { PATH: '/bin', HOME: home, ENFORCER_HOME: join(home, '.enforcer') }, { token: 'ag_TOK', enforcerHome: empty });
  assert.equal(env.ENFORCER_HOME, empty);
  assert.equal(env.HOME, home);
  assert.ok(!existsSync(join(env.ENFORCER_HOME, 'credentials.json')));
  const logs = tmp();
  const p = join(logs, 'n.1.log');
  writeFileSync(p, 'token ag_ABCDEFGH12345678 here\n');
  redactLogsDir(logs, []);
  assert.ok(!readFileSync(p, 'utf8').includes('ag_ABCDEFGH'));
});
