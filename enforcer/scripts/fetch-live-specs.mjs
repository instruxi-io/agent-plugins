#!/usr/bin/env node
// Fetch each deployed server's swagger document into a directory the contract test reads (CONTRACT_SPEC_DIR).
//   node scripts/fetch-live-specs.mjs <outdir>
//   node scripts/fetch-live-specs.mjs --expect fetched|unexposed|auth-required <outdir>
//
// Default URL: <CONTRACT_BASE_URL | https://api.instruxi.dev>/api/v1/<service>/swagger/doc.json
// Overrides: CONTRACT_URL_GRAPH, CONTRACT_URL_ENFORCER, CONTRACT_URL_FILES, CONTRACT_URL_GOVERNANCE.
// Optional credential for a route that already answers 401/403: CONTRACT_SPEC_BEARER. Never print it.
//
// Those four URLs returned the live documents through the 2026-10-12 nightly. From 2026-11-01 the public
// edge answers them with nginx's HTML 404 while each service's /health is up: the route is not published.
// This script records that fact. It does not rewrite the URL to somewhere else, and it does not treat the
// pinned specs as if they were the deployed ones.
//
// Exit 0  all four documents were written. The contract test may run against <outdir>.
// Exit 10 all four are unpublished (edge nginx 404, or the app itself has no such route) and every
//         service health check is up. Writes deployed-swagger.json with evaluated_contract false.
//         That directory is not a contract pass; refuseUnexposedMarker makes the contract test throw.
// Exit 11 all four answered 401/403 and no bearer was configured. Same marker, different signal.
// Exit 1  anything else: a partial result, a 5xx, health down, a bearer the server rejected, a 404
//         that is not the edge page or the app. No marker, no spec files.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from './extract-api-usage.mjs';

export const MARKER = 'deployed-swagger.json';
export const SIGNAL_UNEXPOSED = 'deployed-swagger-intentionally-unexposed';
export const SIGNAL_AUTH = 'deployed-swagger-auth-required';
export const ALTERNATE_EVIDENCE =
  'Authenticated evidence is the contract-nightly job "authenticated source-main contract" (id main). It uses SPEC_SYNC_TOKEN to read docs/swagger.json from each private service repo at that repo\'s main and runs the contract test. That is source main, not the bytes on the deployed pods. This signal is not a deployed-contract pass. Do not publish the swagger route on the public edge to turn this check green. CONTRACT_SPEC_BEARER is the only in-repo way to fetch a spec that is already reachable with a credential.';

const EXPECT = new Set(['fetched', 'unexposed', 'auth-required']);
const NGINX_404 = /<center>\s*nginx\s*<\/center>/i;

export function defaultSwaggerUrl(base, service) {
  return `${String(base).replace(/\/+$/, '')}/api/v1/${service}/swagger/doc.json`;
}
export function defaultHealthUrl(base, service) {
  return `${String(base).replace(/\/+$/, '')}/api/v1/${service}/health`;
}

export function classifySwagger({ status, contentType = '', body = '' }) {
  if (status === 200) {
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    if (json && json.paths && typeof json.paths === 'object' && !Array.isArray(json.paths)) {
      return { class: 'document', document: json, paths: Object.keys(json.paths).length };
    }
    return { class: 'invalid' };
  }
  if (status === 401 || status === 403) return { class: 'auth' };
  if (status === 404 && body.length <= 4096 && /text\/html/i.test(contentType) && /404 Not Found/.test(body) && NGINX_404.test(body)) {
    return { class: 'edge-unexposed' };
  }
  if (status === 404 && appNotMounted(contentType, body)) return { class: 'not-mounted' };
  return { class: 'unexpected' };
}

function appNotMounted(contentType, body) {
  const text = String(body).slice(0, 2000);
  if (/Cannot GET \S*swagger\/doc\.json/.test(text)) return true;
  const looksJson = /json/i.test(contentType) || text.trim().startsWith('{');
  if (!looksJson) return false;
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json) || json.paths) return false;
    return Boolean(json.error || json.message);
  } catch {
    return false;
  }
}

