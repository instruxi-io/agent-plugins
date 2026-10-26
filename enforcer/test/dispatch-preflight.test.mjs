// `node test/dispatch-preflight.test.mjs`: the dispatch preflight against a stub graph server. No network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { preflight } from '../src/preflight.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'preflight-'));
let pass = 0,
  fail = 0;
const t = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log('ok  ' + label);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + label + '\n  ' + e.message);
  }
};

// a stub gh that is signed in, a repo root holding one of the two repos the plan names
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
chmodSync(join(bin, 'gh'), 0o755);
const repoRoot = join(tmp, 'apps');
mkdirSync(join(repoRoot, 'present', '.git'), { recursive: true });
// an installed plugin whose gate denies the lander
const oldPlugin = join(tmp, 'old-plugin');
mkdirSync(join(oldPlugin, 'lib/governor/core'), { recursive: true });
writeFileSync(join(oldPlugin, 'plugin.json'), '{"version":"0.0.7"}');
writeFileSync(join(oldPlugin, 'lib/governor/core/gate.mjs'), "export const gate = () => ({ action: 'deny', ruleId: 'git.push', code: 'delivery_shape' });\n");

let planNodes = [
  { key: 'a', data: { repo: 'present' } },
  { key: 'b', data: { repo: 'absent-repo' } },
];
let frontier = [{ id: 'n1', key: 'n1', type: 'task', work_state: 'looking_for_work' }];
const srv = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers['x-api-key'] !== 'good') return send(401, {});
  if (req.url === '/graphs/g1') return send(200, { data: { id: 'g1' } });
  if (req.method === 'POST' && req.url === '/graphs/g1/acceptance/lint') {
    let body = '';
    req.on('data', (d) => (body += d));
    return req.on('end', () =>
      send(200, {
        success: true,
        warnings: JSON.parse(body).acceptance.flatMap((line, index) =>
          /works|passes/.test(line) ? [{ code: 'vague_phrase', index, line, hint: 'name a command' }] : [],
        ),
      }),
    );
  }
  if (req.url.startsWith('/graphs/g1/nodes')) return send(200, { data: planNodes, meta: { total: planNodes.length } });
  if (req.url === '/graphs/g1/frontier') return send(200, { data: frontier });
  send(404, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const env = (extra = {}) => ({
  ...process.env,
  PATH: bin + ':' + process.env.PATH,
  ENFORCER_HOME: join(tmp, 'eh'),
  CLAUDE_CONFIG_DIR: join(tmp, 'cc'),
  GRAPH_BASE_URL: base,
  GRAPH_API_KEY: 'good',
  CLAUDE_PLUGIN_ROOT: ROOT,
  ...extra,
});
const line = (res, name) => res.find((r) => r.name === name);

await t('every check reports, healthy plan passes', async () => {
  const e = env();
  mkdirSync(join(repoRoot, 'absent-repo', '.git'), { recursive: true });
  const res = await preflight({ graph: 'g1', repoRoot, env: e, pluginRoot: ROOT });
  assert.deepEqual(
    res.map((r) => r.name),
    ['credential', 'gh', 'repos', 'acceptance', 'governor-lander', 'worker-rules', 'identity', 'worker-plugin', 'frontier'],
  );
  assert.ok(
    res.every((r) => r.ok),
    JSON.stringify(res.filter((r) => !r.ok)),
  );
  rmSync(join(repoRoot, 'absent-repo'), { recursive: true });
});

await t('missing repo checkout names the repo', async () => {
  const res = await preflight({ graph: 'g1', repoRoot, env: env(), pluginRoot: ROOT });
  const r = line(res, 'repos');
  assert.equal(r.ok, false);
  assert.match(r.line, /absent-repo/);
  assert.doesNotMatch(r.line, /present \(/);
});

await t('denying installed governor is reported with the plugin version', async () => {
  const res = await preflight({ graph: 'g1', repoRoot, env: env(), pluginRoot: oldPlugin });
  const r = line(res, 'governor-lander');
  assert.equal(r.ok, false);
  assert.match(r.line, /installed enforcer 0\.0\.7 denies the lander; update the plugin|installed enforcer 0\.0\.7 denies the lander/);
});

await t('bad credential says to sign in', async () => {
  const res = await preflight({ graph: 'g1', repoRoot, env: env({ GRAPH_API_KEY: 'bad' }), pluginRoot: ROOT });
  assert.match(line(res, 'credential').line, /sign in: \/enforcer:login/);
});

await t('empty frontier fails', async () => {
  frontier = [{ id: 'g', key: 'g', type: 'gate', work_state: 'looking_for_work' }];
  const res = await preflight({ graph: 'g1', repoRoot, env: env(), pluginRoot: ROOT });
  assert.equal(line(res, 'frontier').ok, false);
  frontier = [{ id: 'n1', key: 'n1', type: 'task', work_state: 'looking_for_work' }];
});

await t('CLI prints one line per check and exits 2 on a failure', async () => {
  const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'dispatch', 'preflight', 'g1', '--repo-root', repoRoot], { env: env() });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 2);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 9, out);
  assert.match(out, /fail {2}repos: missing: absent-repo/);
  console.log(out.trimEnd().replace(/^/gm, '    '));
});

const withNodes = async (nodes, opts, fn) => {
  const saved = planNodes;
  planNodes = nodes;
  mkdirSync(join(repoRoot, 'absent-repo', '.git'), { recursive: true });
  try {
    return await fn(await preflight({ graph: 'g1', repoRoot, env: env(), pluginRoot: ROOT, ...opts }));
  } finally {
    planNodes = saved;
    rmSync(join(repoRoot, 'absent-repo'), { recursive: true, force: true });
  }
};

await t('a vague acceptance line fails preflight naming the node and code', () =>
  withNodes([{ key: 'vague-one', type: 'task', data: { acceptance: ['`npm test` exits 0', 'everything works fine'] } }], {}, (res) => {
    const r = line(res, 'acceptance');
    assert.equal(r.ok, false);
    assert.match(r.line, /vague-one: line 1 vague_phrase — everything works fine/);
  }),
);

await t('a task node with no acceptance fails preflight with acceptance_missing', () =>
  withNodes([{ key: 'bare', type: 'task', data: {} }], {}, (res) => {
    const r = line(res, 'acceptance');
    assert.equal(r.ok, false);
    assert.match(r.line, /bare: acceptance_missing/);
  }),
);

await t('--allow-lint-warnings turns the failure into a warning', () =>
  withNodes([{ key: 'vague-one', type: 'task', data: { acceptance: ['it works'] } }], { allowLintWarnings: true }, (res) => {
    const r = line(res, 'acceptance');
    assert.equal(r.ok, true);
    assert.match(r.line, /warning.*vague-one: line 0 vague_phrase/);
  }),
);

await t('done nodes and non-dispatch types are not linted', () =>
  withNodes(
    [
      { key: 'old', type: 'task', status: 'done', data: {} },
      { key: 'g', type: 'gate', data: {} },
    ],
    {},
    (res) => assert.equal(line(res, 'acceptance').ok, true),
  ),
);

srv.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
console.log(`pass ${pass}\nfail ${fail}`);
process.exit(fail ? 1 : 0);
