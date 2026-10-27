// SessionStart: tell the user when the old Grok runtime copy (written by the retired copier) is still on disk.
// Grok installs the plugin natively now and runs hooks from the plugin root, so any copy there is stale.
// Never fails: Grok must not be blocked by a notice.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
try {
  const base = join(homedir(), '.config', 'enforcer', 'grok');
  if (existsSync(join(base, 'manifest.json')) || existsSync(join(base, 'VERSION')))
    process.stderr.write(`enforcer: old runtime copy at ${base}; run \`enforcer harness uninstall grok\` to remove it.\n`);
} catch {
  /* nothing to report */
}
process.exit(0);
