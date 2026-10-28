// Shared by `npm run bump` and the CI version-bump job.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The ten manifests that carry the enforcer version. `pick` finds the object holding it.
export const MANIFESTS = [
  { file: 'enforcer/plugin.json', pick: (j) => j },
  { file: 'enforcer/.claude-plugin/plugin.json', pick: (j) => j },
  { file: 'enforcer/.codex-plugin/plugin.json', pick: (j) => j },
  { file: 'enforcer/.cursor-plugin/plugin.json', pick: (j) => j },
  { file: 'enforcer/package.json', pick: (j) => j },
  { file: 'kit.json', pick: (j) => j },
  { file: 'gemini-extension.json', pick: (j) => j },
  { file: '.claude-plugin/marketplace.json', pick: (j) => j.plugins.find((p) => p.name === 'enforcer') },
  { file: '.agents/plugins/marketplace.json', pick: (j) => j.plugins.find((p) => p.name === 'enforcer') },
  { file: '.cursor-plugin/marketplace.json', pick: (j) => j.plugins.find((p) => p.name === 'enforcer') },
];

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function readVersions(root = '.') {
  return MANIFESTS.map((m) => ({
    file: m.file,
    version: m.pick(JSON.parse(fs.readFileSync(path.join(root, m.file), 'utf8'))).version,
  }));
}

export function bump(version, root = '.') {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  for (const m of MANIFESTS) {
    const f = path.join(root, m.file);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    m.pick(j).version = version;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }
  return version;
}

// Throws unless every manifest agrees and the tag equals that version.
export function checkTag(tag, root = '.') {
  const vs = readVersions(root);
  const want = vs[0].version;
  const odd = vs.filter((v) => v.version !== want);
  if (odd.length) throw new Error('manifests disagree: ' + vs.map((v) => `${v.file}=${v.version}`).join(', '));
  if (tag.replace(/^v/, '') !== want) throw new Error(`tag ${tag} != plugin.json version ${want}`);
  return want;
}

// Fragments: changes/*.md except README.md, sorted by file name; each fragment's text becomes one bullet.
export function readFragments(root = '.') {
  const dir = path.join(root, 'changes');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => ({
      file: path.join('changes', f),
      text: fs.readFileSync(path.join(dir, f), 'utf8').trim().replace(/^- /, ''),
    }));
}

function unreleasedBody(text) {
  const m = /^## Unreleased[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  return m ? m[1].trim() : null;
}

// Throws (writing nothing) when there is nothing to release. Otherwise inserts `## <version>` directly under
// `## Unreleased`, then deletes the fragment files.
export function foldFragments(version, root = '.') {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  const f = path.join(root, 'CHANGELOG.md');
  const text = fs.readFileSync(f, 'utf8');
  const frags = readFragments(root);
  const body = unreleasedBody(text);
  if (body === null) throw new Error('CHANGELOG.md has no "## Unreleased" section');
  if (!frags.length && !body) throw new Error('nothing to release: no changes/*.md fragments and the Unreleased section is empty');
  const bullets = frags.map((x) => `- ${x.text}`).join('\n');
  const section = `## ${version}\n\n` + [body, bullets].filter(Boolean).join('\n\n') + '\n';
  const out = text.replace(/^(## Unreleased[^\n]*\n)([\s\S]*?)(?=^## |(?![\s\S]))/m, `$1\n${section}\n`);
  fs.writeFileSync(f, out.replace(/\n{3,}/g, '\n\n'));
  for (const x of frags) fs.unlinkSync(path.join(root, x.file));
  return frags.length;
}

export function releaseNotes(version, root = '.') {
  const t = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const m = new RegExp(`^## ${version.replace(/\./g, '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(t);
  if (!m) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  return m[1].trim();
}

export function changelogHas(version, root = '.') {
  const t = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  return new RegExp(`^## ${version.replace(/\./g, '\\.')}( |$)`, 'm').test(t) || /^## Unreleased/m.test(t);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'bump') {
      // Refuse before writing anything.
      if (!SEMVER.test(arg || '')) throw new Error(`not a semver version: ${arg}`);
      const t = fs.readFileSync('CHANGELOG.md', 'utf8');
      if (!readFragments().length && !unreleasedBody(t)) throw new Error('nothing to release: no changes/*.md fragments and the Unreleased section is empty');
      const n = foldFragments(arg);
      console.log(`bumped six manifests to ${bump(arg)}; folded ${n} fragment(s) into CHANGELOG.md`);
    } else if (cmd === 'notes') console.log(releaseNotes(arg));
    else if (cmd === 'check-tag') console.log('tag ok: ' + checkTag(arg));
    else if (cmd === 'check-changed') {
      // arg = last tag, process.argv[4] = base ref (default origin/main). A PR that touches enforcer/ either
      // bumps the version (and the changelog covers it) or adds one fragment under changes/ — one small file per
      // PR so parallel PRs never conflict on CHANGELOG.md; the release node folds the fragments into the heading.
      const cur = readVersions()[0].version;
      const base = process.argv[4] || 'origin/main';
      if (cur !== arg.replace(/^v/, '')) {
        if (!changelogHas(cur)) throw new Error(`CHANGELOG.md has no "## ${cur}" or "## Unreleased" entry`);
        console.log(`version ${cur} differs from ${arg} and CHANGELOG.md covers it`);
      } else {
        const added = execSync(`git diff --name-only --diff-filter=A ${base}...HEAD -- changes/`, { encoding: 'utf8' })
          .split('\n')
          .filter((f) => /^changes\/[^/]+\.md$/.test(f));
        if (!added.length)
          throw new Error(
            `enforcer/ changed at version ${cur} (last tag ${arg}) with no changes/<slug>.md fragment; add one line under changes/ (or run npm run bump <version> for a release)`,
          );
        console.log(`version unchanged; fragment(s) added: ${added.join(', ')}`);
      }
    } else throw new Error('usage: release.mjs bump <v> | notes <v> | check-tag <tag> | check-changed <last-tag>');
  } catch (e) {
    console.error('FAIL ' + e.message);
    process.exit(1);
  }
}
