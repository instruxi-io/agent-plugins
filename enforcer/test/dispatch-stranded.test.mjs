// `node --test test/dispatch-stranded.test.mjs`: telling a stranded node from a worked one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strandedReport, strandedLines } from '../src/dispatch/stranded.mjs';

const NOW = Date.parse('2026-10-12T21:00:00Z');
const at = (min) => new Date(NOW + min * 60000).toISOString();
const run = (key, leaseMin, extra = {}) => ({ key, status: 'running', type: 'task', lease_expires_at: at(leaseMin), ...extra });

test('a lapsed lease is stranded, a live one is not', () => {
  const r = strandedReport([run('a', -124), run('b', 4)], { dispatcherRunning: true, now: NOW });
  assert.deepEqual(
    r.stranded.map((s) => s.key),
    ['a'],
  );
  assert.equal(r.orphaned.length, 0);
});

test('with no dispatcher, a live lease is orphaned and a lapsed one stranded; the restart hint appears', () => {
  const r = strandedReport([run('a', -5), run('b', 4)], { dispatcherRunning: false, now: NOW });
  assert.deepEqual(
    r.stranded.map((s) => s.key),
    ['a'],
  );
  assert.deepEqual(
    r.orphaned.map((s) => s.key),
    ['b'],
  );
  const { lines, bad } = strandedLines(r, 'G', { dispatcherRunning: false });
  assert.equal(bad, true);
  assert.match(lines.join('\n'), /STRANDED \(1\).*NOT running/);
  assert.match(lines.join('\n'), /a: lease lapsed 5m ago, no heartbeat/);
  assert.match(lines.join('\n'), /restart it: enforcer dispatch G/);
});

test('a gate with a run is flagged', () => {
  const r = strandedReport([run('gate-roll-prod', 4, { type: 'gate' })], { dispatcherRunning: true, now: NOW });
  assert.deepEqual(
    r.gateRuns.map((g) => g.key),
    ['gate-roll-prod'],
  );
  assert.match(strandedLines(r, 'G', { dispatcherRunning: true }).lines.join('\n'), /gates are decided, not claimed/);
});

test('a quiet worker log marks a live-lease node, only while the dispatcher is up', () => {
  const old = NOW - 25 * 60000;
  const r = strandedReport([run('a', 4)], { dispatcherRunning: true, logMtime: () => old, now: NOW });
  assert.deepEqual(
    r.quiet.map((q) => q.key),
    ['a'],
  );
  const fresh = strandedReport([run('a', 4)], { dispatcherRunning: true, logMtime: () => NOW - 60000, now: NOW });
  assert.equal(fresh.quiet.length, 0);
  assert.equal(strandedReport([run('a', 4)], { dispatcherRunning: true, logMtime: () => null, now: NOW }).quiet.length, 0, 'no log, no claim about it');
});

test('nothing wrong prints nothing; the dispatcher lease node is ignored', () => {
  const r = strandedReport([run('a', 4), run('dispatcher-lease', -50, { data: { dispatcher_lease: true } }), { key: 'd', status: 'done' }], {
    dispatcherRunning: true,
    now: NOW,
  });
  assert.deepEqual(strandedLines(r, 'G', { dispatcherRunning: true }), { lines: [], bad: false });
});

test('dispatch status uses it and lists stranded nodes apart from workers', () => {
  const src = readFileSync(new URL('../src/dispatch-command.mjs', import.meta.url), 'utf8');
  assert.match(src, /strandedReport\(open/);
  assert.match(src, /!strandedKeys\.has\(n\.key\)/);
});
