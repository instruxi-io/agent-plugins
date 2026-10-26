// Validates plugin.json against the vendored Agent Plugins 1.0 schema (draft 2020-12 subset the
// schema uses: type, const, required, properties, additionalProperties, items, minLength,
// maxLength, pattern) and checks every version string in the package is identical.
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOT } from '../hooks/claude/paths.mjs';
const rd = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('./fixtures/agent-plugins-1.0.0.plugin.schema.json', import.meta.url), 'utf8'));

function validate(s, v, path = '$') {
  const errs = [];
  if (s.type) {
    const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (t !== s.type) return [`${path}: expected ${s.type}, got ${t}`];
  }
  if ('const' in s && v !== s.const) errs.push(`${path}: must equal ${s.const}`);
  if (typeof v === 'string') {
    if (s.minLength && v.length < s.minLength) errs.push(`${path}: too short`);
    if (s.maxLength && v.length > s.maxLength) errs.push(`${path}: too long`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${path}: pattern ${s.pattern}`);
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validate(s.items, x, `${path}[${i}]`)));
  if (s.type === 'object') {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${path}: missing ${r}`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties?.[k];
      if (sub) errs.push(...validate(sub, x, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}: unexpected property ${k}`);
      else if (typeof s.additionalProperties === 'object') errs.push(...validate(s.additionalProperties, x, `${path}.${k}`));
    }
  }
  return errs;
}

const plugin = rd('plugin.json');
assert.deepEqual(validate(schema, plugin), []);
console.log('ok   plugin.json validates against the vendored Agent Plugins 1.0.0 schema');
assert.ok(validate(schema, { name: 'x' }).length > 0);
assert.ok(validate(schema, { ...plugin, bogus: 1 }).length > 0);
console.log('ok   the validator rejects a missing $schema and an unknown property');

const versions = {
  'plugin.json': plugin.version,
  [`${DOT}-plugin/plugin.json`]: rd(`${DOT}-plugin/plugin.json`).version,
  'package.json': rd('package.json').version,
};
const kitJson = JSON.parse(readFileSync(new URL('../../kit.json', import.meta.url), 'utf8'));
if (kitJson.version) versions['kit.json'] = kitJson.version;
const codex = JSON.parse(readFileSync(new URL('../../.agents/plugins/marketplace.json', import.meta.url), 'utf8')).plugins.find((p) => p.name === 'enforcer');
assert.ok(codex.version, 'Codex marketplace entry has no version');
versions['.agents marketplace.json'] = codex.version;
assert.ok(codex.policy?.authentication, 'Codex marketplace entry has no policy.authentication');
{
  const g = readFileSync(new URL('../src/grok-install.mjs', import.meta.url), 'utf8');
  assert.match(g, /JSON\.parse\(rd\('plugin\.json'\)\)\.version/, 'Grok VERSION file must come from plugin.json');
}
const market = rd(`../${DOT}-plugin/marketplace.json`).plugins.find((p) => p.name === 'enforcer');
if (market.version) versions['marketplace.json'] = market.version;
assert.equal(new Set(Object.values(versions)).size, 1, `versions differ: ${JSON.stringify(versions)}`);
console.log(`ok   versions agree across plugin.json, both marketplaces and kit.json`);
console.log(`ok   one version everywhere: ${plugin.version} (${Object.keys(versions).join(', ')})`);

{
  const t = (ok, msg) => {
    assert.ok(ok, msg);
  };
  const m = rd('.mcp.json');
  const names = Object.keys(m.mcpServers ?? {});
  t(names.length > 0, '.mcp.json has no mcpServers');
  for (const [n, sv] of Object.entries(m.mcpServers)) {
    t(['http', 'streamable-http', 'sse', 'stdio'].includes(sv.type), `.mcp.json ${n}: bad type`);
    if (sv.type !== 'stdio') t(/^https:\/\//.test(sv.url ?? ''), `.mcp.json ${n}: url must be https`);
    else t(typeof sv.command === 'string', `.mcp.json ${n}: stdio needs command`);
  }
  const m2 = rd('mcp.json');
  assert.ok(m2.$schema, 'mcp.json has no $schema');
  console.log('ok   .mcp.json is valid');
}
{
  const KNOWN = new Set(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'ToolSearch', 'Skill', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite']);
  for (const d of ['agents', 'harness/grok/agents'])
    for (const f of readdirSync(new URL(`../${d}/`, import.meta.url))) {
      const head = readFileSync(new URL(`../${d}/${f}`, import.meta.url), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1];
      assert.ok(head, `${d}/${f}: no frontmatter`);
      assert.match(head, /^name:\s*\S+/m, `${d}/${f}: name`);
      assert.match(head, /^description:\s*\S+/m, `${d}/${f}: description`);
      const tools = (head.match(/^tools:\s*(.+)$/m)?.[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const x of tools) assert.ok(KNOWN.has(x) || /^mcp__[\w-]+__\w+$/.test(x) || /^enforcer__\w+$/.test(x), `${d}/${f}: unknown tool ${x}`);
    }
  console.log('ok   agent frontmatter tools are known');
}
const mcp = rd('mcp.json').mcpServers.enforcer;
assert.equal(mcp.type, 'streamable-http');
assert.equal(mcp.url, 'https://api.instruxi.dev/mcp');
console.log('ok   mcp.json is streamable-http at api.instruxi.dev/mcp');
assert.ok(existsSync(new URL('../.mcp.json', import.meta.url)) && existsSync(new URL('../skills/enforcer/SKILL.md', import.meta.url)));
for (const c of readdirSync(new URL('../commands/', import.meta.url))) {
  const b = readFileSync(new URL(`../commands/${c}`, import.meta.url), 'utf8');
  // 12, not 9: login passes its arguments through a heredoc on stdin (never on the command line), which costs three lines
  assert.ok(b.split('\n').length <= 12, `${c} is not thin`);
}
console.log('ok   Claude fallback present; commands are thin wrappers');
const root = (f) => new URL(`../../${f}`, import.meta.url);
const mkt = JSON.parse(readFileSync(root(`${DOT}-plugin/marketplace.json`), 'utf8'));
for (const n of ['enforcer-graph', 'enforcer-files', 'enforcer-governor']) {
  const src = mkt.plugins.find((p) => p.name === n).source;
  assert.equal(src, `./aliases/${n}`);
  const dir = `${src.replace('./', '')}`;
  assert.ok(!existsSync(root(`${dir}/.mcp.json`)) && !existsSync(root(`${dir}/mcp.json`)));
  const hooks = JSON.parse(readFileSync(root(`${dir}/hooks/hooks.json`), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart']);
  const cmds = hooks.SessionStart.flatMap((g) => g.hooks);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0].command, /this alias is now part of enforcer; uninstall it/);
}
// installing enforcer plus both aliases registers exactly one real hooks.json
const withHooks = ['enforcer', 'enforcer-graph', 'enforcer-files', 'enforcer-governor'].filter((n) => {
  const src = mkt.plugins.find((p) => p.name === n).source.replace('./', '');
  const f = root(`${src}/hooks/hooks.json`);
  return (
    existsSync(f) &&
    Object.values(JSON.parse(readFileSync(f, 'utf8')).hooks)
      .flat()
      .some((g) => g.hooks.some((h) => h.type === 'command' && !/this alias is now part/.test(h.command)))
  );
});
assert.deepEqual(withHooks, ['enforcer']);
console.log('ok   no alias carries hooks or mcp beyond the one notice');
const kit = JSON.parse(readFileSync(root('kit.json'), 'utf8'));
assert.deepEqual(kit.plugins.map((p) => p.id).sort(), ['enforcer@instruxi', 'jev-hooks@instruxi']);
assert.deepEqual(
  kit.plugins.filter((p) => p.default).map((p) => p.id),
  ['enforcer@instruxi'],
);
console.log('ok   kit defaults: only enforcer and jev-hooks are selectable, only enforcer default');

// no suite reads the real home directory: every node suite runs under the isolating preload,
// and none asks the OS for the home itself.
{
  // one assertion: the discovering runner applies the preload to every suite it spawns
  const runner = readFileSync(new URL('../scripts/test.mjs', import.meta.url), 'utf8');
  assert.ok(runner.includes("'--import', PRELOAD") && runner.includes("'test', 'tmp-cleanup.mjs'"), 'the runner applies the isolating preload');
  assert.equal(rd('package.json').scripts.test, 'node scripts/test.mjs');
  console.log('ok   the runner applies the isolating preload');
  for (const d of ['test', 'lib/governor/test']) {
    for (const f of readdirSync(new URL(`../${d}`, import.meta.url)).filter((n) => /\.test\.mjs$/.test(n))) {
      const src = readFileSync(new URL(`../${d}/${f}`, import.meta.url), 'utf8');
      assert.ok(!/os\.homedir\(\)|\bhomedir\(\)|expanduser\(|Path\.home\(\)/.test(src), `${d}/${f} reads the real home directory`);
    }
  }
  console.log('ok   no suite reads the real home directory');
}

{
  const nested = [];
  const walk = (dir, top) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
      const p = `${dir}/${e.name}`;
      if (e.name === DOT + '-plugin' && !top) nested.push(p);
      walk(p, false);
    }
  };
  walk(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''), true);
  assert.deepEqual(nested, [], `nested plugin manifests: ${nested.join(', ')}`);
  console.log('ok   no nested plugin manifests');
}

test('codex marketplace entry matches plugin.json', () => {
  const e = JSON.parse(readFileSync(root('.agents/plugins/marketplace.json'), 'utf8')).plugins.find((p) => p.name === 'enforcer');
  assert.ok(e, 'no enforcer entry');
  assert.equal(e.source.path, './enforcer');
  assert.equal(e.version, plugin.version);
  const hooks = plugin.extensions?.['com.openai']?.hooks;
  assert.ok(hooks && existsSync(new URL(`../${hooks}`, import.meta.url)), `codex hooks file missing: ${hooks}`);
  assert.ok(existsSync(new URL('../.mcp.json', import.meta.url)) && existsSync(new URL('../mcp.json', import.meta.url)));
  assert.equal(rd('.mcp.json').mcpServers.enforcer.url, rd('mcp.json').mcpServers.enforcer.url);
});

test('hook commands reference files that exist', () => {
  const hooks = rd('hooks/hooks.json').hooks;
  let n = 0;
  for (const g of Object.values(hooks).flat())
    for (const h of g.hooks) {
      if (h.type !== 'command') continue;
      for (const m of h.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
        n++;
        assert.ok(existsSync(new URL(`../${m[1]}`, import.meta.url)), `missing ${m[1]}`);
      }
    }
  assert.ok(n > 0);
});

console.log('\nOK');
