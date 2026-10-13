// `node --test enforcer/test/acceptance-allowlist.test.mjs`: acceptance lines come from the graph, so they run only in a
// shape from the one allow list (src/acceptance-allowlist.mjs). Every probe a reviewer used to write a file outside the
// checkout must not run through any caller, real acceptance lines from the plugin 1.3 and hardening plans must still
// run, every caller uses the same list, and an allowed line runs with a temporary HOME. No network, temp HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// never the developer's HOME or state: set before the modules under test are loaded
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'acceptance-allowlist-test-')));
const realHome = process.env.HOME;
process.env.HOME = join(tmp, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.ENFORCER_STATE_DIR = join(tmp, 'state');
mkdirSync(process.env.HOME, { recursive: true });
after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold the cwd of a just-exited child */
  }
});

const allow = await import('../src/acceptance-allowlist.mjs');
const evidenceRun = await import('../src/evidence-run.mjs');
const planCheck = await import('../src/plan-check.mjs');
const attach = await import('../src/graph/hooks/attach.mjs');
const land = await import('../src/dispatch/land-complete.mjs');

// the checkout the lines run in, and a directory OUTSIDE it where a hostile line would leave its marker
const repo = join(tmp, 'repo');
const outside = join(tmp, 'outside');
for (const d of [repo, outside, join(repo, 'enforcer', 'test'), join(repo, 'changes'), join(repo, 'graphwatch'), join(repo, 'test')])
  mkdirSync(d, { recursive: true });
writeFileSync(join(repo, 'f.txt'), 'hello\n');
writeFileSync(join(repo, 'changes', 'gov-one-boolean-predicate.md'), 'x\n');
writeFileSync(join(repo, 'enforcer', 'test', 'ok.test.mjs'), "import { test } from 'node:test';\ntest('fixture passes', () => {});\n");
writeFileSync(join(repo, 'test', 'version-identity.test.mjs'), "console.log('# fail 0');\n");
writeFileSync(join(repo, 'env.mjs'), 'console.log(JSON.stringify({ home: process.env.HOME, keys: Object.keys(process.env) }));\n');

const node = (acceptance) => ({ key: 'k', node_id: 'n1', graph_id: 'g1', data: { acceptance } });
const spy = (log) => (cmd, args, opts) => {
  log.push({ cmd, args, opts });
  return { status: 0, stdout: 'ok\n', stderr: '' };
};

test('hostile acceptance lines never run', () => {
  const marker = (n) => join(outside, `pwned-${n}`);
  // every probe from the v1.3.0 audit, each with its own marker outside the checkout, plus a few more of the same kind
  const probes = [
    (m) => `bash -c "touch ${m}"`,
    (m) => `cat f.txt>${m}`,
    (m) => `node -e "require('fs').writeFileSync('${m}','x')"`,
    (m) => `ls $(touch ${m})`,
    (m) => `ls \`touch ${m}\``,
    (m) => `ls\ntouch ${m}`,
    () => 'bash -c "c""url --version"',
    () => 'cd / && ls',
    (m) => `ls ; touch ${m}`,
    (m) => `cat f.txt | tee ${m}`,
    (m) => `head -n 1 f.txt && touch ${m}`,
    (m) => `sh -c 'touch ${m}'`,
    () => 'cat ../outside/secret',
    () => `cat ${join(outside, 'secret')}`,
    () => 'node ../outside/evil.mjs',
    () => 'npm --prefix .. test',
    () => 'pnpm -C .. test',
    () => 'pnpm generate',
    (m) => `pnpm exec touch ${m}`,
    (m) => `pnpm --filter touch ${m} test`,
    () => 'node --test --require=../outside/evil.mjs f.txt',
    () => 'grep -f ../outside/secret f.txt',
    () => 'git grep --open-files-in-pager=touch hello',
    () => 'go -C graphwatch test ./... -exec ../outside/evil',
    () => 'npx some-package',
    () => 'python3 x.py',
    () => 'make all',
    () => "ls 'f'.txt",
  ];
  writeFileSync(join(outside, 'secret'), 's3cret');
  writeFileSync(join(outside, 'evil.mjs'), `require('fs').writeFileSync(${JSON.stringify(marker('evil'))}, 'x');\n`);
  const lines = probes.map((p, i) => `${p(marker(i))} prints \`x\``);

  // evidence-run (and through it the report hook and the landing completion): nothing reaches spawn
  const log = [];
  const r = evidenceRun.runEvidence(node(lines), { cwd: repo, graph: 'g1', run: spy(log) });
  assert.deepEqual(log, [], `spawned: ${JSON.stringify(log.map((l) => [l.cmd, l.args]))}`);
  assert.equal(r.items.length, 0);
  for (const s of r.skipped) assert.match(s.reason, /not run: not an allowed command shape/, `line ${s.line_index}: ${lines[s.line_index]}`);
  assert.equal(r.skipped.length, lines.length);

  // and for real, with the real spawn: no marker appears
  evidenceRun.runEvidence(node(lines), { cwd: repo, graph: 'g1', timeoutMs: 5000 });
  // plan check
  for (const l of lines) {
    const c = planCheck.checkLine(l, repo, process.env, { timeoutMs: 5000, graph: 'g1' });
    assert.equal(c.state, 'SKIPPED', l);
    assert.match(c.note, /not an allowed command shape/, l);
  }
  // the report hook
  const recs = attach.acceptanceRecords({ cwd: repo }, { key: 'k', node_id: 'n1', graph_id: 'g1', acceptance: lines }, { acceptanceRun: spy(log) });
  assert.deepEqual(log, []);
  assert.ok(!recs.some((e) => e.kind === 'command'));
  assert.equal(recs.filter((e) => e.kind === 'note' && /not an allowed command shape/.test(e.text)).length, lines.length);
  // the dispatcher's landing completion
  assert.deepEqual(land.acceptanceCommands(node(lines), repo), []);
  assert.deepEqual(land.landingEvidence(node(lines), repo, { run: spy(log) }), []);
  assert.deepEqual(log, []);

  for (let i = 0; i < probes.length; i++) assert.equal(existsSync(marker(i)), false, `marker ${i} written by: ${lines[i]}`);
  assert.equal(existsSync(marker('evil')), false);
});

