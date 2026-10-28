#!/usr/bin/env node
// Sign this machine in to Enforcer — once, for the MCP server and every plugin that reads ~/.enforcer.
//
//   login.mjs              browser sign-in (OAuth 2.1, PKCE, loopback redirect)
//   login.mjs --for work|plan|agents|admin  scope preset (default: the last one used)
//   login.mjs --scope "a b" browser sign-in asking for only those scopes
//   login.mjs scopes       list the scopes this Enforcer offers a sign-in
//   login.mjs api-key -|FILE  use an existing Enforcer API key, read from stdin (-) or a file; never an argument
//   login.mjs status       who is signed in, and how
//   login.mjs logout       forget the credential on this machine
//
// The browser flow is the one Claude Code itself uses for a remote MCP server,
// done here so the result lands in ~/.enforcer/credentials.json where both
// tools read it: register a public client (RFC 7591), open the authorization
// URL, catch the redirect on 127.0.0.1, redeem the code with the PKCE verifier.
// The refresh token is kept, so the sign-in outlives the one-hour access
// token (credentials.mjs rotates it).
import { defaultFetch } from '../lib/api/client.mjs';
import { isMain } from '../src/is-main.mjs';
import { commandArgs, splitArgs } from '../src/args.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { currentWorkspace, describe } from './enforcer-workspace.mjs';
import { readCredentials, saveCredentials, legacyCredentialFile, enforcerKey, SHARED_FILE, authHeaders } from '../src/credentials.mjs';
import { resolveConfig, flagValue } from '../src/config.mjs';
import { onLogin as geminiOnLogin, statusLine as geminiStatusLine } from '../src/gemini-telemetry.mjs';

const API = '/api/v1/enforcer';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const out = (s) => process.stdout.write(s + '\n');

/** Login scope presets: a work-loop session needs 6-7 scopes, not every one the server offers. */
export const WORK_SCOPES = [
  'enforcer:read',
  'policy:self',
  'enforcer:graph-runs.write',
  'enforcer:graph-observations.write',
  'enforcer:graph-nodes.write',
  'enforcer:graph-edges.write',
  'enforcer:files-files.write',
  'enforcer:workspace.write' /* workspace switch/join; only requested when the server offers it */,
];
export const PLAN_SCOPES = [...WORK_SCOPES, 'enforcer:graph-graphs.write', 'enforcer:graph-graph-templates.write', 'enforcer:graph-epochs.write'];
export const AGENTS_SCOPES = ['enforcer:read', 'policy:self', 'enforcer:agents.write', 'enforcer:agents-credentials.write'];
export const PRESETS = { work: WORK_SCOPES, plan: PLAN_SCOPES, agents: AGENTS_SCOPES, admin: null /* everything offered */ };
export const DEFAULT_PRESET = 'work';

/** Capability families the plugin has tools for: the scopes each needs and the login that grants them. */
export const FAMILIES = [
  {
    name: 'graph runs and nodes',
    needs: ['enforcer:graph-runs.write', 'enforcer:graph-observations.write', 'enforcer:graph-nodes.write', 'enforcer:graph-edges.write'],
    fix: 'enforcer login --for work',
  },
  {
    name: 'graph import and templates',
    needs: ['enforcer:graph-graphs.write', 'enforcer:graph-graph-templates.write', 'enforcer:graph-epochs.write'],
    fix: 'enforcer login --for plan',
  },
  { name: 'files', needs: ['enforcer:files-files.write'], fix: 'enforcer login --for work' },
  { name: 'agent management', needs: ['enforcer:agents.write', 'enforcer:agents-credentials.write'], fix: 'enforcer login --for agents' },
  { name: 'workspace switching', needs: ['enforcer:workspace.write'], fix: 'enforcer login --for work' },
];

