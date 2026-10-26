// Every governor decision is a JSON record with a code from core/codes.mjs.
// One allow, one deny and one ask per rule, each pinned as the EXACT record a
// parent process will parse; then the real hook, to show the record reaches
// stderr and the first line of the permission reason.
// `node test/decisions.test.mjs`. No framework: a failed assert exits non-zero.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gate } from '../core/gate.mjs';
import { DEFAULT_RULES } from '../core/capability.mjs';
import { CODES, DECISIONS, decisionRecord, decisionLine, DECISION_PREFIX, isCode, codeOf } from '../core/codes.mjs';
import { evaluate as worker, headlessFrom, WORKER_RULES } from '../core/worker.mjs';
import { DOT } from '../../../hooks/claude/paths.mjs';
import { writeChecksOn } from './fixtures/checks-on.mjs';

let pass = 0;
const ok = (label, fn) => {
  fn();
  pass++;
  console.log('  ok  ' + label);
};

const healthy = { withState: (fn) => ({ ok: true, value: fn({}, {}) }), economics: () => null };
const HEADLESS = { headless: true, branch: 'graph/demo' };
const PERSON = { headless: false, branch: 'graph/demo' };
const bash = (command, worker = { headless: false, branch: 'feature/x' }) => ({
  tool: 'shell',
  name: 'Bash',
  action: 'Bash:' + command,
  input: { command },
  raw: { command },
  worker,
});
const edit = (path, worker) => ({ tool: 'edit', name: 'Edit', action: 'Edit:' + path, input: { path }, raw: { file_path: path }, worker });
const as = (id, action) => DEFAULT_RULES.map((r) => (r.id === id ? { ...r, action } : r));
const record = (ev, cfg = {}, deps = healthy) => decisionRecord(gate(ev, cfg, deps), { tool: ev.name });
const ALLOWED = { decision: 'allow', code: 'no_rule_matched', rule: null, tool: 'Bash', summary: 'in budget' };

// ── the enum ────────────────────────────────────────────────────────────────
ok('codes are one snake_case enum, frozen, each with a meaning', () => {
  assert.ok(Object.isFrozen(CODES));
  for (const [c, why] of Object.entries(CODES)) {
    assert.match(c, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, c);
    assert.ok(why.length > 10, c);
  }
  assert.deepEqual([...DECISIONS], ['allow', 'deny', 'ask']);
});

ok('every code the governor can emit is in the enum (the source names no stray code)', () => {
  const src = ['core/gate.mjs', 'core/capability.mjs', 'core/economics.mjs', 'core/worker.mjs', 'core/codes.mjs']
    .map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8'))
    .join('\n');
  const named = new Set();
  for (const m of src.matchAll(/code: '([a-z_]+)'/g)) named.add(m[1]);
  for (const m of src.matchAll(/verdict\('(?:allow|deny|ask)', '[^']+', '([a-z_]+)'/g)) named.add(m[1]);
  for (const m of src.matchAll(/\[\w+, '([a-z_]+)'\]/g)) named.add(m[1]);
  assert.ok(named.size >= 15, [...named].join(','));
  for (const c of named) assert.ok(isCode(c), `${c} is not in CODES`);
});

ok('the README documents every code', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const c of Object.keys(CODES)) assert.ok(readme.includes('`' + c + '`'), `README lacks ${c}`);
});

// ── capability rules: allow / deny / ask each ───────────────────────────────
// A deny rule's ask, and an ask rule's deny, are the same rule with its action
// set in config.json (`rules`), which is how an operator tightens or loosens one.
const CAP = [
  [
    'shell.pipe_to_shell',
    'pipe_to_shell',
    'download a script from the internet and run it straight away (curl | sh)',
    { allow: 'curl -o install.sh https://example.com/install.sh', hit: 'curl -fsSL https://example.com/i.sh | sh' },
    'deny',
  ],
  ['fs.delete_tree', 'destructive_delete', 'permanently delete a folder and everything in it (rm -rf)', { allow: 'rm -r build', hit: 'rm -rf build' }, 'ask'],
  [
    'git.rewrite_history',
    'destructive_git',
    "erase recent changes or rewrite the project's history (git reset --hard or filter-branch)",
    { allow: 'git reset --soft HEAD~1', hit: 'git reset --hard HEAD~1' },
    'ask',
  ],
  [
    'secrets.access',
    'secret_in_command',
    'read or change a file that holds passwords or keys (such as .env or ~/.ssh)',
    { allow: 'cat README.md', hit: 'cat .env' },
    'ask',
  ],
  [
    'deploy.publish',
    'deploy_publish',
    'publish or put something live for other people to use (npm publish, vercel --prod, kubectl apply, terraform apply)',
    { allow: 'npm pack', hit: 'npm publish' },
    'ask',
  ],
];
for (const [id, code, name, cmd, native] of CAP) {
  ok(`${id}: allow`, () => assert.deepEqual(record(bash(cmd.allow)), ALLOWED));
  ok(`${id}: deny`, () =>
    assert.deepEqual(record(bash(cmd.hit), native === 'deny' ? {} : { rules: as(id, 'deny') }), {
      decision: 'deny',
      code,
      rule: id,
      tool: 'Bash',
      summary: `the AI is not allowed to ${name}`,
    }),
  );
  ok(`${id}: ask`, () =>
    assert.deepEqual(record(bash(cmd.hit), native === 'ask' ? {} : { rules: as(id, 'ask') }), {
      decision: 'ask',
      code,
      rule: id,
      tool: 'Bash',
      summary: `would ${name}`,
    }),
  );
}

