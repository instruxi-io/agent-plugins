// Preload (node --import): give this process a private TMPDIR under the
// caller's one and remove it on exit, so temp HOMEs/worktrees never leak.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enf-test-'));
process.env.TMPDIR = dir;
// Isolation: never the developer's HOME, sign-in or harness environment.
const home = path.join(dir, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.npm_config_cache = path.join(dir, 'npm-cache');
for (const k of Object.keys(process.env)) {
  if (/^(ENFORCER_|JEV_HOOKS_|GRAPH_|CLAUDE_PLUGIN_|TYPESAFE_)/.test(k)) delete process.env[k];
}
// ...nor the developer's desktop: the dispatcher's notify-send is real, and --attend suites ring it.
process.env.ENFORCER_DISPATCH_NOTIFY = '0';
const rm = () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
};
// Orphaned hook children can recreate files just after we exit the first time,
// so sweep again after a short pause until the directory stays gone.
const clean = () => {
  rm();
  for (let i = 0; i < 6; i++) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    } catch {}
    if (!fs.existsSync(dir)) return;
    rm();
  }
};
process.on('exit', clean);
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => {
    clean();
    process.exit(1);
  });