/** Lines saying which scopes a browser sign-in holds and which families they cover. Never prints a token. */
export function scopeLines(scopeString) {
  const granted = String(scopeString || '')
    .split(/\s+/)
    .filter(Boolean);
  if (!granted.length) return ['Scopes: not recorded for this sign-in (an API key carries the scopes it was issued with).'];
  const lines = [`Granted scopes (${granted.length}): ${granted.join(' ')}`, 'What this sign-in can do:'];
  for (const f of FAMILIES) {
    const missing = f.needs.filter((x) => !granted.includes(x));
    lines.push(missing.length ? `  no   ${f.name}: missing ${missing.join(', ')}. Fix: ${f.fix}` : `  yes  ${f.name}`);
  }
  return lines;
}

/** Scope string for a preset: the preset's scopes the server offers; admin = all offered. */
export function presetScope(meta, preset) {
  if (!Object.hasOwn(PRESETS, preset)) throw new Error(`unknown preset "${preset}". Presets: ${Object.keys(PRESETS).join(', ')}`);
  if (preset === 'admin') return requestedScope(meta);
  const offered = Array.isArray(meta?.scopes_supported) ? meta.scopes_supported : [];
  const have = PRESETS[preset].filter((x) => offered.includes(x));
  return have.length ? have.join(' ') : 'enforcer:read';
}

/** `--for work|plan|agents|admin` anywhere in argv, removed. */
export function extractPreset(argv) {
  const rest = [];
  let preset;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--for') {
      preset = argv[++i] ?? '';
      continue;
    }
    const m = /^--for=(.*)$/.exec(a);
    if (m) {
      preset = m[1];
      continue;
    }
    rest.push(a);
  }
  return { argv: rest, preset };
}

/** The scope to ask for: everything the server advertises, or read-only. */
export function requestedScope(meta) {
  const s = Array.isArray(meta?.scopes_supported) ? meta.scopes_supported.filter((x) => typeof x === 'string' && x.trim()) : [];
  return s.length ? s.join(' ') : 'enforcer:read';
}

/**
 * The scope to ask for when the caller named one: every named scope must be
 * one the server offers, or the sign-in is refused before a browser opens. An
 * unknown scope would otherwise be narrowed away silently at consent, and the
 * sign-in would "succeed" without the access it was run for.
 */
export function chooseScope(meta, wanted) {
  const names = String(wanted || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!names.length) return requestedScope(meta);
  const offered = Array.isArray(meta?.scopes_supported) ? meta.scopes_supported : [];
  const unknown = names.filter((n) => !offered.includes(n));
  if (unknown.length) {
    throw new Error(`not offered by this Enforcer: ${unknown.join(' ')}. Offered: ${offered.join(' ') || '(none listed)'}`);
  }
  return [...new Set(names)].join(' ');
}

/** `--scope "a b"` / `--scope=a,b` anywhere in argv, removed; ENFORCER_SCOPE otherwise. */
export function extractScope(argv, env = process.env) {
  const rest = [];
  let scope;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope' || a === '--scopes') {
      scope = argv[++i] ?? '';
      continue;
    }
    const m = /^--scopes?=(.*)$/.exec(a);
    if (m) {
      scope = m[1];
      continue;
    }
    rest.push(a);
  }
  return { argv: rest, scope: scope ?? (env.ENFORCER_SCOPE || undefined) };
}

export async function discover(base, fetchImpl = defaultFetch) {
  const r = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`no OAuth metadata at ${base} (HTTP ${r.status})`);
  return r.json();
}

/**
 * Whether the authorization server still knows a client this machine
 * registered earlier. A refresh_token grant with a bogus token is the one
 * unauthenticated call that tells an unknown client (401 invalid_client) from a
 * known one (400 invalid_grant), and it has no side effect. Anything else —
 * including a network failure — counts as known: the sign-in that follows
 * reports the real problem.
 */
export async function clientKnown(meta, clientId, fetchImpl = defaultFetch) {
  try {
    const r = await fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'probe', client_id: clientId }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({}));
    return j?.error !== 'invalid_client';
  } catch {
    return true;
  }
}

