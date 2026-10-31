#!/usr/bin/env node
// Extract every HTTP call site the plugin makes to an Enforcer API into test/contract/used.json:
// service, method, path template, the body keys it sends, the response keys it reads, the headers it names.
//
//   node scripts/extract-api-usage.mjs          rewrite test/contract/used.json
//   node scripts/extract-api-usage.mjs --check  exit 1 when the committed file is stale (CI runs the same check as a test)
//
// Method and path come from the code itself (the patterns in SOURCES below). What the code sends and reads is not
// derivable from a call expression, so it is declared beside the call in a comment:
//
//     // api-used: sends runner; reads data.id,data.run_id; headers X-Graph-Client
//
// on the call's line or in the comment lines just above it (Python uses `#`). A call without one declares no fields:
// the contract test then checks only that the method and path exist. Nothing here reads the network.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const USED_PATH = join(ROOT, 'test', 'contract', 'used.json');

// service -> the pinned spec it is checked against (lib/api/spec.lock.json `sources` name)
export const SERVICES = { graph: 'graph', enforcer: 'v3', files: 'files', governance: 'governance' };

// `{ file, service, prefix, re, method, path }`: `re` finds each call; `method`/`path` say what to take from it.
//   method: a group number, or a fixed verb, or 'scan' (read `method: 'X'` from the next 200 chars, else GET)
//   path:   a group number (a template literal body), prefix is prepended
const call = (file, service, re, method, path, prefix = '') => ({ file, service, re, method, path, prefix });
const SOURCES = [
  call('src/dispatch/api.mjs', 'graph', /\bthis\.call\(\s*'(\w+)'\s*,\s*`([^`]+)`/g, 1, 2),
  call('src/graph/hooks/session.mjs', 'graph', /\bpost\(cfg,\s*'(\w+)',\s*`([^`]+)`/g, 1, 2),
  call('src/graph/hooks/heartbeat.mjs', 'graph', /\bpost\(cfg,\s*'(\w+)',\s*`([^`]+)`/g, 1, 2),
  call('src/preflight.mjs', 'graph', /\bget\(base,\s*`([^`]+)`/g, 'GET', 1),
  call('bin/files.mjs', 'files', /\bcall\(fetchImpl, base, [`']([^`']+)[`']/g, 'scan', 1, '/storage'),
  call('bin/login.mjs', 'enforcer', /\$\{base\}\$\{API\}(\/[^`]*)`/g, 'scan', 1),
  call('bin/enforcer-workspace.mjs', 'enforcer', /\$\{base\}\$\{API\}(\/[^`]*)`/g, 'scan', 1),
  call('lib/governor/bin/login.mjs', 'enforcer', /\$\{base\}\$\{API\}(\/[^`]*)`/g, 'scan', 1),
  call('lib/governor/core/central.mjs', 'enforcer', /\$\{base\}\$\{API\}(\/[^`]*)`/g, 'scan', 1),
  call('lib/governor/core/identity.mjs', 'enforcer', /const PATH = '\/api\/v1\/enforcer(\/[^']*)'/g, 'GET', 1),
  call('lib/governor/core/managed.mjs', 'governance', /const PATH = '\/api\/v1\/governance(\/[^']*)'/g, 'GET', 1),
  call('lib/governor/core/ship.mjs', 'governance', /INGEST_PATH = '\/api\/v1\/governance(\/[^']*)'/g, 'POST', 1),
  call('lib/governor/core/attribution.mjs', 'governance', /ATTRIBUTION_PATH = '\/api\/v1\/governance(\/[^']*)'/g, 'POST', 1),
  call('lib/governor/core/approvals.mjs', 'governance', /_PATH = '\/api\/v1\/governance(\/[^']*)'/g, 'GET', 1),
];

/** `/graphs/${g}/nodes/${n}?limit=1` -> `/graphs/{}/nodes/{}`; Python `%s`/`%d` the same. */
export function normalizePath(p) {
  return (
    p
      .replace(/\$\{[^}]*\}/g, '{}')
      .replace(/%[sd]/g, '{}')
      .replace(/\?.*$/, '')
      .replace(/\/+$/, '') || '/'
  );
}

const ANNOTATION = /(?:\/\/|#)\s*api-used:\s*(.*)$/;
function parseAnnotation(text) {
  const out = { sends: [], reads: [], headers: [] };
  for (const part of text.split(';')) {
    const m = /^\s*(sends|reads|headers)\s+(.*?)\s*$/.exec(part);
    if (m)
      out[m[1]].push(
        ...m[2]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
  }
  return out;
}

/** The annotation for the call at `index`: on its line, else in the comment lines above it (up to 6 lines, through the same statement). */
function annotationFor(lines, lineNo) {
  let m = ANNOTATION.exec(lines[lineNo]);
  if (m) return parseAnnotation(m[1]);
  for (let i = lineNo - 1; i >= 0 && lineNo - i <= 6; i--) {
    const t = lines[i].trim();
    // a formatted call spans lines: step up through the lines of the same statement, but stop at a blank line or a finished statement
    if (!/^(\/\/|#|\*|\/\*)/.test(t)) {
      if (t === '' || /[;}]$/.test(t)) break;
      continue;
    }
    m = ANNOTATION.exec(t);
    if (m) return parseAnnotation(m[1]);
  }
  return { sends: [], reads: [], headers: [] };
}

export function extract(root = ROOT) {
  const calls = [];
  for (const s of SOURCES) {
    const src = readFileSync(join(root, s.file), 'utf8');
    const lines = src.split('\n');
    const seen = new Map();
    s.re.lastIndex = 0;
    for (let m; (m = s.re.exec(src)); ) {
      const lineNo = src.slice(0, m.index).split('\n').length - 1;
      let method = typeof s.method === 'number' ? m[s.method].toUpperCase() : s.method;
      if (method === 'scan') {
        const after = src.slice(m.index, m.index + 200);
        method = (/method:\s*'(\w+)'/.exec(after)?.[1] || 'GET').toUpperCase();
      }
      const path = s.prefix + normalizePath(m[s.path]);
      const key = `${s.file} ${method} ${path}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      const a = annotationFor(lines, lineNo);
      calls.push({ id: n > 1 ? `${key} #${n}` : key, file: s.file, service: s.service, method, path, sends: a.sends, reads: a.reads, headers: a.headers });
    }
    if (!seen.size) throw new Error(`extract-api-usage: no call site found in ${s.file}; the pattern or the file moved`);
  }
  return calls;
}

export const render = (calls) =>
  JSON.stringify(
    {
      _readme:
        'GENERATED by scripts/extract-api-usage.mjs - do not edit. Every HTTP call the plugin makes to an Enforcer API: method, path template, body keys sent, response keys read, headers named. `sends`/`reads`/`headers` come from the `api-used:` comment beside each call. test/contract/contract.test.mjs checks this file against the locked specs and fails when it is stale.',
      calls,
    },
    null,
    2,
  ) + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(extract());
  if (process.argv.includes('--check')) {
    let have = '';
    try {
      have = readFileSync(USED_PATH, 'utf8');
    } catch {}
    if (have !== text) {
      console.error('test/contract/used.json is stale: run `node scripts/extract-api-usage.mjs`');
      process.exit(1);
    }
    console.log('used.json is current');
  } else {
    writeFileSync(USED_PATH, text);
    console.log(`wrote ${USED_PATH}`);
  }
}
