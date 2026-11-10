// `node test/dispatch-preflight.test.mjs`: the dispatch preflight against a stub graph server. No network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
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
// cases that lean on a real `git` on PATH, the execute bit, or a dispatcher start: none of which Windows has here
const tPosix =
  process.platform === 'win32' ? async (label) => console.log(`skip  ${label} (needs POSIX commands on PATH; the dispatcher is not supported on Windows)`) : t;

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
// skill source: null = the server has no skill-source routes (404 {}); else {get: [status, body], sync: [status, body]}
let skillSource = null;
let nodeSkills = {}; // node id -> resolved skill rows
const seen = [];
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
        errors: JSON.parse(body).acceptance.flatMap((line, index) =>
          /works|passes/.test(line) ? [{ code: 'vague_phrase', index, line, hint: 'name a command' }] : [],
        ),
        warnings: JSON.parse(body).acceptance.flatMap((line, index) => (/prose-only/.test(line) ? [{ code: 'prose_row', index, line }] : [])),
      }),
    );
  }
  seen.push(`${req.method} ${req.url}`);
  if (req.url === '/graphs/g1/skill-source' && req.method === 'GET' && skillSource) return send(...skillSource.get);
  if (req.url === '/graphs/g1/skill-source/sync' && req.method === 'POST' && skillSource) {
    const r = skillSource.sync;
    if (skillSource.after) skillSource.get = skillSource.after;
    return send(...r);
  }
  const ns = /^\/graphs\/g1\/nodes\/([^/?]+)\/skills$/.exec(req.url);
  if (ns) return send(200, { success: true, data: nodeSkills[ns[1]] || [] });
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
    ['credential', 'gh', 'repos', 'acceptance', 'governor-lander', 'worker-rules', 'identity', 'worker-plugin', 'frontier', 'skills'],
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
  assert.equal(lines.length, 10, out);
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

await t('server warnings print but do not fail preflight', () =>
  withNodes([{ key: 'rev', type: 'task', data: { acceptance: ['prose-only review of the diff'] } }], {}, (res) => {
    const r = line(res, 'acceptance');
    assert.equal(r.ok, true);
    assert.match(r.line, /warnings: rev: line 0 prose_row/);
  }),
);

await t('a warnings-only reply with no errors key does not fail preflight', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, warnings: [{ code: 'no_command', index: 0, line: 'x' }] }), { status: 200 });
  try {
    const { acceptanceLintReport } = await import('../src/preflight.mjs');
    const r = await acceptanceLintReport('http://x', 'g1', {}, [{ key: 'rv', type: 'task', data: { acceptance: ['review it'] } }]);
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings[0], /rv: line 0 no_command/);
  } finally {
    globalThis.fetch = orig;
  }
});

await t('an unreachable lint endpoint falls back to the local list as warnings', async () => {
  const saved = planNodes;
  planNodes = [{ key: 'off', type: 'task', data: { acceptance: ['`rm -rf x` exits 0'] } }];
  const orig = globalThis.fetch;
  try {
    const { acceptanceLintReport } = await import('../src/preflight.mjs');
    const r = await acceptanceLintReport('http://127.0.0.1:1', 'g1', {}, planNodes);
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings[0], /off: line 0 local_not_allowlisted/);
  } finally {
    globalThis.fetch = orig;
    planNodes = saved;
  }
});

// --- skills (SKILL_SOURCE_CONTRACT §7) ---
const repoNode = (id, extra = {}) => ({ id, key: id, type: 'task', work_state: 'looking_for_work', data: { repo: 'present' }, ...extra });
const DELIVER = { position: 0, source: 'graph', skill: { slug: 'deliver-via-github-pr', metadata: {} } };
const repoSkill = (slug, meta) => ({
  position: 0,
  source: 'repo',
  skill: { slug, version: 0, metadata: { source: { repo: 'o/skills', commit: 'c'.repeat(40) }, ...meta } },
});
const SRC = { repo: 'instruxi-io/enforcer-graph-skills', ref: 'main', path: 'skills', resolved_commit: '1a2b3c4d'.padEnd(40, '0') };
const withSkills = async ({ front, skills = {}, source = null }, fn, opts = {}) => {
  const saved = [frontier, nodeSkills, skillSource];
  frontier = front;
  nodeSkills = skills;
  skillSource = source;
  seen.length = 0;
  try {
    return await fn(await preflight({ graph: 'g1', repoRoot, env: env(), pluginRoot: ROOT, ...opts }));
  } finally {
    [frontier, nodeSkills, skillSource] = saved;
  }
};

await t('skills: no source, a node with data.repo carrying the legacy deliver-via-github-pr slug passes', () =>
  withSkills({ front: [repoNode('n1')], skills: { n1: [DELIVER] } }, (res) => {
    const r = line(res, 'skills');
    assert.equal(r.ok, true, r.line);
    assert.equal(r.line, 'ok (no skill source)');
    assert.ok(seen.includes('GET /graphs/g1/nodes/n1/skills'));
  }),
);

