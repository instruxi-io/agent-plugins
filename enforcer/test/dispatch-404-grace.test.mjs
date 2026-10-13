// `node --test test/dispatch-404-grace.test.mjs`: a graph that answers 404 is retried for a grace window, then the
// dispatcher exits loudly. Before this, the first 404 ended the dispatcher and stranded every running node: the
// leases lapsed, the nodes stayed "running", and nothing was alive to re-claim them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIError } from '../src/dispatch/api.mjs';
import { Dispatcher, defaultArgs, parseDispatchArgs } from '../src/dispatch/run.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'grace-'));
const mkArgs = (state, o = {}) =>
  defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), interval: 0.02, noLease: true, ...o });

// nodes() answers 404 for the first `bad` calls (or always when bad is Infinity), then an empty graph.
class Flaky {
  constructor(bad) {
    this.bad = bad;
    this.calls = 0;
  }
  async graph() {
    return {};
  }
  async nodes() {
    this.calls++;
    if (this.calls <= this.bad) throw new APIError(404, 'not found');
    return [];
  }
  async frontier() {
    return [];
  }
  async reviewOpen() {
    return [];
  }
  async runs() {
    return [];
  }
}

test('a few 404s are retried and the dispatcher carries on', async () => {
  const state = tmp();
  const api = new Flaky(3);
  const lines = [];
  const rc = await new Dispatcher(api, mkArgs(state, { apiGrace: 30 }), (s) => lines.push(s)).run();
  assert.equal(rc, 0, 'recovered, then idled out normally, not exit 1');
  assert.ok(lines.some((l) => /HTTP 404 from graph g .*retrying for up to 30s/.test(l)));
  assert.ok(lines.some((l) => /graph g is answering again/.test(l)));
  assert.ok(!lines.some((l) => /exiting 1/.test(l)));
});

test('a 404 that outlasts the grace window exits 1 and says why', async () => {
  const state = tmp();
  const api = new Flaky(Infinity);
  const lines = [];
  const rc = await new Dispatcher(api, mkArgs(state, { apiGrace: 0.1 }), (s) => lines.push(s)).run();
  assert.equal(rc, 1);
  assert.ok(api.calls >= 2, 'it retried before giving up');
  assert.ok(lines.some((l) => /HTTP 404: graph g answered 404 for .* exiting 1/.test(l)));
});

test('the grace window is an option and defaults to ten minutes', () => {
  assert.equal(parseDispatchArgs(['g'], {}).apiGrace, 600);
  assert.equal(parseDispatchArgs(['g', '--api-grace', '45'], {}).apiGrace, 45);
});
