// The Cursor listing guide stays honest: unverified auth and the dead contract URLs stay marked,
// the manifest's descriptive fields do not promise an approval dialog, and skills do not invent
// operation ids or a confirmation the pinned manifest does not have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('cursor guide names the unverified gaps and does not publish a revoke URL', () => {
  const doc = read('docs/CURSOR.md');
  assert.match(doc, /UNVERIFIED, pending Engineering \(CR-4\)/);
  assert.match(doc, /pending Engineering \(CR-3\)/);
  assert.match(doc, /TODO \(Austin\): support channel/);
  assert.match(doc, /TODO \(Austin\): terms of use/);
  assert.match(doc, /TODO \(Austin\): privacy notice/);
  assert.match(doc, /Workflow profile \(50\)/);
  assert.match(doc, /797/);
  assert.doesNotMatch(doc, /oauth\/revoke/i);
  assert.match(doc, /revocation_endpoint/);
  assert.match(doc, /returned 404/);
  assert.match(doc, /FSL-1\.1-ALv2/);
  assert.match(doc, /does not promise that every write waits/);
});

test('cursor manifest description matches the guide and declares no logo or secret', () => {
  const plugin = JSON.parse(read('.cursor-plugin/plugin.json'));
  const doc = read('docs/CURSOR.md');
  assert.equal(plugin.name, 'enforcer');
  assert.equal(plugin.license, 'FSL-1.1-ALv2');
  assert.equal(plugin.homepage, 'https://instruxi.io');
  assert.equal(plugin.description, doc.match(/^\| Description \| (.+) \|$/m)[1]);
  assert.deepEqual(plugin.keywords, ['enforcer', 'mcp', 'identity', 'authorization', 'governance', 'workspace', 'audit']);
  assert.equal(plugin.logo, undefined);
  assert.doesNotMatch(JSON.stringify(plugin), /sk-|api[_-]?key|secret/i);
  assert.match(read('README.md'), /docs\/CURSOR\.md/);
});

test('skills do not use the old files_ operation ids or a reset confirmation the pin lacks', () => {
  const files = read('skills/files/SKILL.md');
  assert.doesNotMatch(files, /files_getActiveStorageProvider|files_listS3Files|files_listGcsFiles/);
  assert.match(files, /getActiveStorageProvider/);
  assert.match(files, /listS3Files/);
  assert.doesNotMatch(read('skills/graph/SKILL.md'), /tool's own confirmation/);
  assert.match(read('skills/graph/SKILL.md'), /always_confirm` false/);
  assert.match(read('skills/enforcer/SKILL.md'), /Nothing here promises that every write waits for approval/);
  assert.doesNotMatch(read('skills/enforcer/SKILL.md'), /which the user confirms first/);
  for (const skill of ['skills/enforcer/SKILL.md', 'skills/files/SKILL.md', 'skills/governor/SKILL.md', 'skills/graph/SKILL.md']) {
    const fm = read(skill).split('---\n')[1];
    assert.match(fm, /^name: \S+/m, skill);
    assert.match(fm, /^description: \S+/m, skill);
  }
});
