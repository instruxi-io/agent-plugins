// `npm test` (node scripts/test.mjs): run every suite in its own process, report every suite's result (a failure never masks the
// ones after it), and write JUnit XML to test-results/junit.xml for CI.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Every *.test.mjs under test/ and lib/governor/test/ is discovered, so a new suite never needs a list edit
// (package.json's test script is one fixed line). Each runs in its own process under the isolating preload
// (test/tmp-cleanup.mjs) with a per-suite timeout. Slow end-to-end suites (graph/run, hooks-latency) run last.
const TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS) || 300_000;
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'tmp-cleanup.mjs')).href;
const walk = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules' || e.name === 'fixtures'
        ? []
        : walk(`${dir}/${e.name}`)
      : e.name.endsWith('.test.mjs')
        ? [`${dir}/${e.name}`]
        : [],
  );
// test/dispatch/runtime SIGTERMs its own process, which the preload's signal handler turns into exit 1: it runs bare
const NO_PRELOAD = /(^|\/)dispatch\/runtime\.test\.mjs$/;
const SLOW = /(^|\/)(graph\/run|hooks-latency)\.test\.mjs$/;
const files = [...walk('test'), ...walk('lib/governor/test')].sort((a, b) => SLOW.test(a) - SLOW.test(b) || a.localeCompare(b));
const SUITES = [
  ...files.map((f) => [f.replace(/\.test\.mjs$/, ''), { cmd: process.execPath, args: [...(NO_PRELOAD.test(f) ? [] : ['--import', PRELOAD]), join(ROOT, f)] }]),
  // tsc through node, not node_modules/.bin: on Windows the .bin entry is a .cmd shim Node will not spawn without a shell
  // the linter and the formatter are suites, so CI (which runs npm test) enforces them
  ['lint (biome)', { cmd: process.execPath, args: [join(ROOT, 'scripts', 'biome.mjs'), 'lint'] }],
  ['format check (biome)', { cmd: process.execPath, args: [join(ROOT, 'scripts', 'biome.mjs'), 'format'] }],
  ['tsc (plugin source)', { cmd: process.execPath, args: [join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'] }],
  ['tsc (generated API types)', { cmd: process.execPath, args: [join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'lib/api/tsconfig.json'] }],
];

// Per-platform profile: on Windows only hooks and CLIs run; the dispatcher and governor suites are skipped with a reason.
const WIN_SKIP = /^(test\/dispatch\/|lib\/governor\/|test\/graph\/|test\/land)/;
const skipReason = (name) =>
  process.platform === 'win32' && WIN_SKIP.test(name) ? 'dispatcher, governor and landing are not supported on Windows (hooks and CLIs only)' : null;
// test/quarantine.json: [{suite, owner, expires: YYYY-MM-DD, reason, os?}]. A quarantined suite still runs; its failure is
// reported as skipped, not red, until the expiry date, after which it fails the run again. An optional `os` list
// (process.platform values: darwin, win32, linux) scopes the entry, so a suite red only on macOS stays a gate on Linux.
const QFILE = join(ROOT, '..', 'test', 'quarantine.json');
const quarantine = existsSync(QFILE) ? JSON.parse(readFileSync(QFILE, 'utf8')) : [];
const quarantined = (name) =>
  quarantine.find((q) => name.includes(q.suite) && (!q.os || q.os.includes(process.platform)) && q.expires >= new Date().toISOString().slice(0, 10));

const esc = (s) =>
  String(s)
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const results = [];
for (const [name, { cmd, args, cwd }] of SUITES) {
  if (only && !only.test(name)) continue;
  const skip = skipReason(name);
  if (skip) {
    process.stdout.write(`skip  ${name} (${skip})\n`);
    results.push({ name, ok: true, skipped: skip, seconds: 0, out: '', status: 0 });
    continue;
  }
  const t = Date.now();
  // glob arguments for node --test are expanded by node itself (>= 21); older nodes get the shell's expansion
  // ENFORCER_DISPATCH_NOTIFY=0 here as well as in the preload: the suites that run bare must not ring the desktop either
  const env = { ...process.env, ENFORCER_DISPATCH_NOTIFY: '0' };
  const r = spawnSync(cmd, args, { cwd: cwd || ROOT, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: TIMEOUT_MS });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const out = (r.stdout || '') + (r.stderr || '') + (r.error ? `\n${timedOut ? `suite timed out after ${TIMEOUT_MS}ms` : r.error.message}` : '');
  const q = r.status === 0 ? null : quarantined(name);
  const ok = r.status === 0 || !!q;
  process.stdout.write(`${r.status === 0 ? 'ok  ' : q ? 'quar' : 'FAIL'}  ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)\n`);
  if (!ok) {
    const all = out.split('\n');
    // the failing cases and their errors sit above the tail of a long TAP stream: print them first
    const hits = all.filter((l) => /^\s*(not ok|error:|expected:|actual:|operator:|failureType:)/.test(l)).slice(0, 80);
    if (hits.length) process.stdout.write('--- failing cases ---\n' + hits.join('\n') + '\n--- tail ---\n');
    process.stdout.write(all.slice(-60).join('\n') + '\n');
  }
  results.push({ name, ok, quarantined: q && `quarantined until ${q.expires}, owner ${q.owner}`, seconds: (Date.now() - t) / 1000, out, status: r.status });
}

const failed = results.filter((r) => !r.ok);
const expired = quarantine.filter((q) => q.expires < new Date().toISOString().slice(0, 10));
if (expired.length) {
  console.log(`expired quarantine entries: ${expired.map((q) => q.suite).join(', ')}`);
  failed.push(...expired.map((q) => ({ name: `quarantine expired: ${q.suite}` })));
}
mkdirSync(join(ROOT, 'test-results'), { recursive: true });
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="enforcer" tests="${results.length}" failures="${failed.length}" time="${results.reduce((a, r) => a + r.seconds, 0).toFixed(3)}">
${results
  .map(
    (
      r,
    ) => `  <testsuite name="${esc(r.name)}" tests="1" failures="${r.ok ? 0 : 1}" skipped="${r.skipped || r.quarantined ? 1 : 0}" time="${r.seconds.toFixed(3)}">
    <testcase classname="enforcer" name="${esc(r.name)}" time="${r.seconds.toFixed(3)}">${
      r.skipped
        ? `
      <skipped message="${esc(r.skipped)}"/>`
        : r.quarantined
          ? `
      <skipped message="${esc(r.quarantined)}"/>`
          : r.ok
            ? ''
            : `
      <failure message="exit ${r.status}">${esc(r.out.split('\n').slice(-80).join('\n'))}</failure>`
    }
    </testcase>
  </testsuite>`,
  )
  .join('\n')}
</testsuites>
`;
writeFileSync(join(ROOT, 'test-results', 'junit.xml'), xml);
console.log(`\n${results.length - failed.length} suites passed, ${failed.length} failed`);
if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(', ')}`);
process.exit(failed.length ? 1 : 0);