await t('skills: a server without the skill-source routes (404 with no code, or 405) is a graph with no source', async () => {
  await withSkills({ front: [repoNode('n1')], skills: { n1: [DELIVER] } }, (res) => assert.equal(line(res, 'skills').ok, true));
  await withSkills({ front: [repoNode('n1')], skills: { n1: [DELIVER] }, source: { get: [405, {}], sync: [405, {}] } }, (res) =>
    assert.equal(line(res, 'skills').line, 'ok (no skill source)'),
  );
  await withSkills(
    {
      front: [repoNode('n1')],
      skills: { n1: [DELIVER] },
      source: { get: [200, { success: true, data: { source: null } }], sync: [404, { error: 'skill_source_not_found' }] },
    },
    (res) => {
      assert.equal(line(res, 'skills').line, 'ok (no skill source)');
      assert.ok(!seen.some((x) => x.startsWith('POST')), 'no sync without a source');
    },
  );
});

await t('skills: a node with data.repo and no delivery skill fails naming it (the 2026-11-10 graph)', () =>
  withSkills({ front: [repoNode('spark-1'), repoNode('n2')], skills: { n2: [DELIVER] } }, (res) => {
    const r = line(res, 'skills');
    assert.equal(r.ok, false);
    assert.match(
      r.line,
      /^no delivery skill: spark-1; set a skill source \(enforcer skills source set g1 --repo owner\/name\) or attach deliver-via-github-pr$/,
    );
  }),
);

await t('skills: nodes with no data.repo, merge nodes naming a PR and non-dispatch types need no delivery skill', () =>
  withSkills(
    {
      front: [
        { id: 'plain', key: 'plain', type: 'task', data: {} },
        repoNode('m', { type: 'merge', data: { repo: 'present', pr: 12 } }),
        repoNode('rel', { type: 'release' }),
      ],
    },
    (res) => {
      assert.equal(line(res, 'skills').ok, true, line(res, 'skills').line);
      assert.ok(!seen.some((x) => /\/skills$/.test(x)), seen.join(','));
    },
  ),
);

await t('skills: data.repo comes from the node list when the frontier row has no data', async () => {
  const saved = planNodes;
  planNodes = [{ id: 'bare', key: 'bare', type: 'task', data: { repo: 'present', acceptance: ['`true` exits 0'] } }];
  try {
    await withSkills({ front: [{ id: 'bare', key: 'bare', type: 'task' }] }, (res) => assert.match(line(res, 'skills').line, /no delivery skill: bare/));
  } finally {
    planNodes = saved;
  }
});

await tPosix('skills: a configured source is synced and named with its commit; throttled and unchanged are success', async () => {
  const get = [200, { success: true, data: { source: SRC, skills: [{ slug: 'deliver' }, { slug: 'go-service' }] } }];
  const skills = { n1: [repoSkill('deliver', { provides: ['delivery'], requires: ['git'] })] };
  for (const sync of [{ changed: false, throttled: true }, { changed: false }])
    await withSkills({ front: [repoNode('n1')], skills, source: { get, sync: [200, { success: true, data: sync }] } }, (res) => {
      assert.equal(line(res, 'skills').line, 'ok (2 from instruxi-io/enforcer-graph-skills@1a2b3c4)');
      assert.ok(seen.includes('POST /graphs/g1/skill-source/sync'));
    });
  // a changed sync reports the new snapshot
  const after = [200, { success: true, data: { source: { ...SRC, resolved_commit: 'f'.repeat(40) }, skills: [{ slug: 'deliver' }] } }];
  await withSkills(
    {
      front: [repoNode('n1')],
      skills,
      source: { get, after, sync: [200, { success: true, data: { changed: true, from: SRC.resolved_commit, to: 'f'.repeat(40) } }] },
    },
    (res) => assert.equal(line(res, 'skills').line, 'ok (1 from instruxi-io/enforcer-graph-skills@fffffff)'),
  );
  // the server's answer names the commit and count: no second read
  await withSkills(
    {
      front: [repoNode('n1')],
      skills,
      source: { get, sync: [200, { success: true, data: { changed: true, to: 'e'.repeat(40), commit: 'e'.repeat(40), skills: 4 } }] },
    },
    (res) => {
      assert.equal(line(res, 'skills').line, 'ok (4 from instruxi-io/enforcer-graph-skills@eeeeeee)');
      assert.equal(seen.filter((x) => x === 'GET /graphs/g1/skill-source').length, 1);
    },
  );
});