// ten real acceptance lines, copied verbatim from the plugin 1.3 and hardening plans (graph f8abc5f0)
const REAL = [
  '`node --test enforcer/test/acceptance-allowlist.test.mjs` exits 0, prints a `# fail 0` line, and prints lines containing `- hostile acceptance lines never run` and `- legitimate acceptance lines still run`',
  '`node --test enforcer/lib/governor/test/one-predicate.test.mjs` exits 0, prints a `# fail 0` line, and prints lines containing `- status and gate agree for every accepted spelling` and `- a string false in config.json turns the rules off and status says OFF`',
  '`node --test enforcer/test/dispatch-secret-hygiene.test.mjs` exits 0, prints a `# fail 0` line, and prints lines containing `- startup removes stale mcp config files` and `- startup redacts existing worker logs`',
  '`npm --prefix enforcer test` exits 0 and a line contains `suites passed, 0 failed`',
  '`ls changes/gov-one-boolean-predicate.md` prints `changes/gov-one-boolean-predicate.md`',
  '`go -C graphwatch test ./... -count=1` exits 0 and prints a line starting `ok  \tgithub.com/instruxi-io/enforcer-graph-demos/graphwatch`',
  "`go -C graphwatch test ./... -count=1 -v -run 'TestLayersGoldenPinned|TestMyceliumGoldenPinned'` exits 0, prints `--- PASS: TestLayersGoldenPinned`, `--- PASS: TestMyceliumGoldenPinned`",
  "`grep -c '0.0.0.0' enforcer/lib/governor/otel/collector.yaml` prints `0`",
  "`grep -c '^## 1.3.1' CHANGELOG.md` prints `1`",
  '`node test/version-identity.test.mjs` exits 0 and prints a `# fail 0` line',
  "`git grep -n -E '\\(#[0-9]{2,4}\\)' -- graphwatch graph-live` exits 1 (no match)",
  '`pnpm --filter @instruxi-io/graph-hooks typecheck` exits 0',
  '`pnpm -C graphwatch run lint` exits 0',
];