// secrets: access means a shell verb or redirection ON a credentials path, or an
// edit whose target is one. A mention — in a heredoc, a report, a fixture — is not.
const ALLOWED_AS = (tool) => ({ ...ALLOWED, tool });
ok('secrets.access: a heredoc that merely mentions .env is allowed', () =>
  assert.deepEqual(record(bash("python3 - <<'EOF'\nprint('copy .env and node_modules into the worktree')\nEOF")), ALLOWED),
);
ok('secrets.access: grep for the string .env is allowed (nothing is read or written)', () =>
  assert.deepEqual(record(bash("grep -rn '\\.env' docs/ | head")), ALLOWED),
);
ok('secrets.access: cp of a .env file asks', () =>
  assert.deepEqual(record(bash('cp .env ../other/.env')), {
    decision: 'ask',
    code: 'secret_in_command',
    rule: 'secrets.access',
    tool: 'Bash',
    summary: 'would read or change a file that holds passwords or keys (such as .env or ~/.ssh)',
  }),
);
ok('secrets.access: redirecting into .env asks', () =>
  assert.deepEqual(record(bash('echo TOKEN=x >> .env.local')), {
    decision: 'ask',
    code: 'secret_in_command',
    rule: 'secrets.access',
    tool: 'Bash',
    summary: 'would read or change a file that holds passwords or keys (such as .env or ~/.ssh)',
  }),
);
const editWith = (path, content) => ({
  tool: 'edit',
  name: 'Edit',
  action: 'Edit:' + path + '\n' + content,
  input: { path, content },
  raw: { file_path: path, new_string: content },
  fields: { path: 'file_path', content: 'new_string' },
  worker: { headless: false, branch: 'feature/x' },
});
ok('secrets.edit: editing a test that mentions .env is allowed (the target is not a credentials file)', () =>
  assert.deepEqual(record(editWith('/repo/enforcer/test/test_dispatch.py', "assert copied('.env')")), ALLOWED_AS('Edit')),
);
ok('secrets.edit: editing .env itself asks', () =>
  assert.deepEqual(record(editWith('/repo/.env', 'TOKEN=x')), {
    decision: 'ask',
    code: 'secret_in_command',
    rule: 'secrets.edit',
    tool: 'Edit',
    summary: 'would read or change a file that holds passwords or keys (such as .env or ~/.ssh)',
  }),
);
ok('secrets: a graph_report whose text mentions .env is allowed (an MCP call carries text, not a file)', () => {
  const name = 'mcp__plugin_enforcer_enforcer__graph_report';
  const ev = {
    tool: 'mcp',
    name,
    action: name + ':' + JSON.stringify({ report: '1. MET: .env copied into the worktree' }),
    input: { report: '1. MET: .env copied into the worktree' },
    raw: { report: '1. MET: .env copied into the worktree' },
    worker: HEADLESS,
  };
  assert.deepEqual(record(ev), ALLOWED_AS(name));
});

ok('git.force_push: allow (a lease is already the safe form)', () => assert.deepEqual(record(bash('git push --force-with-lease origin feature/x')), ALLOWED));
ok('git.force_push: ask (with a person present the push is rewritten, and a rewrite is put to them as an ask)', () =>
  assert.deepEqual(record(bash('git push --force origin feature/x')), {
    decision: 'ask',
    code: 'force_push',
    rule: 'git.force_push',
    tool: 'Bash',
    summary:
      'a plain force-push can overwrite work other people saved online, so Enforcer added a safety check (--force-with-lease) that stops the push if anyone else has pushed since you last fetched',
  }),
);
ok('git.force_push: deny (headless: nobody would answer the prompt, so it is refused)', () =>
  assert.deepEqual(record(bash('git push --force origin graph/demo', HEADLESS)), {
    decision: 'deny',
    code: 'force_push',
    rule: 'git.force_push',
    tool: 'Bash',
    summary: 'a headless worker may not force-push',
  }),
);

