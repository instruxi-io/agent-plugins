// jev-hooks owns loop detection (2026-10-08): the governor no longer has a loop check,
// and a config that still carries the old loop settings loads and lists them as retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, RETIRED, validate } from '../core/settings.mjs';
import { DEFAULTS, makeState, decide } from '../core/policy.mjs';
import { evaluate } from '../core/economics.mjs';
import { CODES } from '../core/codes.mjs';

const LOOP = ['loopOn', 'loopLimit', 'loopWindow'];
const REPORT = fileURLToPath(new URL('../core/report.mjs', import.meta.url));

function withHome(config, fn) {
  const home = mkdtempSync(join(tmpdir(), 'gov-loop-'));
  try {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    const env = { ...process.env, HOME: home, USERPROFILE: home, GOVERNOR_HOME: home, ENFORCER_HOME: home, ENFORCER_CONFIG_HOME: home, ENFORCER_API_KEY: '' };
    return fn(home, env);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('loopOn, loopLimit and loopWindow are retired settings', () => {
  for (const k of LOOP) {
    assert.equal(SETTINGS[k], undefined, `${k} is not a live setting`);
    assert.equal(RETIRED[k], 'jev-hooks owns loop detection');
    assert.equal(k in DEFAULTS, false, `${k} has no default`);
    assert.match(validate(k, '4'), /was retired: jev-hooks owns loop detection/);
  }
  assert.equal(CODES.loop_detected, undefined);
});

test('a config carrying loopOn loads without error', () => {
  withHome({ loopOn: true, loopLimit: 2, loopWindow: 4, budgetOn: false }, (home, env) => {
    const out = execFileSync(process.execPath, [REPORT, 'config'], { env, encoding: 'utf8' });
    assert.match(out, /budgetOn/);
  });
});

test('identical repeated tool calls are allowed', () => {
  const cfg = { ...DEFAULTS, loopOn: true, loopLimit: 2, loopWindow: 4, budgetOn: true, budget: 1e9 };
  const s = makeState();
  for (let i = 0; i < 10; i++) {
    const v = decide(s, { agent: 'same', tokens: 100 + i, action: 'Bash:npm test' }, cfg);
    assert.equal(v.verdict, 'allow', `call ${i}: ${v.reason}`);
  }
  const e = { agents: {} };
  for (let i = 0; i < 10; i++) {
    const v = evaluate(e, { agent: 'same', name: 'Bash', tool: 'Bash', action: 'Bash:npm test', tokens: 100 + i }, cfg, 1000 + i);
    assert.ok(!v || v.action === 'allow', `call ${i}: ${JSON.stringify(v)}`);
  }
});

test('governor config lists loop settings under retired', () => {
  withHome({ loopOn: true, loopLimit: 4, loopWindow: 8 }, (home, env) => {
    const out = execFileSync(process.execPath, [REPORT, 'config'], { env, encoding: 'utf8' });
    const at = out.indexOf('retired setting(s)');
    assert.ok(at >= 0, out);
    const tail = out.slice(at);
    for (const k of LOOP) assert.match(tail, new RegExp(`${k}:? .*jev-hooks owns loop detection`));
  });
});