await t('skills: a sync failure fails naming the server code, and the nodes are still checked', () =>
  withSkills(
    {
      front: [repoNode('n1')],
      source: { get: [200, { success: true, data: { source: SRC, skills: [] } }], sync: [422, { error: 'skill_source_ref_not_found', detail: 'ref main' }] },
    },
    (res) => {
      const r = line(res, 'skills');
      assert.equal(r.ok, false);
      assert.match(r.line, /skill source instruxi-io\/enforcer-graph-skills did not sync: skill_source_ref_not_found: ref main/);
      assert.match(r.line, /no delivery skill: n1/);
    },
  ),
);

await tPosix('skills: a requires command missing from PATH fails naming the skill; `enforcer` needs no PATH entry', async () => {
  const skills = {
    n1: [
      repoSkill('deliver', { provides: ['delivery'], requires: ['gh pr create', 'enforcer land <pr>', 'no-such-cmd-9f3 --x'] }),
      repoSkill('notes', { requires: ['also-missing-7c1'] }),
    ],
  };
  await withSkills({ front: [repoNode('n1')], skills }, (res) => {
    const r = line(res, 'skills');
    assert.equal(r.ok, false);
    assert.equal(r.line, "skill deliver requires no-such-cmd-9f3, skill notes requires also-missing-7c1 (not on this host's PATH)");
  });
  // PATH holds only the stub gh: gh resolves by the walk, enforcer is satisfied without one
  const { skillsCheck } = await import('../src/preflight.mjs');
  nodeSkills = { n1: [repoSkill('deliver', { provides: ['delivery'], requires: ['gh pr create', 'enforcer land'] })] };
  try {
    const r = await skillsCheck({ base, graph: 'g1', h: { 'X-API-Key': 'good' }, frontier: [repoNode('n1')], env: { PATH: bin } });
    assert.deepEqual(r, { ok: true, line: 'ok (no skill source)' });
    const r2 = await skillsCheck({ base, graph: 'g1', h: { 'X-API-Key': 'good' }, frontier: [repoNode('n1')], env: { PATH: join(tmp, 'empty') } });
    assert.equal(r2.line, "skill deliver requires gh (not on this host's PATH)");
    // a file that is not executable does not count
    mkdirSync(join(tmp, 'noexec'), { recursive: true });
    writeFileSync(join(tmp, 'noexec', 'gh'), '#!/bin/sh\n', { mode: 0o644 });
    const r3 = await skillsCheck({ base, graph: 'g1', h: { 'X-API-Key': 'good' }, frontier: [repoNode('n1')], env: { PATH: join(tmp, 'noexec') } });
    assert.equal(r3.ok, false);
  } finally {
    nodeSkills = {};
  }
});

await t('skills: at most 20 frontier nodes are probed, and the line says so', () =>
  withSkills({ front: Array.from({ length: 25 }, (_, i) => repoNode(`k${String(i).padStart(2, '0')}`)) }, (res) => {
    const r = line(res, 'skills');
    assert.equal(r.ok, false);
    assert.match(r.line, /^no delivery skill: k00, k01, k02, k03, k04 \(\+15 more\);/);
    assert.match(r.line, /checked the first 20 of 25 frontier nodes with data\.repo$/);
    assert.equal(seen.filter((x) => /\/nodes\/k\d+\/skills$/.test(x)).length, 20);
  }),
);

await tPosix('enforcer dispatch: a skills failure stops the start; no dispatcher is launched', async () => {
  const saved = [planNodes, frontier, nodeSkills];
  planNodes = [{ id: 'n1', key: 'n1', type: 'task', data: { repo: 'present', acceptance: ['`true` exits 0'] } }];
  frontier = [repoNode('n1')];
  nodeSkills = {};
  const cfgHome = join(tmp, 'cfg-start');
  try {
    const e = env({ ENFORCER_CONFIG_HOME: cfgHome });
    // guard: every other check passes, so the start below can only be stopped by skills (never launch a real dispatcher)
    const res = await preflight({ graph: 'g1', repoRoot, env: e, pluginRoot: ROOT });
    assert.deepEqual(
      res.filter((r) => !r.ok).map((r) => r.name),
      ['skills'],
      JSON.stringify(res.filter((r) => !r.ok)),
    );
    const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'dispatch', 'g1', '--repo-root', repoRoot], { env: e });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const code = await new Promise((r) => p.on('close', r));
    assert.equal(code, 2, out + err);
    assert.match(out, /fail {2}skills: no delivery skill: n1/);
    assert.match(err, /preflight failed, nothing started/);
    assert.equal(existsSync(join(cfgHome, 'dispatch', 'g1', 'dispatcher.pid')), false);
  } finally {
    [planNodes, frontier, nodeSkills] = saved;
  }
});

srv.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
console.log(`pass ${pass}\nfail ${fail}`);
process.exit(fail ? 1 : 0);