ok('tenant policy: its deny and ask carry tenant_policy and still name the rule', () => {
  const deny = record(bash('npm publish'), {}, { ...healthy, central: { opinion: 'deny', reason: 'publishing goes through release CI' } });
  assert.deepEqual(deny, { decision: 'deny', code: 'tenant_policy', rule: 'deploy.publish', tool: 'Bash', summary: 'publishing goes through release CI' });
  const ask = record(bash('rm -rf build'), {}, { ...healthy, central: { opinion: 'ask', reason: 'confirm deletes' } });
  assert.deepEqual(ask, { decision: 'ask', code: 'tenant_policy', rule: 'fs.delete_tree', tool: 'Bash', summary: 'confirm deletes' });
});

ok('no objection is a record too: in budget, unchecked, checks off', () => {
  assert.deepEqual(record(bash('ls')), ALLOWED);
  assert.equal(record(bash('ls'), {}, { withState: () => ({ ok: false }) }).code, 'spend_unchecked');
  assert.equal(record(bash('ls'), { budgetOn: false, rulesOn: false }).code, 'checks_off');
});

// ── the headless graph-worker rules ─────────────────────────────────────────
ok('graph.push: allow — `git push -u origin graph/<key>`, whole command, headless, on that branch', () =>
  assert.deepEqual(record(bash('git push -u origin graph/demo', HEADLESS)), {
    decision: 'allow',
    code: 'graph_push_allowed',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'headless worker pushing its own branch graph/demo',
  }),
);
ok('graph.push: deny — chained with anything else', () =>
  assert.deepEqual(record(bash('git add -A && git push -u origin graph/demo', HEADLESS)), {
    decision: 'deny',
    code: 'push_not_alone',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'a push, pull request or land must be the whole command, on its own',
  }),
);
ok('graph.push: ask — a person is present', () =>
  assert.deepEqual(record(bash('git push -u origin graph/demo', PERSON)), {
    decision: 'ask',
    code: 'graph_push_confirm',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'would upload the branch graph/demo to the shared online copy (git push)',
  }),
);
ok('graph.push: deny — another branch than the worktree has checked out', () =>
  assert.deepEqual(record(bash('git push -u origin graph/other', HEADLESS)), {
    decision: 'deny',
    code: 'branch_mismatch',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'the worktree has graph/demo checked out, not graph/other',
  }),
);
ok('graph.push: deny — not a graph worktree', () =>
  assert.deepEqual(record(bash('git push -u origin graph/demo', { headless: true, branch: 'feature/x' })), {
    decision: 'deny',
    code: 'outside_worktree',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'the working directory is not a worktree on a graph/<key> branch',
  }),
);
ok('graph.push: deny — a push no rule allows, with nobody to ask', () => {
  for (const c of ['git push origin feature/x', 'git push --tags origin graph/demo', 'git push']) {
    assert.deepEqual(
      record(bash(c, HEADLESS)),
      {
        decision: 'deny',
        code: 'push_needs_approval_surface',
        rule: 'graph.push',
        tool: 'Bash',
        summary: 'only `git push -u origin graph/<key>` may run with nobody to ask',
      },
      c,
    );
  }
});
ok('graph.push: the rebase path (`--force-with-lease` to its own branch) and `git -C` are the same allow', () => {
  assert.equal(record(bash('git push --force-with-lease origin graph/demo', HEADLESS)).code, 'graph_push_allowed');
  assert.equal(record(bash('git push -u origin HEAD:graph/demo', HEADLESS)).code, 'graph_push_allowed');
  assert.equal(record(bash('git push origin +graph/demo', HEADLESS)).code, 'force_push');
});

