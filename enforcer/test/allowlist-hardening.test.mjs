// `node --test enforcer/test/allowlist-hardening.test.mjs`: three audited defects in the path that runs graph-authored
// acceptance lines. grep -R follows symlinks out of the checkout, plan check built a directory from data.repo, and the
// gh pr view shape ran with no credential. No network, temp HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'allowlist-hardening-')));
process.env.HOME = join(tmp, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.ENFORCER_STATE_DIR = join(tmp, 'state');
mkdirSync(process.env.HOME, { recursive: true });
after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold a cwd */
  }
});

const allow = await import('../src/acceptance-allowlist.mjs');
const { planCheck } = await import('../src/plan-check.mjs');

const repo = join(tmp, 'repo');
const outside = join(tmp, 'outside');
mkdirSync(repo, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET\n');
writeFileSync(join(repo, 'inside.txt'), 'TOPSECRET\n');
let linked = true;
try {
  symlinkSync(outside, join(repo, 'link'), 'dir');
} catch {
  linked = false; // Windows without the privilege
}

test('grep -R is refused and grep -r still runs', () => {
  assert.ok(allow.allowedCommand('grep -R TOPSECRET .', { root: repo }).skip, '-R must not match any shape');
  assert.ok(allow.allowedCommand('grep -rn TOPSECRET .', { root: repo }).argv, '-r stays allowed');
  const ok = allow.allowedCommand('grep -r TOPSECRET inside.txt', { root: repo });
  const r = allow.spawnAllowed(ok.argv, { cwd: repo });
  assert.match(r.out, /TOPSECRET/);
  if (linked) {
    // -r does not follow the link found inside the tree, so the outside file is never read
    const rr = allow.spawnAllowed(allow.allowedCommand('grep -r TOPSECRET .', { root: repo }).argv, { cwd: repo });
    assert.ok(!rr.out.includes('secret.txt'), rr.out);
  }
});

test('a data.repo outside the checkout is refused by plan check', async () => {
  const apps = join(tmp, 'apps');
  mkdirSync(join(apps, 'r1'), { recursive: true });
  mkdirSync(join(tmp, 'secretdir'), { recursive: true });
  writeFileSync(join(tmp, 'secretdir', 'say.mjs'), "console.log('LEAKED');\n");
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/graphs/g1/nodes'))
      return res.end(
        JSON.stringify({
          data: [{ key: 'bad', status: 'ready', data: { repo: '../secretdir', acceptance: ["node say.mjs prints 'LEAKED'"] } }],
          meta: { total: 1 },
        }),
      );
    res.end(JSON.stringify({ warnings: [] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const env = { ...process.env, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'k' };
    const r = await planCheck({ graph: 'g1', repoRoot: join(apps), env });
    const text = r.lines.join('\n');
    assert.match(text, /WARN bad: data\.repo "\.\.\/secretdir"/);
    assert.ok(!/last line/.test(text) && !/^ok /m.test(text), text);
    assert.equal(r.ok, 0);
    assert.equal(r.skipped, 1);
  } finally {
    srv.close();
  }
});

const ghLine = 'gh pr view 7 -R o/r --json state';

test('the gh shape skips without a token', () => {
  const r = allow.allowedCommand(ghLine, { root: repo, env: { PATH: process.env.PATH } });
  assert.equal(r.skip, 'no GH_TOKEN for gh');
  assert.equal(allow.allowedCommand(ghLine, { root: repo, env: { GITHUB_TOKEN: 't' } }).shape, 'gh pr view');
});

test('the gh shape passes GH_TOKEN through read-only', () => {
  const env = { PATH: 'x', GH_TOKEN: 'tok', GH_CONFIG_DIR: '/cfg', AWS_SECRET: 's' };
  const g = allow.isolatedEnv(env, '/h', { gh: true });
  assert.equal(g.GH_TOKEN, 'tok');
  assert.equal(g.GH_CONFIG_DIR, '/cfg');
  assert.equal(g.AWS_SECRET, undefined);
  const other = allow.isolatedEnv(env, '/h');
  assert.equal(other.GH_TOKEN, undefined, 'no other shape gets the token');
  let seen;
  allow.spawnAllowed(['gh', 'pr', 'view', '7'], { env, run: (_b, _a, o) => ((seen = o.env), { status: 0, stdout: '', stderr: '' }) });
  assert.equal(seen.GH_TOKEN, 'tok');
  allow.spawnAllowed(['cat', 'f'], { env, run: (_b, _a, o) => ((seen = o.env), { status: 0, stdout: '', stderr: '' }) });
  assert.equal(seen.GH_TOKEN, undefined);
  if (process.platform !== 'win32') {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "TOKEN=$GH_TOKEN HOME=$HOME"\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const r = allow.spawnAllowed(['gh', 'pr', 'view', '7'], { env: { ...env, PATH: bin + delimiter + process.env.PATH } });
    assert.match(r.out, /TOKEN=tok HOME=/);
    assert.ok(!r.out.includes(`HOME=${process.env.HOME}`));
  }
});
