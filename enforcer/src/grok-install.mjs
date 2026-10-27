// `enforcer harness install grok` / `uninstall grok`: both migrate off the old runtime copy (see harness-migrate.mjs).
// Grok installs the plugin natively (`grok plugin install enforcer --trust`) and runs hooks/grok/* from the plugin root.
import { homedir } from 'node:os';
import { migrate } from './harness-migrate.mjs';

export const install = ({ dryRun = false, home = homedir(), out = undefined } = /** @type {any} */ ({})) => migrate('grok', { dryRun, home, out });
export const uninstall = install;