ok('graph.pr_create: allow — headless, from the graph branch', () =>
  assert.deepEqual(record(bash('gh pr create --fill --base main', HEADLESS)), {
    decision: 'allow',
    code: 'graph_pr_allowed',
    rule: 'graph.pr_create',
    tool: 'Bash',
    summary: 'headless worker opening a pull request from graph/demo',
  }),
);
ok('graph.pr_create: deny — headless, off a graph branch', () =>
  assert.deepEqual(record(bash('gh pr create --fill', { headless: true, branch: 'main' })), {
    decision: 'deny',
    code: 'outside_worktree',
    rule: 'graph.pr_create',
    tool: 'Bash',
    summary: 'the working directory is not a worktree on a graph/<key> branch',
  }),
);
ok('graph.pr_create: ask — a person is present', () =>
  assert.deepEqual(record(bash('gh pr create --fill', PERSON)), {
    decision: 'ask',
    code: 'graph_pr_confirm',
    rule: 'graph.pr_create',
    tool: 'Bash',
    summary: 'would open a request to merge the branch graph/demo (a pull request)',
  }),
);

const LAND = '"$(ls -d ~/' + DOT + '/plugins/cache/*/enforcer-graph/*/bin/land-pr.sh | tail -1)" 42 --timeout 3000';
ok("graph.land: allow — the skill's own land-pr.sh invocation, headless, on the graph branch", () =>
  assert.deepEqual(record(bash(LAND, HEADLESS)), {
    decision: 'allow',
    code: 'graph_land_allowed',
    rule: 'graph.land',
    tool: 'Bash',
    summary: 'headless worker landing graph/demo',
  }),
);
ok('graph.land: deny — headless, off a graph branch', () =>
  assert.deepEqual(record(bash(LAND, { headless: true, branch: 'main' })), {
    decision: 'deny',
    code: 'outside_worktree',
    rule: 'graph.land',
    tool: 'Bash',
    summary: 'land-pr.sh runs from a worktree on a graph/<key> branch',
  }),
);
ok('graph.land: ask — a person is present', () =>
  assert.deepEqual(record(bash(LAND, PERSON)), {
    decision: 'ask',
    code: 'graph_land_confirm',
    rule: 'graph.land',
    tool: 'Bash',
    summary: 'would merge the branch graph/demo into the main project once its automatic checks pass',
  }),
);

ok('git.push_default_branch: allow — a person pushing a feature branch is left to them', () =>
  assert.deepEqual(record(bash('git push origin feature/x')), ALLOWED),
);
ok('git.push_default_branch: deny — headless', () => {
  for (const c of ['git push origin main', 'git push -u origin HEAD:master', 'git push origin graph/demo:refs/heads/main']) {
    assert.deepEqual(
      record(bash(c, HEADLESS)),
      {
        decision: 'deny',
        code: 'push_default_branch',
        rule: 'git.push_default_branch',
        tool: 'Bash',
        summary: `a headless worker may not push to ${c.includes('master') ? 'master' : 'main'}`,
      },
      c,
    );
  }
});
ok('git.push_default_branch: ask — a person is present', () =>
  assert.deepEqual(record(bash('git push origin main')), {
    decision: 'ask',
    code: 'push_default_branch',
    rule: 'git.push_default_branch',
    tool: 'Bash',
    summary: 'would upload your changes straight to the shared main branch (git push)',
  }),
);

ok('governor.settings: allow — reading settings changes nothing', () => assert.deepEqual(record(bash('cat ~/' + DOT + '/settings.json', HEADLESS)), ALLOWED));
ok('governor.settings: deny — headless edit of plugin or governor settings, by tool or by shell', () => {
  const want = { decision: 'deny', code: 'settings_write', rule: 'governor.settings', summary: 'a headless worker may not change plugin or governor settings' };
  assert.deepEqual(record(edit('/home/u/' + DOT + '/settings.json', HEADLESS)), { ...want, tool: 'Edit' });
  for (const c of [
    "echo '{}' > ~/.enforcer-governor/config.json",
    'sed -i s/true/false/ ' + DOT + '/settings.local.json',
    'rm -rf ~/' + DOT + '/plugins/cache/instruxi/enforcer-governor',
  ]) {
    assert.deepEqual(record(bash(c, HEADLESS)), { ...want, tool: 'Bash' }, c);
  }
});
ok('governor.settings: ask — a person is present', () =>
  assert.deepEqual(record(edit('/home/u/' + DOT + '/settings.json', PERSON)), {
    decision: 'ask',
    code: 'settings_write',
    rule: 'governor.settings',
    tool: 'Edit',
    summary: "would change Enforcer's own settings",
  }),
);