/** The OAuth client this machine registered before, from either record in credentials.json. */
export function savedClient(doc) {
  const c = doc?.enforcer?.oauth_client || doc?.enforcer?.oauth;
  return c?.client_id ? { client_id: c.client_id, issuer: c.issuer || null } : null;
}

export function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

/**
 * Run the loopback authorization-code flow.
 * `resource` is the RFC 8707 audience the token is for; `onUrl` receives the
 * authorization URL (printed and opened by the CLI, captured by the tests).
 */
export async function browserSignIn({
  base,
  resource,
  resources,
  scope,
  preset,
  tenantCode,
  client: previousClient,
  fetchImpl = defaultFetch,
  onUrl,
  timeoutMs = 5 * 60_000,
}) {
  // RFC 8707 lets one token name several resources. Asking for Enforcer's API
  // AND its MCP server is what makes this one sign-in serve both the governor
  // (which calls the API) and the MCP server (which serves tools): each server
  // accepts a token that names it.
  const wanted = [...new Set((resources || (resource ? [resource] : [])).filter(Boolean))];
  const meta = await discover(base, fetchImpl);
  // Ask for what the server advertises, not a fixed list. A self-registered
  // client's ceiling IS that list, so asking for less only threw scopes away:
  // this sign-in asked for enforcer:read alone for weeks after the server began
  // granting the graph's write scopes, and every graph tool refused the token.
  const scopeWasNamed = Boolean(scope);
  scope = scope ? chooseScope(meta, scope) : presetScope(meta, preset || DEFAULT_PRESET);
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));

  // Listen first: the redirect URI must be registered, and it names the port.
  let resolveCode, rejectCode;
  const codeP = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const err = u.searchParams.get('error');
    const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      ok
        ? '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in to Enforcer</title><style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;color:#16181d;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border:1px solid #dfe2e8;border-radius:10px;padding:28px;max-width:420px;width:100%}h1{font-size:20px;margin:0 0 8px}p{color:#5b6070;margin:0}</style></head><body><div class="card"><h1>Signed in</h1><p>You can close this tab and return to your terminal.</p></div></body></html>'
        : '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in did not complete</title><style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;color:#16181d;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border:1px solid #dfe2e8;border-radius:10px;padding:28px;max-width:420px;width:100%}h1{font-size:20px;margin:0 0 8px}p{color:#5b6070;margin:0}</style></head><body><div class="card"><h1>Sign-in did not complete</h1><p>Return to your terminal for details.</p></div></body></html>',
    );
    if (err)
      rejectCode(new Error(`authorization refused: ${err}${u.searchParams.get('error_description') ? ' — ' + u.searchParams.get('error_description') : ''}`));
    else if (u.searchParams.get('state') !== state) rejectCode(new Error('state mismatch — the redirect did not come from this sign-in'));
    else resolveCode(u.searchParams.get('code'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => rejectCode(new Error('timed out waiting for the browser sign-in')), timeoutMs);

  try {
    // One registered client per machine, reused across sign-ins. Consent is
    // per account AND per client on the server, so a client registered afresh
    // on every sign-in left every other workspace's account without consent
    // for it — and the workspace switch refused all of them. The port of a
    // loopback redirect may differ from the registered one (RFC 8252 §7.3),
    // which is what lets one registration serve every later sign-in.
    let client = null;
    if (
      previousClient?.client_id &&
      (!previousClient.issuer || previousClient.issuer === meta.issuer) &&
      (await clientKnown(meta, previousClient.client_id, fetchImpl))
    ) {
      client = { client_id: previousClient.client_id, reused: true };
    } else {
      const reg = await fetchImpl(meta.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Enforcer (Claude Code)',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      client = await reg.json();
      if (!reg.ok || !client.client_id) throw new Error(`client registration failed (HTTP ${reg.status})`);
    }

    const url = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      state,
    })) {
      url.searchParams.set(k, v);
    }
    for (const r of wanted) url.searchParams.append('resource', r);
    // The workspace, when this machine already knows it: the sign-in page then
    // opens on the email step for that workspace instead of asking for its code.
    // It is only a pre-fill; the server still checks membership.
    if (tenantCode) url.searchParams.set('tenant_code', tenantCode);
    onUrl?.(url.toString());

    const code = await codeP;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
    });
    const tr = await fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const tok = await tr.json();
    if (!tr.ok || !tok.access_token) throw new Error(`code redemption failed: ${tok.error || 'HTTP ' + tr.status}`);
    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || null,
      expires_at: new Date(Date.now() + (Number(tok.expires_in) || 900) * 1000).toISOString(),
      signed_in_at: new Date().toISOString(),
      ...(Number(tok.refresh_token_expires_in || tok.refresh_expires_in) > 0
        ? { refresh_expires_at: new Date(Date.now() + Number(tok.refresh_token_expires_in || tok.refresh_expires_in) * 1000).toISOString() }
        : {}),
      scope: tok.scope || scope,
      preset: scopeWasNamed ? 'custom' : preset || DEFAULT_PRESET,
      resources: wanted,
      client_id: client.client_id,
      client_reused: Boolean(client.reused),
      token_endpoint: meta.token_endpoint,
      issuer: meta.issuer,
    };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/**
 * The resources one sign-in should cover: Enforcer's API, and its MCP server as
 * the server itself publishes it (RFC 9728), so a deployment that moves the MCP
 * endpoint does not need a new plugin.
 */