// A health body counts only when it is the service's own ok document, not a generic "{status:ok}".
export function readHealth(status, body) {
  if (status !== 200) return { ok: false, version: null };
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const ok = Boolean(
    json && json.status === 'ok' && (typeof json.service === 'string' || (json.checks && typeof json.checks === 'object' && !Array.isArray(json.checks))),
  );
  const version = ok && typeof json.version === 'string' && /^[0-9a-f]{7,40}$/.test(json.version) ? json.version : null;
  return { ok, version };
}

export function aggregate(rows, { bearerConfigured }) {
  if (rows.length !== Object.keys(SERVICES).length) return 'failed';
  const classes = rows.map((r) => r.swaggerClass);
  if (classes.every((c) => c === 'document')) return 'fetched';
  const unpublished = (c) => c === 'edge-unexposed' || c === 'not-mounted';
  if (classes.every(unpublished) && rows.every((r) => r.healthOk)) return 'unexposed';
  if (classes.every((c) => c === 'auth')) return bearerConfigured ? 'auth-rejected' : 'auth-required';
  return 'failed';
}

export function refuseUnexposedMarker(dir) {
  if (!dir) return;
  const file = join(dir, MARKER);
  if (!existsSync(file)) return;
  let marker = {};
  try {
    marker = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    marker = {};
  }
  const why = marker.signal || 'an unreadable deployed-swagger marker';
  const alt = marker.alternate_evidence ? ` ${marker.alternate_evidence}` : '';
  throw new Error(`CONTRACT_SPEC_DIR ${dir} holds ${MARKER} (${why}), so it is not a deployed contract.${alt}`);
}

function endpoints(env, service) {
  const base = env.CONTRACT_BASE_URL || 'https://api.instruxi.dev';
  const key = service.toUpperCase();
  return {
    swagger: env[`CONTRACT_URL_${key}`] || defaultSwaggerUrl(base, service),
    health: env[`CONTRACT_HEALTH_URL_${key}`] || defaultHealthUrl(base, service),
  };
}

async function request(url, headers, fetchImpl) {
  let res = null;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { status: 0, contentType: '', body: '', error: e.message };
  }
  let contentType = '';
  try {
    contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') || '' : '';
  } catch {
    contentType = '';
  }
  let body = '';
  try {
    body = typeof res.text === 'function' ? await res.text() : '';
  } catch (e) {
    return { status: res.status || 0, contentType, body: '', error: e.message };
  }
  if (body.length > 32 * 1024 * 1024) return { status: res.status || 0, contentType, body: '', error: 'response exceeds 32MB' };
  return { status: res.status, contentType, body };
}

function needsHealth(swaggerClass) {
  return swaggerClass === 'edge-unexposed' || swaggerClass === 'not-mounted';
}

function serviceRecord(row) {
  const rec = {
    service: row.service,
    spec_file: `${row.specFile}.json`,
    swagger_url: row.swaggerUrl,
    swagger_status: row.swaggerStatus,
    swagger_class: row.swaggerClass,
    health_url: row.healthUrl,
    health_status: row.healthStatus,
    health_ok: row.healthOk,
  };
  if (row.deployedVersion) rec.deployed_version = row.deployedVersion;
  return rec;
}

