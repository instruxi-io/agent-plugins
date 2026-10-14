// `node test/dispatch-command.test.mjs`: `enforcer dispatch --help|status|stop` against a stub graph. No network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'dispatch-cmd-'));
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

const nodes = [
  { key: 'a', status: 'done', type: 'task' },
  { key: 'b', status: 'running', type: 'task', updated_at: new Date(Date.now() - 7 * 60000).toISOString(), data: { tier: 'standard' } },
  { key: 'c', status: 'ready', type: 'task' },
  { key: 'd', status: 'ready', type: 'task' },
  { key: 'g', status: 'ready', type: 'gate', title: 'Human smoke test' },
  { key: 'r', status: 'verifying', type: 'task' },
];
const srv = http.createServer((req, res) => {
  const send = (c, b) => {
    res.writeHead(c, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  if (req.headers['x-api-key'] !== 'good') return send(401, {});
  if (req.url.startsWith('/graphs/g1/nodes')) return send(200, { data: nodes, meta: { total: nodes.length } });
  send(404, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const cfg = join(tmp, 'cfg');
const sd = join(cfg, 'dispatch', 'g1');
mkdirSync(sd, { recursive: true });
writeFileSync(join(sd, 'dispatcher.log'), 'x\nLANDING-BLOCKED c: conflict\nCI-UNAVAILABLE held\nsecond to last\ndispatching g1 with 3 workers\n');
const run = (args, extra = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'dispatch', ...args], {
      env: { ...process.env, ENFORCER_CONFIG_HOME: cfg, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'good', ...extra },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

await t('--help prints the three subcommands and the defaults', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /enforcer dispatch <graph>/);
  assert.match(r.out, /dispatch status/);
  assert.match(r.out, /dispatch stop/);
  assert.match(r.out, /defaults: 3 workers, sonnet model cap, salvage on, triage on, warm workers off/);
});
await t('status prints workers, nodes, review items, gates and the last line', async () => {
  const r = await run(['status', 'g1']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^workers \(1\):\n  b  7 min  sonnet/m);
  assert.match(r.out, /^nodes: 1 done, 5 open, 1 landing blocked, 2 needs you/m);
  assert.match(r.out, /^review items \(1\):\n  r:/m);
  assert.match(r.out, /^gates open \(1\):\n  g: Human smoke test\n    answer: ! graphwatch decide g1 g approve\|reject --note "<why>"/m);
  assert.match(r.out, /^  answer: ! graphwatch inbox g1 .*graphwatch resolve g1 <item> approve\|reject\|override/m);
  assert.match(r.out, /^last line: dispatching g1 with 3 workers/m);
  assert.doesNotMatch(r.out, /failed/);
  console.log(r.out.trimEnd().replace(/^/gm, '    '));
});
await t('stop with no dispatcher running says so', async () => {
  const r = await run(['stop', 'g1']);
  assert.equal(r.code, 0);
  assert.match(r.out, /no dispatcher is running for g1/);
});
await t('stop touches STOP and waits for the drain', async () => {
  const child = spawn('sleep', ['30']);
  writeFileSync(join(sd, 'pids.json'), JSON.stringify({ dispatcher: child.pid }));
  setTimeout(() => child.kill(), 1500);
  const r = await run(['stop', 'g1']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dispatcher stopped/);
  assert.ok(!existsSync(join(sd, 'STOP')));
});
srv.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