export async function resourcesFor(base, fetchImpl = defaultFetch) {
  const out = [base];
  try {
    const r = await fetchImpl(`${base}/.well-known/oauth-protected-resource/mcp`, { signal: AbortSignal.timeout(10_000) });
    const m = r.ok ? await r.json() : null;
    if (m?.resource) out.push(String(m.resource));
  } catch {
    /* the API alone still signs the governor in */
  }
  return [...new Set(out)];
}

const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 90 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
};
/** The sign-in's age and when it will stop refreshing, from what the credential file records. */
export function signInLifeLine(o, nowMs) {
  if (!o?.access_token || o.api_key) return null;
  const at = o.signed_in_at ? Date.parse(o.signed_in_at) : NaN;
  const age = Number.isFinite(at)
    ? `Browser sign-in is ${ago(nowMs - at)} old (${o.signed_in_at}).`
    : 'Browser sign-in age is unknown (signed in before it was recorded).';
  const end = o.refresh_expires_at ? Date.parse(o.refresh_expires_at) : NaN;
  const stop = Number.isFinite(end)
    ? end > nowMs
      ? `It stops refreshing at ${o.refresh_expires_at} (in ${ago(end - nowMs)}).`
      : `It stopped refreshing at ${o.refresh_expires_at}: sign in again.`
    : 'The server did not state when the refresh token expires; use an agent API key for unattended runs longer than a few hours.';
  const err = o.last_refresh_error?.reason?.startsWith('signed out')
    ? ` Last refresh failed at ${o.last_refresh_error.at}: ${o.last_refresh_error.reason}. Sign in again.`
    : '';
  return `${age} ${stop}${err}`;
}

const who = (me) => me.person?.primary_email || me.person?.name || me.account_id || 'unknown account';

