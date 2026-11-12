#!/usr/bin/env node
// Sign this machine in to Enforcer — once, for the governor AND the MCP server.
//
//   login.mjs              browser sign-in (OAuth 2.1, PKCE, loopback redirect)
//   login.mjs api-key KEY  use an existing Enforcer API key instead
//   login.mjs status       who is signed in, and how
//   login.mjs logout       forget the credential on this machine
//
// The browser flow is the one Claude Code itself uses for a remote MCP server,
// done here so the result lands in ~/.enforcer/credentials.json where both
// tools read it: register a public client (RFC 7591), open the authorization
// URL, catch the redirect on 127.0.0.1, redeem the code with the PKCE verifier.
// The refresh token is kept, so the sign-in outlives the one-hour access
// token (credentials.mjs rotates it).
import { defaultFetch } from '../../api/client.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readCredentials, saveCredentials, enforcerKey, SHARED_FILE, authHeaders, withCredentialLock } from '../src/credentials.mjs';
import { loadConfig } from '../src/store.mjs';
import { resolveConfig, flagValue } from '../../../src/config.mjs';

const API = '/api/v1/enforcer';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const out = (s) => process.stdout.write(s + '\n');

/** The scope to ask for: everything the server advertises, or read-only. */
export function requestedScope(meta) {
  const s = Array.isArray(meta?.scopes_supported) ? meta.scopes_supported.filter((x) => typeof x === 'string' && x.trim()) : [];
  return s.length ? s.join(' ') : 'enforcer:read';
}

