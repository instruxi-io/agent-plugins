// `node --test test/skills-source.test.mjs`: `enforcer skills source show|set|sync|rm <graph>` against a fake fetch. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseSkillsArgs, main } from '../src/skills-source.mjs';

const ENV = { ...process.env, GRAPH_BASE_URL: 'http://graph.test/api/v1/graph', GRAPH_API_KEY: 'k', GRAPH_AUTH_HELPER: '' };
const SRC = {
  repo: 'instruxi-io/enforcer-graph-skills',
  ref: 'main',
  path: 'skills',
  include: null,
  resolved_commit: '1a2b3c4'.padEnd(40, 'e'),
  synced_at: '2026-11-10T12:00:00Z',
  last_error: null,
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Runs main with a fetch that answers from `routes` ("METHOD /path" -> [status, body]) and records the calls. */
async function run(argv, routes) {
  const calls = [];
  let out = '';
  let err = '';
  const fetchImpl = async (url, init) => {
    const key = `${init.method || 'GET'} ${new URL(url).pathname.replace('/api/v1/graph', '')}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, apiKey: init.headers['X-API-Key'] });
    const r = routes[key];
    return r ? json(...r) : json(404, {});
  };
  const code = await main(argv, { env: ENV, out: (s) => (out += s), err: (s) => (err += s), fetchImpl });
  return { code, out, err, calls };
}

test('parseSkillsArgs: the four subcommands and set flags', () => {
  assert.deepEqual(parseSkillsArgs(['source', 'show', 'g1']), { sub: 'show', graph: 'g1' });
  assert.deepEqual(parseSkillsArgs(['source', 'rm', 'g1']), { sub: 'rm', graph: 'g1' });
  assert.deepEqual(parseSkillsArgs(['source', 'set', 'g1', '--repo', 'o/r', '--ref', 'v1', '--path', 'x/skills', '--include', 'a, b-2']), {
    sub: 'set',
    graph: 'g1',
    body: { repo: 'o/r', ref: 'v1', path: 'x/skills', include: ['a', 'b-2'] },
  });
  assert.deepEqual(parseSkillsArgs(['source', 'set', '--repo', 'o/r', 'g1']).body, { repo: 'o/r' });
});

test('parseSkillsArgs refuses what the server would refuse, before a request', () => {
  assert.throws(() => parseSkillsArgs(['sources', 'show', 'g1']), /expected: skills source/);
  assert.throws(() => parseSkillsArgs(['source', 'list', 'g1']), /one of show, set, sync, rm/);
  assert.throws(() => parseSkillsArgs(['source', 'show']), /graph id is required/);
  assert.throws(() => parseSkillsArgs(['source', 'show', '../x']), /not a valid id/);
  assert.throws(() => parseSkillsArgs(['source', 'show', 'g1', 'g2']), /one graph only/);
  assert.throws(() => parseSkillsArgs(['source', 'set', 'g1']), /set needs --repo/);
  assert.throws(() => parseSkillsArgs(['source', 'set', 'g1', '--repo']), /--repo needs a value/);
  assert.throws(() => parseSkillsArgs(['source', 'set', 'g1', '--repo', 'https://github.com/o/r']), /owner\/name on github.com/);
  assert.throws(() => parseSkillsArgs(['source', 'set', 'g1', '--repo', 'o/r', '--include', 'Bad_Slug']), /--include takes skill slugs/);
  assert.throws(() => parseSkillsArgs(['source', 'sync', 'g1', '--repo', 'o/r']), /--repo is only for set/);
  assert.throws(() => parseSkillsArgs(['source', 'show', 'g1', '--force']), /unknown flag --force/);
});

test('show prints the repo, the commit and the skill slugs', async () => {
  const r = await run(['source', 'show', 'g1'], {
    'GET /graphs/g1/skill-source': [200, { success: true, data: { source: SRC, skills: [{ slug: 'deliver-via-github-pr' }, { slug: 'go-service' }] } }],
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^g1: skills from instruxi-io\/enforcer-graph-skills@main path skills\n/);
  assert.match(r.out, new RegExp(`commit ${SRC.resolved_commit} \\(synced 2026-11-10T12:00:00Z\\)`));
  assert.match(r.out, /skills \(2\): deliver-via-github-pr, go-service\n$/);
  assert.equal(r.calls[0].apiKey, 'k');
});

test('show: no source, and a server without the routes, both say no skill source', async () => {
  const none = await run(['source', 'show', 'g1'], { 'GET /graphs/g1/skill-source': [200, { success: true, data: { source: null } }] });
  assert.equal(none.out, 'g1: no skill source\n');
  const old = await run(['source', 'show', 'g1'], {});
  assert.equal(old.code, 0);
  assert.equal(old.out, 'g1: no skill source (this server has no skill-source routes)\n');
});

test('set PUTs the body, then prints what the server stored', async () => {
  const r = await run(['source', 'set', 'g1', '--repo', 'instruxi-io/enforcer-graph-skills', '--include', 'deliver-via-github-pr'], {
    'PUT /graphs/g1/skill-source': [200, { success: true, data: { source: SRC } }],
    'GET /graphs/g1/skill-source': [
      200,
      { success: true, data: { source: { ...SRC, include: ['deliver-via-github-pr'] }, skills: [{ slug: 'deliver-via-github-pr' }] } },
    ],
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls[0], {
    key: 'PUT /graphs/g1/skill-source',
    body: { repo: 'instruxi-io/enforcer-graph-skills', include: ['deliver-via-github-pr'] },
    apiKey: 'k',
  });
  assert.match(r.out, /include deliver-via-github-pr/);
  assert.match(r.out, /skills \(1\): deliver-via-github-pr/);
});

test('set: a refusal prints the server code and detail and exits 1', async () => {
  const r = await run(['source', 'set', 'g1', '--repo', 'o/r'], {
    'PUT /graphs/g1/skill-source': [422, { error: 'skill_source_parse_error', detail: 'deliver: front matter: nested map' }],
  });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'enforcer skills source set g1: HTTP 422 skill_source_parse_error: deliver: front matter: nested map\n');
  assert.equal(r.calls.length, 1);
});

test('sync says changed or unchanged, then shows the snapshot', async () => {
  const get = [200, { success: true, data: { source: SRC, skills: [{ slug: 'a' }] } }];
  const changed = await run(['source', 'sync', 'g1'], {
    'POST /graphs/g1/skill-source/sync': [200, { success: true, data: { changed: true, from: 'a'.repeat(40), to: SRC.resolved_commit } }],
    'GET /graphs/g1/skill-source': get,
  });
  assert.match(changed.out, /^g1: synced, aaaaaaa -> 1a2b3c4\n/);
  const same = await run(['source', 'sync', 'g1'], {
    'POST /graphs/g1/skill-source/sync': [200, { success: true, data: { changed: false, throttled: true } }],
    'GET /graphs/g1/skill-source': get,
  });
  assert.match(same.out, /^g1: unchanged \(synced in the last 60 s; not re-read\)\n/);
  const none = await run(['source', 'sync', 'g1'], { 'POST /graphs/g1/skill-source/sync': [404, { error: 'skill_source_not_found' }] });
  assert.equal(none.code, 1);
  assert.match(none.err, /HTTP 404 skill_source_not_found/);
  const old = await run(['source', 'sync', 'g1'], {});
  assert.equal(old.code, 1);
  assert.match(old.err, /this server has no skill-source routes/);
});

test('rm DELETEs the source', async () => {
  const r = await run(['source', 'rm', 'g1'], { 'DELETE /graphs/g1/skill-source': [200, { success: true }] });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'g1: skill source removed\n');
  assert.deepEqual(
    r.calls.map((c) => c.key),
    ['DELETE /graphs/g1/skill-source'],
  );
});

test('bin/enforcer skills: usage errors exit 2 without a request', () => {
  const bin = join(import.meta.dirname, '..', 'bin', 'enforcer');
  const r = spawnSync(process.execPath, [bin, 'skills', 'source', 'set', 'g1'], { env: { ...ENV, GRAPH_BASE_URL: 'http://127.0.0.1:1' }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /set needs --repo owner\/name/);
  const h = spawnSync(process.execPath, [bin, 'skills', '--help'], { env: ENV, encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /enforcer skills source set <graph> --repo owner\/name/);
});