export async function fetchLiveSpecs(out, { fetchImpl = globalThis.fetch, env = process.env, log = console } = {}) {
  if (!out) throw new Error('outdir is required');
  const resolved = resolve(out);
  const banned = `${sep}lib${sep}api${sep}spec`;
  if (resolved === sep || resolved.endsWith(banned) || resolved.endsWith(`${sep}lib${sep}api`)) {
    throw new Error(`refusing to write live specs into ${resolved}`);
  }
  mkdirSync(resolved, { recursive: true });
  for (const name of Object.values(SERVICES)) rmSync(join(resolved, `${name}.json`), { force: true });
  rmSync(join(resolved, MARKER), { force: true });

  const token = String(env.CONTRACT_SPEC_BEARER || '').trim();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const rows = [];
  for (const [service, specFile] of Object.entries(SERVICES)) {
    const url = endpoints(env, service);
    const swagger = await request(url.swagger, headers, fetchImpl);
    const classified = classifySwagger(swagger);
    const row = {
      service,
      specFile,
      swaggerUrl: url.swagger,
      swaggerStatus: swagger.status,
      swaggerClass: classified.class,
      paths: classified.paths || 0,
      document: classified.document || null,
      healthUrl: url.health,
      healthStatus: null,
      healthOk: false,
      deployedVersion: null,
      error: swagger.error || '',
    };
    if (needsHealth(classified.class)) {
      const health = await request(url.health, headers, fetchImpl);
      const read = readHealth(health.status, health.body);
      row.healthStatus = health.status;
      row.healthOk = read.ok;
      row.deployedVersion = read.version;
      if (health.error) row.error = [row.error, health.error].filter(Boolean).join('; ');
    }
    rows.push(row);
  }

  const mode = aggregate(rows, { bearerConfigured: Boolean(token) });
  if (mode === 'fetched') {
    for (const row of rows) {
      writeFileSync(join(resolved, `${row.specFile}.json`), JSON.stringify(row.document));
      log.log(`ok   ${row.service}: ${row.swaggerUrl} (${row.paths} paths)`);
    }
    return { exitCode: 0, mode, out: resolved };
  }
  if (mode === 'unexposed' || mode === 'auth-required') {
    const marker = {
      signal: mode === 'unexposed' ? SIGNAL_UNEXPOSED : SIGNAL_AUTH,
      evaluated_contract: false,
      alternate_evidence: ALTERNATE_EVIDENCE,
      services: rows.map(serviceRecord),
    };
    writeFileSync(join(resolved, MARKER), JSON.stringify(marker, null, 2) + '\n');
    log.log(`signal ${marker.signal}`);
    log.log(marker.alternate_evidence);
    for (const rec of marker.services) {
      const version = rec.deployed_version ? ` version=${rec.deployed_version}` : '';
      const health = rec.health_status == null ? 'health not consulted' : `health HTTP ${rec.health_status}${rec.health_ok ? ' ok' : ''}${version}`;
      log.log(`  ${rec.service}: swagger HTTP ${rec.swagger_status} ${rec.swagger_class}; ${health}`);
    }
    return { exitCode: mode === 'unexposed' ? 10 : 11, mode, out: resolved };
  }
  for (const row of rows) {
    const health = row.healthStatus == null ? 'health not consulted' : `health HTTP ${row.healthStatus}${row.healthOk ? ' ok' : ' not-ok'}`;
    log.error(`FAIL ${row.service}: ${row.swaggerUrl}: HTTP ${row.swaggerStatus} ${row.swaggerClass}; ${health}${row.error ? ` (${row.error})` : ''}`);
  }
  if (mode === 'auth-rejected') log.error('FAIL CONTRACT_SPEC_BEARER was set and the swagger routes still refused it');
  return { exitCode: 1, mode, out: resolved };
}

async function cli() {
  const argv = process.argv.slice(2);
  let expectMode = null;
  if (argv[0] === '--expect') {
    expectMode = argv[1];
    if (!EXPECT.has(expectMode)) {
      console.error('usage: fetch-live-specs.mjs [--expect fetched|unexposed|auth-required] <outdir>');
      return 2;
    }
    argv.splice(0, 2);
  }
  const out = argv[0];
  if (!out || argv.length !== 1) {
    console.error('usage: fetch-live-specs.mjs [--expect fetched|unexposed|auth-required] <outdir>');
    return 2;
  }
  const { exitCode, mode } = await fetchLiveSpecs(out);
  if (!expectMode) return exitCode;
  if (mode !== expectMode) {
    console.error(`expected ${expectMode}, classified ${mode}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`FAIL ${e.message}`);
      process.exit(1);
    });
}