export async function discover(base, fetchImpl = defaultFetch) {
  const r = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`no OAuth metadata at ${base} (HTTP ${r.status})`);
  return r.json();
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
export async function browserSignIn(
  /** @type {any} */ { base, resource, resources, scope, tenantCode, fetchImpl = defaultFetch, onUrl, timeoutMs = 5 * 60_000 },
) {
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
  scope = scope || requestedScope(meta);
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
    const reg = await fetchImpl(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Enforcer Governor (Claude Code)',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const client = await reg.json();
    if (!reg.ok || !client.client_id) throw new Error(`client registration failed (HTTP ${reg.status})`);

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
      scope: tok.scope || scope,
      resources: wanted,
      client_id: client.client_id,
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

const who = (me) => me.person?.primary_email || me.person?.name || me.account_id || 'unknown account';

async function whoAmI(base) {
  const headers = await authHeaders();
  if (!headers['X-API-Key'] && !headers.Authorization) return null;
  const r = await defaultFetch(`${base}${API}/auth/me`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return (await r.json())?.data || null;
}

// A workspace code, as a tenant hands it out (e.g. ACME-1234-ABCD). Anything
// that is not a command and looks like one is read as `login <CODE>`.
const COMMANDS = new Set(['browser', 'api-key', 'status', 'logout']);
export const isWorkspaceCode = (s) => typeof s === 'string' && !COMMANDS.has(s) && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(s.trim());

/** `[cmd, arg]` from argv, with a bare workspace code meaning a browser sign-in into it. */
export function parseLoginArgs(argv) {
  const [first, arg] = argv;
  if (isWorkspaceCode(first)) return ['browser', first.trim().toUpperCase()];
  return [first || 'browser', arg];
}

async function main(argv) {
  const [cmd, arg] = parseLoginArgs(argv);
  // The same origin the governor asks for policy and ships receipts to. A
  // saved sign-in pins the origin it was made against; otherwise the
  // environment, then the `centralUrl` setting -- which /config told the user
  // to change for a self-hosted workspace and which this command used to
  // ignore, sending them to the default origin anyway.
  const rc = resolveConfig({ flag: flagValue(argv) });
  const base = rc.source === 'default' && loadConfig().centralUrl ? loadConfig().centralUrl.replace(/\/+$/, '') : rc.baseUrl;

  if (cmd === 'status') {
    const doc = readCredentials();
    if (!doc) {
      out('Not signed in to Enforcer. Run /enforcer-governor:login.');
      return;
    }
    const how = process.env.ENFORCER_API_KEY ? 'the ENFORCER_API_KEY environment variable' : enforcerKey() ? 'an API key' : 'a browser sign-in';
    const me = await whoAmI(base).catch(() => ({ error: 'unreachable' }));
    if (!me || me.error) {
      out(`Signed in with ${how}, but Enforcer did not accept it (${me?.error || 'no credential'}). Run /enforcer-governor:login again.`);
      return;
    }
    out(`Signed in to ${base} with ${how} as ${who(me)} (${me.role?.slug || 'unknown role'}, tenant ${me.tenant?.name || me.tenant?.id || '?'}).`);
    out(`Shared by the governor and the Enforcer MCP server: ${SHARED_FILE()}`);
    return;
  }

  if (cmd === 'logout') {
    const doc = readCredentials();
    if (!doc) {
      out('Already signed out.');
      return;
    }
    const { api_key, oauth, ...rest } = doc.enforcer; // eslint-disable-line no-unused-vars
    await withCredentialLock(() => saveCredentials({ ...doc, enforcer: rest }));
    out('Signed out on this machine. The governor and the Enforcer MCP server no longer send a credential.');
    out('An API key still exists on the server until you revoke it there.');
    return;
  }

  if (cmd === 'api-key') {
    const key = (arg || process.env.ENFORCER_API_KEY || '').trim();
    if (!/^[a-z0-9]+_[A-Za-z0-9_-]{20,}$/.test(key)) {
      out('Usage: /enforcer-governor:login api-key <your API key>  (or set ENFORCER_API_KEY)');
      process.exitCode = 2;
      return;
    }
    // Likewise a key replaces a browser sign-in: one credential, one identity.
    const doc = readCredentials() || { enforcer: {} };
    const { oauth: _oauth, ...kept } = doc.enforcer;
    await withCredentialLock(() => saveCredentials({ ...doc, enforcer: { ...kept, base_url: base, api_key: key, saved_at: new Date().toISOString() } }));
    const me = await whoAmI(base).catch(() => null);
    out(
      me && !me.error
        ? `Saved. Signed in as ${who(me)}. The governor and the Enforcer MCP server now both use this key.`
        : 'Saved, but Enforcer did not accept the key just now. Check it with /enforcer-governor:login status.',
    );
    return;
  }

  if (cmd === 'browser') {
    const resources = process.env.ENFORCER_RESOURCES ? process.env.ENFORCER_RESOURCES.split(/\s+/).filter(Boolean) : await resourcesFor(base);
    const code = (arg || process.env.ENFORCER_TENANT_CODE || '').trim().toUpperCase() || undefined;
    if (code && !isWorkspaceCode(code)) {
      out(`"${code}" is not a workspace code. Usage: /enforcer-governor:login [<WORKSPACE-CODE>]`);
      process.exitCode = 2;
      return;
    }
    const oauth = await browserSignIn({
      base,
      resources,
      tenantCode: code,
      onUrl: (url) => {
        out('Opening your browser to sign in to Enforcer. If it does not open, visit:');
        out(url);
        openBrowser(url);
      },
    });
    // The sign-in REPLACES any saved API key. authHeaders prefers a key when
    // both exist, so keeping it would leave both tools acting as the key's
    // account while this command reported the person who just signed in.
    const doc = readCredentials() || { enforcer: {} };
    const { api_key: _key, saved_at: _at, ...kept } = doc.enforcer;
    await withCredentialLock(() => saveCredentials({ ...doc, enforcer: { ...kept, base_url: base, oauth } }));
    const me = await whoAmI(base).catch(() => null);
    out(me && !me.error ? `Signed in as ${who(me)}.` : 'Signed in.');
    out('The governor and the Enforcer MCP server share this sign-in.');
    return;
  }

  out('Usage: /enforcer-governor:login [<WORKSPACE-CODE> | api-key <key> | status | logout]  — no argument opens a browser');
  process.exitCode = 2;
}

const isMain = (u) => {
  try {
    return realpathSync(fileURLToPath(u)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    out(`Sign-in failed: ${e.message}`);
    process.exitCode = 1;
  });
}