test('legitimate acceptance lines still run', () => {
  const log = [];
  const r = evidenceRun.runEvidence(node(REAL), { cwd: repo, graph: 'g1', run: spy(log) });
  assert.deepEqual(r.skipped, [], JSON.stringify(r.skipped));
  assert.equal(log.length, REAL.length);
  for (const l of log) {
    assert.equal(l.opts.shell, false);
    assert.ok(!['bash', 'sh', 'cmd', 'cmd.exe'].includes(l.cmd), l.cmd);
    assert.equal(l.opts.cwd, repo);
  }
  // single-quoted tokens arrive as one literal argument, never through a shell
  const grep = log.find((l) => l.cmd === 'grep' && l.args.includes('^## 1.3.1'));
  assert.deepEqual(grep.args, ['-c', '^## 1.3.1', 'CHANGELOG.md']);
  const go = log.find((l) => l.cmd === 'go' && l.args.includes('-run'));
  assert.deepEqual(go.args, [
    '-C',
    'graphwatch',
    'test',
    '-tags',
    'integration',
    './...',
    '-count=1',
    '-v',
    '-run',
    'TestLayersGoldenPinned|TestMyceliumGoldenPinned',
  ]);
  // plan check accepts the same lines, and a PR view with its number filled in
  for (const l of REAL) assert.equal(planCheck.skipReason(planCheck.parseLine(l).cmd, repo), null, l);
  const hadToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token'; // the gh shape is skipped without one
  try {
    assert.equal(planCheck.skipReason('gh pr view 229 -R instruxi-io/claude-plugins --json state,mergeCommit', repo), null);
  } finally {
    if (hadToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = hadToken;
  }
  assert.equal(planCheck.skipReason('git merge-base --is-ancestor 38913ec origin/main', repo), null);

  // and for real: node lines run and their literals are found
  const real = evidenceRun.runEvidence(
    node([
      '`node --test enforcer/test/ok.test.mjs` exits 0 and prints a `# fail 0` line',
      '`node test/version-identity.test.mjs` exits 0 and prints a `# fail 0` line',
    ]),
    { cwd: repo, graph: 'g1' },
  );
  assert.deepEqual(
    real.items.map((i) => i.exit),
    [0, 0],
    JSON.stringify(real.items),
  );
  assert.equal(real.found, real.total);
  assert.equal(planCheck.checkLine('`node test/version-identity.test.mjs` prints `# fail 0`', repo, process.env).state, 'ok');
  if (process.platform !== 'win32') {
    const ls = evidenceRun.runEvidence(node([REAL[4]]), { cwd: repo });
    assert.equal(ls.items[0].exit, 0);
    assert.equal(ls.found, 1);
  }
});

test('the allow list is one shared structure', () => {
  const shapes = allow.ACCEPTANCE_SHAPES;
  assert.ok(Array.isArray(shapes) && shapes.length > 0);
  assert.ok(Object.isFrozen(shapes));
  for (const s of shapes) assert.ok(Object.isFrozen(s) && s.name && s.usage && typeof s.match === 'function', s.name);
  // every caller exposes the very same object, not a copy
  assert.equal(evidenceRun.ACCEPTANCE_SHAPES, shapes);
  assert.equal(planCheck.ACCEPTANCE_SHAPES, shapes);
  assert.equal(attach.ACCEPTANCE_SHAPES, shapes);
  assert.equal(land.ACCEPTANCE_SHAPES, shapes);
  // and none keeps a runner list of its own or runs a line through a shell
  for (const f of [
    'src/evidence-run.mjs',
    'src/plan-check.mjs',
    'src/graph/hooks/attach.mjs',
    'src/dispatch/land-complete.mjs',
    'src/acceptance-allowlist.mjs',
  ]) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /RUNNERS\s*=|RUNNABLE\s*=/, `${f} keeps its own runner list`);
    assert.doesNotMatch(src, /\(\s*'(ba)?sh'\s*,\s*\[\s*'-c'/, `${f} runs a line through a shell`);
  }
  // the list is documented in docs/graph/
  const doc = readFileSync(join(ROOT, 'docs', 'graph', 'README.md'), 'utf8');
  assert.match(doc, /### Which acceptance lines run/);
  for (const s of shapes) assert.ok(doc.includes(`| ${s.name} |`) || doc.includes(s.name), `docs/graph/README.md does not name ${s.name}`);
  assert.match(doc, /not run: not an allowed command shape/);
});

test('a runnable line gets a temporary HOME', () => {
  const env = {
    ...process.env,
    HOME: realHome || process.env.HOME,
    GH_TOKEN: 'gh-s3cret',
    ENFORCER_API_KEY: 'k-s3cret',
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
  const line = '`node env.mjs` prints `home`';
  const check = (out, who) => {
    const seen = JSON.parse(out.trim().split('\n').at(-1));
    assert.notEqual(seen.home, env.HOME, `${who}: the real HOME leaked`);
    assert.ok(seen.home.includes('enforcer-accept-'), `${who}: HOME is ${seen.home}`);
    assert.equal(existsSync(seen.home), false, `${who}: the temporary HOME was not removed`);
    for (const k of ['GH_TOKEN', 'ENFORCER_API_KEY', 'NODE_OPTIONS', 'ENFORCER_STATE_DIR'])
      assert.ok(!seen.keys.includes(k), `${who}: ${k} reached the command`);
    return seen.home;
  };
  // enforcer evidence run (and the landing completion, which calls it)
  const a = evidenceRun.runEvidence(node([line]), { cwd: repo, env });
  const h1 = check(a.items[0].output, 'evidence run');
  const b = evidenceRun.runEvidence(node([line]), { cwd: repo, env });
  assert.notEqual(check(b.items[0].output, 'evidence run'), h1, 'each run gets its own HOME');
  // the report hook
  const recs = attach.acceptanceRecords({ cwd: repo }, { key: 'k', node_id: 'n1', graph_id: 'g1', acceptance: [line] });
  check(recs.find((e) => e.kind === 'command').output, 'report hook');
  // plan check: the line passes only when HOME is a temp dir and no credential is in the environment
  assert.equal(planCheck.checkLine('`node env.mjs` prints `enforcer-accept-`', repo, env).state, 'ok');
  assert.equal(planCheck.checkLine('`node env.mjs` prints `GH_TOKEN`', repo, env).state, 'MISMATCH');
  // the environment builder itself
  const e = allow.isolatedEnv(env, '/tmp/h');
  assert.equal(e.HOME, '/tmp/h');
  assert.equal(e.GH_TOKEN, undefined);
  assert.equal(e.ENFORCER_API_KEY, undefined);
});
