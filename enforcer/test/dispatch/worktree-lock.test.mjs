import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { worktreeFor, branchFor, planCode, withRepoLock } from '../../src/dispatch/worktree.mjs';

const sh = (a, cwd) => spawnSync('git', a, { cwd, encoding: 'utf8' });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'wt-'));
  const origin = join(root, 'origin.git');
  sh(['init', '-q', '--bare', '-b', 'main', origin], root);
  const src = join(root, 'r');
  mkdirSync(src);
  sh(['init', '-q', '-b', 'main'], src);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'], src);
  sh(['remote', 'add', 'origin', origin], src);
  sh(['push', '-q', 'origin', 'main'], src);
  return { root, src, state: join(root, 'state') };
}
const node = (key, extra = {}) => ({ key, data: { repo: 'r', base: 'main' }, ...extra });

test('worktree dir carries the plan code; same key in two graphs gets two dirs', () => {
  const { root, state } = repo();
  const [p1] = worktreeFor(node('make-lib'), root, state, { graphId: 'aaaaaaaa-1111' });
  const [p2] = worktreeFor(node('make-lib', { branch: 'graph/make-lib-b' }), root, state, { graphId: 'bbbbbbbb-2222' });
  assert.equal(p1, join(root, 'r-aaaaaaaa-make-lib'));
  assert.equal(p2, join(root, 'r-bbbbbbbb-make-lib'));
  assert.ok(existsSync(p1) && existsSync(p2));
});

test('branchFor uses the card branch, else graph/<key>; rejects unsafe refs', () => {
  assert.equal(branchFor({ key: 'k', branch: 'graph/x-y' }), 'graph/x-y');
  assert.equal(branchFor({ key: 'k' }), 'graph/k');
  assert.equal(branchFor({ key: 'k', branch: '../evil' }), 'graph/k');
  assert.equal(planCode('0a1b-2c3d4e5f'), '0a1b2c3d');
});

test('a stale branch with no commits ahead is reused, not fatal', () => {
  const { root, src, state } = repo();
  sh(['branch', 'graph/stale', 'main'], src);
  const [p, b, note] = worktreeFor(node('stale'), root, state, { graphId: 'cccccccc' });
  assert.equal(b, 'graph/stale');
  assert.ok(existsSync(p), note);
});

test('a held lock blocks a second holder until timeout', () => {
  const { src } = repo();
  assert.throws(() => withRepoLock(src, () => withRepoLock(src, () => 1, { timeoutMs: 200, staleSec: 3600 }), { timeoutMs: 200 }), /timed out/);
  assert.equal(
    withRepoLock(src, () => 'ok'),
    'ok',
  ); // released after the throw
});

test('two dispatcher processes adding worktrees in one repo both succeed', async () => {
  const { root, state } = repo();
  const mod = new URL('../../src/dispatch/worktree.mjs', import.meta.url).href;
  const code = (key, g) =>
    `import {worktreeFor} from ${JSON.stringify(mod)}; const r=worktreeFor({key:${JSON.stringify(key)},data:{repo:'r',base:'main'}},${JSON.stringify(root)},${JSON.stringify(state)},{graphId:${JSON.stringify(g)}}); console.log(r[0]);`;
  const run = (c) =>
    new Promise((res) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', c], { encoding: 'utf8' });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (rc) => res({ rc, out, err }));
    });
  const rs = await Promise.all([run(code('k1', 'aaaaaaaa')), run(code('k2', 'bbbbbbbb')), run(code('k3', 'cccccccc'))]);
  for (const r of rs) assert.equal(r.rc, 0, r.err);
  for (const r of rs) assert.ok(existsSync(r.out.trim()));
});

test('branchFor computes the server name from the plan code and epoch', () => {
  assert.equal(branchFor({ key: 'k' }, { code: 'K7M2QX', epoch: 2 }), 'graph/K7M2QX/k/e2');
  assert.equal(branchFor({ key: 'k', attempt: 3 }, { code: 'K7M2QX', epoch: 1 }), 'graph/K7M2QX/k/e1-a3');
  assert.equal(branchFor({ key: 'k' }, { code: 'K7M2QX' }), 'graph/K7M2QX/k/e1');
});

test('a branch with commits ahead is left alone; the next -a name is used', () => {
  const { root, src, state } = repo();
  sh(['branch', 'graph/busy', 'main'], src);
  const w = join(root, 'tmpwt');
  sh(['worktree', 'add', w, 'graph/busy'], src);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work'], w);
  sh(['worktree', 'remove', '--force', w], src);
  const [p, b] = worktreeFor(node('busy'), root, state, { graphId: 'dddddddd' });
  assert.equal(b, 'graph/busy-a2');
  assert.ok(existsSync(p));
  assert.equal(sh(['rev-list', '--count', 'main..graph/busy'], src).stdout.trim(), '1');
});

test("a new epoch never reuses the last epoch's worktree: a clean one is replaced, a dirty one refused", async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { StaleWorktree, worktreeBranch } = await import('../../src/dispatch/worktree.mjs');
  const { root, src, state } = repo();
  const o = (epoch) => ({ graphId: 'dddddddd-4444', graphCode: 'ZQP', graphEpoch: epoch });
  const [p1, b1, n1] = worktreeFor(node('card'), root, state, o(1));
  assert.match(n1, /^added off/);
  writeFileSync(join(p1, 'card.md'), 'epoch 1\n');
  sh(['add', 'card.md'], p1);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'epoch 1 card'], p1);
  // the same epoch again (a retry): reused as it is
  const [, , again] = worktreeFor(node('card'), root, state, o(1));
  assert.equal(again, 'reused');
  // the next epoch: same path, a fresh checkout of the base on the new branch, the old branch's commit kept
  const [p2, b2, n2] = worktreeFor(node('card'), root, state, o(2));
  assert.equal(p2, p1);
  assert.notEqual(b2, b1);
  assert.equal(worktreeBranch(p2), b2);
  assert.match(n2, new RegExp(`replaced the worktree left on ${b1.replace(/[/]/g, '\\/')}`));
  assert.equal(existsSync(join(p2, 'card.md')), false, "epoch 2 does not start with epoch 1's card");
  assert.equal(sh(['log', '-1', '--format=%s', b1], src).stdout.trim(), 'epoch 1 card', 'the old branch keeps its work');
  // a dry run says what it would do and touches nothing
  const [, , dry] = worktreeFor(node('card'), root, state, { ...o(3), dry: true });
  assert.match(dry, /would replace the worktree on /);
  assert.equal(worktreeBranch(p2), b2);
  // uncommitted changes on the old branch: refused, nothing removed
  writeFileSync(join(p2, 'wip.md'), 'x\n');
  sh(['add', 'wip.md'], p2);
  assert.throws(
    () => worktreeFor(node('card'), root, state, o(3)),
    (e) => e instanceof StaleWorktree && /uncommitted changes/.test(e.message),
  );
  assert.equal(readFileSync(join(p2, 'wip.md'), 'utf8'), 'x\n');
});