async function whoAmI(base) {
  const headers = await authHeaders();
  if (!headers['X-API-Key'] && !headers.Authorization) return null;
  const r = await defaultFetch(`${base}${API}/auth/me`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return (await r.json())?.data || null;
}

// A workspace code, as a tenant hands it out (e.g. ACME-1234-ABCD). Anything
// that is not a command and looks like one is read as `/enforcer:login <CODE>`.
const COMMANDS = new Set(['browser', 'api-key', 'status', 'logout', 'scopes']);
export const isWorkspaceCode = (s) => typeof s === 'string' && !COMMANDS.has(s) && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(s.trim());

/** `[cmd, arg]` from argv, with a bare workspace code meaning a browser sign-in into it. */
export function parseLoginArgs(argv) {
  const [first, arg] = argv;
  if (isWorkspaceCode(first)) return ['browser', first.trim().toUpperCase()];
  return [first || 'browser', arg];
}

export const RECONNECT_LINE = 'The tool server keeps its session until it reconnects: run /mcp, pick enforcer, reconnect (or restart Claude Code).';

/** True when a sign-in replaces an existing OAuth credential (a different token). */
export function credentialReplaced(previous, next) {
  return Boolean(previous?.access_token) && previous.access_token !== next?.access_token;
}

/**
 * Revoke the previous access token so the tool server's next call 401s and
 * Claude Code re-runs the headers helper with the new credential. Best effort:
 * 5 s timeout, never throws. Returns a line to print.
 */
export async function revokePreviousToken(previous, base, fetchImpl = defaultFetch) {
  try {
    const meta = await discover(base, fetchImpl);
    if (!meta.revocation_endpoint) return 'This server advertises no revocation endpoint; the previous access token stays valid there until it expires.';
    const body = new URLSearchParams({ token: previous.access_token, token_type_hint: 'access_token' });
    if (previous.client_id) body.set('client_id', previous.client_id);
    const r = await fetchImpl(meta.revocation_endpoint, { method: 'POST', body, signal: AbortSignal.timeout(5_000) });
    return r.ok
      ? 'Revoked the previous access token on the server.'
      : `The server refused to revoke the previous access token (HTTP ${r.status}); it expires on its own.`;
  } catch (e) {
    return `Could not revoke the previous access token (${e.message}); it expires on its own.`;
  }
}

/** The lines to print after a sign-in: nothing for a first sign-in, else the revocation result and the reconnect line. */
export async function replacementNotice(previous, next, base, fetchImpl = defaultFetch) {
  if (!credentialReplaced(previous, next)) return [];
  return [await revokePreviousToken(previous, base, fetchImpl), RECONNECT_LINE];
}

async function main(rawArgv) {
  const { argv: a1, scope } = extractScope(rawArgv);
  const { argv, preset: forPreset } = extractPreset(a1);
  const [cmd, arg] = parseLoginArgs(argv);
  // The environment base URL wins (switch deployments without editing a file), then the
  // origin the saved sign-in was made against, then the public one.
  const base = resolveConfig({ flag: flagValue(rawArgv) }).baseUrl;

  if (cmd === 'status') {
    const doc = readCredentials();
    if (!doc) {
      out('Not signed in to Enforcer. Run /enforcer:login.');
      return;
    }
    const how = process.env.ENFORCER_API_KEY ? 'the ENFORCER_API_KEY environment variable' : enforcerKey() ? 'an API key' : 'a browser sign-in';
    const me = await whoAmI(base).catch(() => ({ error: 'unreachable' }));
    const life = signInLifeLine(doc.enforcer?.oauth, Date.now());
    const scopes = scopeLines(doc.enforcer?.oauth?.scope);
    if (!me || me.error) {
      out(`Signed in with ${how}, but Enforcer did not accept it (${me?.error || 'no credential'}). Run /enforcer:login again.`);
      if (life) out(life);
      for (const l of scopes) out(l);
      return;
    }
    out(`Signed in to ${base} with ${how} as ${who(me)} (${me.role?.slug || 'unknown role'}, tenant ${me.tenant?.name || me.tenant?.id || '?'}).`);
    if (life) out(life);
    for (const l of scopes) out(l);
    out(`Shared by every Enforcer plugin on this machine: ${SHARED_FILE()}`);
    const gemini = geminiStatusLine();
    if (gemini) out(gemini);
    return;
  }

  if (cmd === 'scopes') {
    const meta = await discover(base);
    const offered = Array.isArray(meta.scopes_supported) ? meta.scopes_supported : [];
    out(`${base} offers a sign-in these scopes (--for admin asks for all of them; the default preset is work):`);
    for (const s of offered) out(`  ${s}`);
    out('Presets (a scope is only requested when offered above):');
    for (const [name, list] of Object.entries(PRESETS)) out(`  ${name}: ${list ? list.join(' ') : 'every scope offered'}`);
    out('Ask for fewer with: /enforcer:login --scope "enforcer:read policy:self"');
    return;
  }

  if (cmd === 'logout') {
    const doc = readCredentials();
    const remaining = [];
    if (doc?.enforcer) {
      const { api_key, oauth, ...rest } = doc.enforcer; // eslint-disable-line no-unused-vars
      // Revoke the refresh token server-side when the server advertises an endpoint.
      if (oauth?.refresh_token) {
        try {
          const meta = await discover(base);
          if (meta.revocation_endpoint) {
            const body = new URLSearchParams({ token: oauth.refresh_token, token_type_hint: 'refresh_token' });
            if (oauth.client_id) body.set('client_id', oauth.client_id);
            const r = await defaultFetch(meta.revocation_endpoint, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
            out(
              r.ok ? 'Revoked the refresh token on the server.' : `The server refused to revoke the refresh token (HTTP ${r.status}); it expires on its own.`,
            );
          } else out('This server advertises no revocation endpoint; the refresh token stays valid there until it expires.');
        } catch (e) {
          out(`Could not revoke the refresh token (${e.message}); it stays valid on the server until it expires.`);
        }
      }
      saveCredentials({ ...doc, enforcer: rest });
      if (api_key) out('The saved API key was removed here, but it still exists on the server until you revoke it there.');
      out('Signed out: the saved credential in ' + SHARED_FILE() + ' is gone.');
    } else out('No saved credential in ' + SHARED_FILE() + '.');
    if (process.env.ENFORCER_API_KEY && process.env.ENFORCER_API_KEY.trim()) remaining.push('the ENFORCER_API_KEY environment variable (unset it)');
    const legacy = legacyCredentialFile();
    if (legacy) remaining.push(`the legacy credential file ${legacy} (delete it)`);
    if (remaining.length) {
      out('Still authenticating:');
      for (const r of remaining) out('  - ' + r);
    } else out('No Enforcer plugin here sends a credential now.');
    return;
  }

  if (cmd === 'api-key') {
    // The key is never an argument: an argument lands in the transcript and the process list.
    const KEY = /^[a-z0-9]+_[A-Za-z0-9_-]{20,}$/;
    if (arg && KEY.test(arg.trim())) {
      out(
        'Do not pass the key as an argument: it is now in this transcript. Revoke it, make a new one, and put it in a file: /enforcer:login api-key <file> (or "-" to read stdin, or set ENFORCER_API_KEY).',
      );
      process.exitCode = 2;
      return;
    }
    let raw = process.env.ENFORCER_API_KEY || '';
    if (arg === '-') raw = readFileSync(0, 'utf8');
    else if (arg) {
      if (!existsSync(arg)) {
        out(`api-key: no such file: ${arg}`);
        process.exitCode = 2;
        return;
      }
      raw = readFileSync(arg, 'utf8');
    }
    const key = raw.trim();
    if (!KEY.test(key)) {
      out('Usage: /enforcer:login api-key <file holding the key> | api-key -  (key on stdin)  (or set ENFORCER_API_KEY)');
      process.exitCode = 2;
      return;
    }
    // Likewise a key replaces a browser sign-in: one credential, one identity.
    const doc = readCredentials() || { enforcer: {} };
    const { oauth: _oauth, ...kept } = doc.enforcer;
    saveCredentials({ ...doc, enforcer: { ...kept, base_url: base, api_key: key, saved_at: new Date().toISOString() } });
    const me = await whoAmI(base).catch(() => null);
    out(
      me && !me.error
        ? `Saved. Signed in as ${who(me)}. Every Enforcer plugin on this machine now uses this key.`
        : 'Saved, but Enforcer did not accept the key just now. Check it with /enforcer:login status.',
    );
    return;
  }

  if (cmd === 'browser') {
    const resources = process.env.ENFORCER_RESOURCES ? process.env.ENFORCER_RESOURCES.split(/\s+/).filter(Boolean) : await resourcesFor(base);
    const code = (arg || process.env.ENFORCER_TENANT_CODE || '').trim().toUpperCase() || undefined;
    if (code && !isWorkspaceCode(code)) {
      out(`"${code}" is not a workspace code. Usage: /enforcer:login [<WORKSPACE-CODE>]`);
      process.exitCode = 2;
      return;
    }
    // default = the last preset used, remembered in credentials.json
    const last = readCredentials()?.enforcer?.oauth?.preset;
    const preset = forPreset || (Object.hasOwn(PRESETS, last) ? last : DEFAULT_PRESET);
    const oauth = await browserSignIn({
      base,
      resources,
      scope,
      preset,
      tenantCode: code,
      client: savedClient(readCredentials()),
      onUrl: (url) => {
        out('Opening your browser to sign in to Enforcer. If it does not open, visit:');
        out(url);
        openBrowser(url);
      },
    });
    // Read before the save: the notice revokes the sign-in this one replaces.
    const previous = readCredentials()?.enforcer?.oauth || null;
    // The sign-in REPLACES any saved API key. authHeaders prefers a key when
    // both exist, so keeping it would leave both tools acting as the key's
    // account while this command reported the person who just signed in.
    const doc = readCredentials() || { enforcer: {} };
    const { api_key: _key, saved_at: _at, ...kept } = doc.enforcer;
    // The registered client outlives the sign-in: logout drops `oauth`, not this.
    const { client_reused, ...signIn } = oauth;
    const oauth_client =
      client_reused && kept.oauth_client?.client_id === oauth.client_id
        ? kept.oauth_client
        : { client_id: oauth.client_id, issuer: oauth.issuer, registered_at: new Date().toISOString() };
    saveCredentials({ ...doc, enforcer: { ...kept, base_url: base, oauth: signIn, oauth_client } });
    const notice = await replacementNotice(previous, oauth, base);
    const me = await whoAmI(base).catch(() => null);
    out(me && !me.error ? `Signed in as ${who(me)}.` : 'Signed in.');
    const granted = String(oauth.scope || '')
      .split(/\s+/)
      .filter(Boolean);
    out(`Preset: ${oauth.preset} (${granted.length} scopes)`);
    out(`Granted: ${oauth.scope || '(the server did not say)'}`);
    out('Every Enforcer plugin on this machine shares this sign-in.');
    out(
      client_reused
        ? 'Same registered app as your earlier sign-ins here, so this workspace is now reachable with /enforcer:workspace switch from your others, and back.'
        : 'Registered this machine as a new app with Enforcer; later sign-ins reuse it. A workspace you have not signed in to since needs one sign-in before /enforcer:workspace switch reaches it.',
    );
    out(describe(await currentWorkspace().catch(() => ({ tenant: 'unknown' }))));
    out('Wrong workspace? /enforcer:workspace list, then /enforcer:workspace switch <name>.');
    for (const line of notice) out(line);
    // Harness telemetry is on by default once signed in (each harness skips itself when absent or turned off).
    for (const line of await geminiOnLogin()) out(line);
    return;
  }

  out(
    'Usage: /enforcer:login [<WORKSPACE-CODE>] [--for work|plan|agents|admin] [--scope "<scopes>"] | api-key <file>|- | scopes | status | logout  — no argument opens a browser',
  );
  process.exitCode = 2;
}

if (isMain(import.meta.url)) {
  main(process.argv[2] === '--args-stdin' ? splitArgs(readFileSync(0, 'utf8')) : commandArgs()).catch((e) => {
    out(`Sign-in failed: ${e.message}`);
    process.exitCode = 1;
  });
}
