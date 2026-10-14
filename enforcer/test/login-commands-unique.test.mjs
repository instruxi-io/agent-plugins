// login.mjs dispatches on `cmd` with one `if (cmd === '<name>')` branch per command. A bad merge once pasted a
// second copy of scopes/logout/api-key/browser above the real ones: the first `browser` copy returned with
// status output that used an undeclared `how`, so every browser sign-in crashed with "how is not defined"
// after saving the credential, and the real sign-in output (granted scopes, workspace, reconnect step)
// never ran. Each command has exactly one branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../bin/login.mjs', import.meta.url), 'utf8');

test('every login command has exactly one dispatch branch', () => {
  const names = [...SOURCE.matchAll(/if \(cmd === '([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(names.includes('browser'), 'the browser branch exists');
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicated command branches: ${dupes.join(', ')}`);
});

test('the browser branch prints the sign-in result, not the status block', () => {
  const start = SOURCE.indexOf("if (cmd === 'browser')");
  const body = SOURCE.slice(start, SOURCE.indexOf('\n  }\n', start));
  assert.doesNotMatch(body, /\$\{how\}/, 'browser output must not use the status-only `how`');
  assert.match(body, /const notice = await replacementNotice\(/, 'the replaced sign-in is revoked and the reconnect step printed');
  assert.match(body, /for \(const line of notice\) out\(line\)/);
});
