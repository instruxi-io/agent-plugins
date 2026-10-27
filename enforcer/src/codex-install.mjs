// `enforcer harness install codex` / `uninstall codex`: both migrate off the old runtime copy (see harness-migrate.mjs).
// Codex installs the plugin natively (`codex plugin add enforcer@instruxi`) and runs hooks/codex/* from the plugin root.
import { homedir } from 'node:os';
import { migrate } from './harness-migrate.mjs';

export const install = ({ dryRun = false, home = homedir(), out = undefined } = /** @type {any} */ ({})) => migrate('codex', { dryRun, home, out });
export const uninstall = install;