ok('a tenant deny outranks a graph-worker allow', () =>
  assert.equal(record(bash('git push -u origin graph/demo', HEADLESS), {}, { ...healthy, central: { opinion: 'deny', reason: 'frozen' } }).decision, 'deny'),
);
ok('rulesOn false turns the graph-worker rules off with the rest', () =>
  assert.deepEqual(record(bash('git push -u origin graph/demo', HEADLESS), { rulesOn: false }), ALLOWED),
);
ok('headless means JEV_HOOKS_HEADLESS=1, ENFORCER_HEADLESS=1 or `claude -p` (sdk-cli); nothing else', () => {
  assert.equal(headlessFrom({ JEV_HOOKS_HEADLESS: '1' }), true);
  assert.equal(headlessFrom({ ENFORCER_HEADLESS: '1' }), true);
  assert.equal(headlessFrom({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), true);
  assert.equal(headlessFrom({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);
  assert.equal(headlessFrom({}), false);
});
ok('every graph-worker rule id is published once', () => assert.equal(new Set(WORKER_RULES.map((r) => r.id)).size, WORKER_RULES.length));
ok('the record carries run_id only when there is one', () => {
  const v = gate(bash('ls'), {}, healthy);
  assert.equal('run_id' in decisionRecord(v, { tool: 'Bash' }), false);
  assert.equal(decisionRecord(v, { tool: 'Bash', run_id: 'r-1' }).run_id, 'r-1');
  assert.equal(codeOf(v), 'no_rule_matched');
});

// ── through the real hook ───────────────────────────────────────────────────
const HOOK = new URL('../hooks/pre-tool-use.mjs', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'gov-decisions-'));
const wt = join(root, 'wt');
mkdirSync(join(wt, '.git'), { recursive: true });
writeFileSync(join(wt, '.git', 'HEAD'), 'ref: refs/heads/graph/demo\n');
// The checks are off by default; the hook cases below test them, so turn them on.
writeChecksOn(join(root, 'gov'));
function hook(command, extra) {
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GOVERNOR_HOME: join(root, 'gov'),
    ENFORCER_HOME: join(root, 'enforcer'),
    ENFORCER_GRAPH_RUN_ID: 'run-123',
  };
  for (const k of ['JEV_HOOKS_HEADLESS', 'ENFORCER_HEADLESS', 'CLAUDE_CODE_ENTRYPOINT', 'ENFORCER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
    delete env[k];
  const r = spawnSync(process.execPath, [HOOK], {
    env: { ...env, ...extra },
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'decide01', tool_name: 'Bash', tool_input: { command }, cwd: wt }),
  });
  const out = JSON.parse(r.stdout).hookSpecificOutput || {};
  return {
    out,
    err: r.stderr
      .trim()
      .split('\n')
      .find((l) => l.startsWith(DECISION_PREFIX)),
  };
}
const parse = (line) => JSON.parse(line.slice(DECISION_PREFIX.length));

ok("hook: a headless graph push is ALLOWED, and the record is the reason's first line and on stderr", () => {
  const { out, err } = hook('git push -u origin graph/demo', { JEV_HOOKS_HEADLESS: '1' });
  const want = {
    decision: 'allow',
    code: 'graph_push_allowed',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'headless worker pushing its own branch graph/demo',
    run_id: 'run-123',
  };
  assert.equal(out.permissionDecision, 'allow');
  assert.equal(out.permissionDecisionReason.split('\n')[0], decisionLine(want));
  assert.deepEqual(parse(err), want);
});
ok('hook: a chained headless push is DENIED with push_not_alone', () => {
  const { out, err } = hook('git commit -am x; git push -u origin graph/demo', { JEV_HOOKS_HEADLESS: '1' });
  assert.equal(out.permissionDecision, 'deny');
  assert.deepEqual(parse(out.permissionDecisionReason.split('\n')[0]), parse(err));
  assert.equal(parse(err).code, 'push_not_alone');
});
ok('hook: with a person present the same push is an ASK', () => {
  const { out, err } = hook('git push -u origin graph/demo', {});
  assert.equal(out.permissionDecision, 'ask');
  assert.equal(parse(err).code, 'graph_push_confirm');
});
ok('hook: no objection still writes the record on stderr, and no decision on stdout', () => {
  const { out, err } = hook('ls -la', {});
  assert.equal(out.permissionDecision, undefined);
  assert.equal(parse(err).decision, 'allow');
});
ok('hook: the tamper-evident receipt carries the same record', () => {
  const lines = readFileSync(join(root, 'gov', 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const push = lines.find((l) => l.decision?.code === 'graph_push_allowed');
  assert.deepEqual(push.decision, {
    decision: 'allow',
    code: 'graph_push_allowed',
    rule: 'graph.push',
    tool: 'Bash',
    summary: 'headless worker pushing its own branch graph/demo',
    run_id: 'run-123',
  });
  assert.ok(push.hash);
});

void worker;
console.log(`\n${pass} passed`);
