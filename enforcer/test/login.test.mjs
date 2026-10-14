// The browser sign-in, end to end against a fake authorization server — the
// real HTTP listener, the real redirect, the real PKCE check.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-login-'));
process.env.HOME = home;
process.env.ENFORCER_HOME = join(home, '.enforcer');
process.env.GOVERNOR_HOME = join(home, '.g');

const {
  browserSignIn,
  pkce,
  resourcesFor,
  requestedScope,
  chooseScope,
  extractScope,
  extractPreset,
  presetScope,
  PRESETS,
  parseLoginArgs,
  isWorkspaceCode,
  clientKnown,
  savedClient,
} = await import('../bin/login.mjs');
let pass = 0;
const ok = async (label, fn) => {
  await fn();
  pass++;
  console.log('  ok  ' + label);
};
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

await ok('the verifier hashes to the challenge (S256)', () => {
  const { verifier, challenge } = pkce();
  assert.equal(b64url(createHash('sha256').update(verifier).digest()), challenge);
  assert.ok(verifier.length >= 43);
});

// A fake AS that behaves like enforcer's: DCR, an authorize step that
// redirects with a code (the browser's part, performed here by a fetch), and a
// token endpoint that checks the verifier and the resource.
const issued = {};
const as = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = await new Promise((r) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => r(d));
  });
  const json = (s, o) => {
    res.writeHead(s, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const base = `http://127.0.0.1:${as.address().port}`;
  if (u.pathname === '/.well-known/oauth-authorization-server') {
    return json(200, {
      issuer: base,
      authorization_endpoint: base + '/authorize',
      token_endpoint: base + '/token',
      registration_endpoint: base + '/register',
      ...(issued.meta || {}),
    });
  }
  if (u.pathname === '/revoke') {
    issued.revoked = new URLSearchParams(body).get('token');
    return json(200, {});
  }
  if (u.pathname === '/register') {
    const b = JSON.parse(body);
    issued.redirect = b.redirect_uris[0];
    issued.registrations = (issued.registrations || 0) + 1;
    return json(201, { client_id: 'mcp_test' });
  }
  if (u.pathname === '/token') {
    const p = new URLSearchParams(body);
    issued.tokenClient = p.get('client_id');
    // The one unauthenticated call that tells a known client from an unknown
    // one: a refresh with a bogus token answers invalid_grant for a client the
    // server knows, invalid_client for one it does not (what v3 does, 2026-10-14).
    if (p.get('grant_type') === 'refresh_token')
      return p.get('client_id') === 'mcp_test' ? json(400, { error: 'invalid_grant' }) : json(401, { error: 'invalid_client' });
    const good =
      p.get('code') === 'the-code' &&
      b64url(createHash('sha256').update(p.get('code_verifier')).digest()) === issued.challenge &&
      p.get('redirect_uri') === issued.redirect;
    return good ? json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900, scope: 'enforcer:read' }) : json(400, { error: 'invalid_grant' });
  }
  json(404, {});
});
await new Promise((r) => as.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${as.address().port}`;

await ok('asks for every scope the server advertises, and read-only when it advertises none', () => {
  // The ceiling a self-registered client gets is the advertised list; asking
  // for a fixed subset silently threw the graph's write scopes away.
  assert.equal(requestedScope({ scopes_supported: ['enforcer:read', 'enforcer:graph-runs.write'] }), 'enforcer:read enforcer:graph-runs.write');
  assert.equal(requestedScope({}), 'enforcer:read');
  assert.equal(requestedScope({ scopes_supported: [] }), 'enforcer:read');
});

await ok('--scope asks for only the named scopes, each of which must be offered', () => {
  // --scope names a subset; each must be offered, or nothing opens.
  const meta = { scopes_supported: ['enforcer:read', 'policy:self', 'enforcer:graph-runs.write'] };
  assert.equal(chooseScope(meta, undefined), 'enforcer:read policy:self enforcer:graph-runs.write', 'no --scope asks for everything offered');
  assert.equal(chooseScope(meta, 'enforcer:read, enforcer:read policy:self'), 'enforcer:read policy:self', 'commas and repeats collapse');
  assert.throws(() => chooseScope(meta, 'enforcer:read enforcer:admin'), /not offered by this Enforcer: enforcer:admin/);
  assert.deepEqual(extractScope(['ACME-1234-ABCD', '--scope', 'enforcer:read policy:self'], {}), {
    argv: ['ACME-1234-ABCD'],
    scope: 'enforcer:read policy:self',
  });
  assert.deepEqual(extractScope(['--scope=enforcer:read'], {}), { argv: [], scope: 'enforcer:read' });
  assert.deepEqual(extractScope(['status'], { ENFORCER_SCOPE: 'policy:self' }), { argv: ['status'], scope: 'policy:self' });
  assert.deepEqual(extractScope([], {}), { argv: [], scope: undefined });
  assert.deepEqual(parseLoginArgs(extractScope(['--scope', 'enforcer:read']).argv), ['browser', undefined], 'a flag alone is still a browser sign-in');
});

await ok('a workspace code: `/enforcer:login CODE` is a browser sign-in into it; commands still win', () => {
  assert.deepEqual(parseLoginArgs(['acme-1234-abcd']), ['browser', 'ACME-1234-ABCD']);
  assert.deepEqual(parseLoginArgs([]), ['browser', undefined]);
  assert.deepEqual(parseLoginArgs(['browser', 'ACME-1234-ABCD']), ['browser', 'ACME-1234-ABCD']);
  assert.deepEqual(parseLoginArgs(['api-key', 'env3_x']), ['api-key', 'env3_x'], 'api-key has a dash but is a command');
  assert.deepEqual(parseLoginArgs(['status']), ['status', undefined]);
  for (const bad of ['ACME', 'a b-c', '-ACME', 'ACME-', 'x;rm-rf', 'logout']) assert.equal(isWorkspaceCode(bad), false, bad);
});

await ok('a workspace code rides on the authorize URL; without one it is absent', async () => {
  const seen = [];
  for (const tenantCode of ['ACME-1234-ABCD', undefined]) {
    await browserSignIn({
      base,
      resources: ['https://api.example.test'],
      tenantCode,
      timeoutMs: 5000,
      onUrl: async (url) => {
        const a = new URL(url);
        seen.push(a.searchParams.get('tenant_code'));
        issued.challenge = a.searchParams.get('code_challenge');
        const cb = new URL(a.searchParams.get('redirect_uri'));
        cb.searchParams.set('code', 'the-code');
        cb.searchParams.set('state', a.searchParams.get('state'));
        await fetch(cb);
      },
    });
  }
  assert.deepEqual(seen, ['ACME-1234-ABCD', null]);
});

await ok('signs in: register, authorize, loopback redirect, redeem with the verifier', async () => {
  const want = ['https://api.example.test', 'https://api.example.test/mcp'];
  const tok = await browserSignIn({
    base,
    resources: want,
    timeoutMs: 5000,
    onUrl: async (url) => {
      const a = new URL(url);
      assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
      assert.deepEqual(a.searchParams.getAll('resource'), want, 'one sign-in names the API and the MCP server (RFC 8707)');
      issued.challenge = a.searchParams.get('code_challenge');
      // The "browser": the AS would redirect here after the user signs in.
      const cb = new URL(a.searchParams.get('redirect_uri'));
      cb.searchParams.set('code', 'the-code');
      cb.searchParams.set('state', a.searchParams.get('state'));
      const r = await fetch(cb);
      assert.equal(r.status, 200);
    },
  });
  assert.deepEqual([tok.access_token, tok.refresh_token, tok.client_id], ['at', 'rt', 'mcp_test']);
  assert.deepEqual(tok.resources, want);
  assert.ok(Date.parse(tok.expires_at) > Date.now());
});

const signInWith = (client) =>
  browserSignIn({
    base,
    resources: ['https://api.example.test'],
    client,
    timeoutMs: 5000,
    onUrl: async (url) => {
      const a = new URL(url);
      issued.challenge = a.searchParams.get('code_challenge');
      issued.authorizeClient = a.searchParams.get('client_id');
      // The fake accepts the loopback port of this sign-in against the one
      // registered earlier, as RFC 8252 §7.3 has the real server do.
      issued.redirect = a.searchParams.get('redirect_uri');
      const cb = new URL(a.searchParams.get('redirect_uri'));
      cb.searchParams.set('code', 'the-code');
      cb.searchParams.set('state', a.searchParams.get('state'));
      await fetch(cb);
    },
  });

await ok('a client this machine registered before is reused: no new registration, same client_id end to end', async () => {
  // Consent is per account AND per client on the server. A client registered
  // afresh on every sign-in left every other workspace without consent for it,
  // so /enforcer:workspace switch refused all of them.
  const before = issued.registrations;
  const tok = await signInWith({ client_id: 'mcp_test', issuer: base });
  assert.equal(issued.registrations, before, 'no registration call');
  assert.equal(issued.authorizeClient, 'mcp_test', 'the authorize URL names the saved client');
  assert.equal(issued.tokenClient, 'mcp_test', 'the code is redeemed as that client');
  assert.equal(tok.client_id, 'mcp_test');
  assert.equal(tok.client_reused, true);
  // The redirect port is whatever was free this time: RFC 8252 §7.3 lets the
  // server accept it against the registered loopback URI.
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(issued.redirect));
});

await ok('a saved client the server no longer knows, or one from another server, is registered again', async () => {
  let before = issued.registrations;
  let tok = await signInWith({ client_id: 'mcp_gone', issuer: base });
  assert.equal(issued.registrations, before + 1, 'unknown client: registered afresh');
  assert.equal(tok.client_id, 'mcp_test');
  assert.equal(tok.client_reused, false);
  before = issued.registrations;
  tok = await signInWith({ client_id: 'mcp_test', issuer: 'https://other.example.test' });
  assert.equal(issued.registrations, before + 1, 'another issuer: registered afresh');
  assert.equal(tok.client_reused, false);
  before = issued.registrations;
  tok = await signInWith(null);
  assert.equal(issued.registrations, before + 1, 'nothing saved: registered');
  assert.equal(tok.client_reused, false);
});

await ok('clientKnown and savedClient', async () => {
  const meta = { token_endpoint: base + '/token' };
  assert.equal(await clientKnown(meta, 'mcp_test'), true);
  assert.equal(await clientKnown(meta, 'mcp_gone'), false);
  assert.equal(
    await clientKnown({ token_endpoint: 'http://127.0.0.1:1/token' }, 'mcp_test'),
    true,
    'unreachable: assume known, the sign-in reports the real problem',
  );
  assert.equal(savedClient(null), null);
  assert.equal(savedClient({ enforcer: {} }), null);
  assert.deepEqual(
    savedClient({ enforcer: { oauth: { client_id: 'a', issuer: 'i' } } }),
    { client_id: 'a', issuer: 'i' },
    'an older credential file: the sign-in itself names the client',
  );
  assert.deepEqual(
    savedClient({ enforcer: { oauth_client: { client_id: 'b', issuer: 'j' }, oauth: { client_id: 'a', issuer: 'i' } } }),
    { client_id: 'b', issuer: 'j' },
    'the kept record wins',
  );
  assert.deepEqual(savedClient({ enforcer: { oauth_client: { client_id: 'b' } } }), { client_id: 'b', issuer: null });
});

await ok('a redirect with the wrong state is refused', async () => {
  await assert.rejects(
    browserSignIn({
      base,
      timeoutMs: 5000,
      onUrl: async (url) => {
        const cb = new URL(new URL(url).searchParams.get('redirect_uri'));
        cb.searchParams.set('code', 'the-code');
        cb.searchParams.set('state', 'forged');
        await fetch(cb);
      },
    }),
    /state mismatch/,
  );
});

await ok('a refusal at the authorization server is reported, not hung on', async () => {
  await assert.rejects(
    browserSignIn({
      base,
      timeoutMs: 5000,
      onUrl: async (url) => {
        const cb = new URL(new URL(url).searchParams.get('redirect_uri'));
        cb.searchParams.set('error', 'access_denied');
        cb.searchParams.set('state', new URL(url).searchParams.get('state'));
        await fetch(cb);
      },
    }),
    /access_denied/,
  );
});

await ok('resources come from what the MCP server publishes about itself', async () => {
  const fake = async (url) =>
    url.endsWith('/.well-known/oauth-protected-resource/mcp')
      ? { ok: true, json: async () => ({ resource: 'https://api.example.test/mcp' }) }
      : { ok: false, json: async () => ({}) };
  assert.deepEqual(await resourcesFor('https://api.example.test', fake), ['https://api.example.test', 'https://api.example.test/mcp']);
  const down = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(await resourcesFor('https://api.example.test', down), ['https://api.example.test'], 'no MCP metadata still signs the governor in');
});

const OFFERED = [
  'enforcer:read',
  'policy:self',
  'enforcer:graph-runs.write',
  'enforcer:graph-observations.write',
  'enforcer:graph-nodes.write',
  'enforcer:graph-edges.write',
  'enforcer:files-files.write',
  'enforcer:graph-graphs.write',
  'enforcer:graph-graph-templates.write',
  'enforcer:graph-epochs.write',
  'enforcer:agents-credentials.destructive',
];

await ok('presets: work, plan, admin pick exactly their scopes; --for parses; unknown is refused', () => {
  const meta = { scopes_supported: OFFERED };
  const w = presetScope(meta, 'work').split(' ');
  assert.equal(w.length, 7);
  assert.ok(!w.includes('enforcer:agents-credentials.destructive'));
  const p = presetScope(meta, 'plan').split(' ');
  assert.deepEqual(p.slice(0, 7), w);
  assert.deepEqual(p.slice(7), ['enforcer:graph-graphs.write', 'enforcer:graph-graph-templates.write', 'enforcer:graph-epochs.write']);
  assert.equal(presetScope(meta, 'admin'), OFFERED.join(' '));
  assert.throws(() => presetScope(meta, 'root'), /unknown preset/);
  assert.deepEqual(extractPreset(['--for', 'plan', 'X-1']), { argv: ['X-1'], preset: 'plan' });
  assert.deepEqual(extractPreset(['--for=work']), { argv: [], preset: 'work' });
  assert.deepEqual(Object.keys(PRESETS), ['work', 'plan', 'agents', 'admin']);
});

await ok('presets request enforcer:workspace.write for work, plan and admin when the server offers it', () => {
  const meta = { scopes_supported: [...OFFERED, 'enforcer:workspace.write'] };
  for (const preset of ['work', 'plan', 'admin']) assert.ok(presetScope(meta, preset).split(' ').includes('enforcer:workspace.write'), preset);
  assert.ok(!presetScope({ scopes_supported: OFFERED }, 'work').includes('workspace.write'));
});

await ok('the authorize URL carries the preset scope, and the token records the preset', async () => {
  const meta = { scopes_supported: OFFERED };
  const scopes = {};
  for (const preset of ['work', 'plan', 'admin', undefined]) {
    issued.meta = meta;
    const tok = await browserSignIn({
      base,
      preset,
      timeoutMs: 5000,
      onUrl: async (url) => {
        const a = new URL(url);
        scopes[preset ?? 'default'] = a.searchParams.get('scope');
        issued.challenge = a.searchParams.get('code_challenge');
        const cb = new URL(a.searchParams.get('redirect_uri'));
        cb.searchParams.set('code', 'the-code');
        cb.searchParams.set('state', a.searchParams.get('state'));
        await fetch(cb);
      },
    });
    assert.equal(tok.preset, preset || 'work');
  }
  assert.equal(scopes.work.split(' ').length, 7);
  assert.equal(scopes.plan.split(' ').length, 10);
  assert.equal(scopes.admin.split(' ').length, OFFERED.length);
  assert.equal(scopes.default, scopes.work, 'no preset means work');
});

await ok('a work-preset token covers the graph work loop (scope-aware tool list fixture)', () => {
  // graph_next_work / graph_heartbeat / graph_report / graph_remember need these scopes; planning tools do not belong to work.
  const TOOLS = {
    graph_next_work: 'enforcer:graph-runs.write',
    graph_heartbeat: 'enforcer:graph-runs.write',
    graph_report: 'enforcer:graph-runs.write',
    graph_remember: 'enforcer:graph-observations.write',
    graph_plan_status: 'enforcer:read',
    graph_createGraph: 'enforcer:graph-graphs.write',
  };
  const have = new Set(presetScope({ scopes_supported: OFFERED }, 'work').split(' '));
  const visible = Object.keys(TOOLS).filter((t) => have.has(TOOLS[t]));
  for (const t of ['graph_next_work', 'graph_heartbeat', 'graph_report', 'graph_remember', 'graph_plan_status']) assert.ok(visible.includes(t), t);
  assert.ok(!visible.includes('graph_createGraph'));
});

await ok('the last preset is remembered and shown by `workspace current`', async () => {
  const { saveCredentials } = await import('../src/credentials.mjs');
  const { describe } = await import('../bin/enforcer-workspace.mjs');
  assert.match(describe({ tenant: 'A', tenant_id: 't', preset: 'plan', scopes: 10 }), /preset plan \(10 scopes\)/);
  saveCredentials({ enforcer: { base_url: base, oauth: { access_token: 'at', preset: 'plan', scope: 'a b' } } });
});

await ok('one credential at a time: a sign-in replaces a key and a key replaces a sign-in', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { saveCredentials, readCredentials } = await import('../src/credentials.mjs');
  saveCredentials({ enforcer: { api_key: 'env3_' + 'k'.repeat(43), base_url: base } });
  // The browser path, driven through the CLI entry point's save logic by importing it is not
  // possible without a browser, so exercise the same rule on the api-key path in reverse.
  saveCredentials({ enforcer: { base_url: base, oauth: { access_token: 'at', client_id: 'c' } } });
  const keyFile = join(tmpdir(), 'k-' + process.pid);
  writeFileSync(keyFile, 'env3_' + 'z'.repeat(43) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('../bin/login.mjs', import.meta.url)), 'api-key', keyFile], {
    env: { ...process.env, ENFORCER_API_KEY: '' },
    encoding: 'utf8',
  });
  rmSync(keyFile);
  const refused = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/login.mjs', import.meta.url)), 'api-key', 'env3_' + 'y'.repeat(43)], {
    env: { ...process.env, ENFORCER_API_KEY: '' },
    encoding: 'utf8',
  });
  assert.equal(refused.status, 2, 'a key passed as an argument is refused');
  assert.match(refused.stdout, /Do not pass the key as an argument/);
  const e = readCredentials().enforcer;
  assert.equal(e.api_key, 'env3_' + 'z'.repeat(43));
  assert.equal(e.oauth, undefined, 'saving a key must drop the browser sign-in, or the two identities disagree');
});

await ok('logout calls revoke', async () => {
  const { execFile } = await import('node:child_process');
  const run = (args, env) =>
    new Promise((res) => execFile(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8' }, (e, stdout) => res({ stdout })));
  const { saveCredentials, readCredentials } = await import('../src/credentials.mjs');
  issued.meta = { revocation_endpoint: base + '/revoke' };
  saveCredentials({ enforcer: { base_url: base, oauth: { access_token: 'at', refresh_token: 'rt-1', client_id: 'c' } } });
  const r = await run([fileURLToPath(new URL('../bin/login.mjs', import.meta.url)), 'logout'], { ENFORCER_API_KEY: 'env3_' + 'q'.repeat(43) });
  assert.equal(issued.revoked, 'rt-1');
  assert.equal(readCredentials()?.enforcer?.oauth, undefined);
  assert.match(r.stdout, /Revoked the refresh token/);
  assert.match(r.stdout, /ENFORCER_API_KEY/, 'names the env credential that still authenticates');
  delete issued.meta;
});

await ok('ENFORCER_BASE_URL overrides saved base_url', async () => {
  const { execFile } = await import('node:child_process');
  const run = (args, env) =>
    new Promise((res) => execFile(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8' }, (e, stdout) => res({ stdout })));
  const { saveCredentials } = await import('../src/credentials.mjs');
  saveCredentials({ enforcer: { base_url: 'http://127.0.0.1:1', oauth: { access_token: 'at' } } });
  const r = await run([fileURLToPath(new URL('../bin/login.mjs', import.meta.url)), 'scopes'], { ENFORCER_BASE_URL: base });
  assert.match(r.stdout, new RegExp(base.replace(/\./g, '\\.')));
});

await ok('a refused refresh is retried once', async () => {
  const { saveCredentials, readCredentials, authHeaders } = await import('../src/credentials.mjs');
  saveCredentials({
    enforcer: {
      base_url: base,
      oauth: {
        access_token: 'old',
        refresh_token: 'rt-old',
        client_id: 'c',
        token_endpoint: base + '/token',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    },
  });
  process.env.ENFORCER_BASE_URL = base;
  delete process.env.ENFORCER_API_KEY;
  let calls = 0;
  const fake = async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      : new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 }), { status: 200 });
  };
  const h = await authHeaders({ fetchImpl: fake, backoffMs: 1 });
  assert.equal(calls, 2);
  assert.equal(h.Authorization, 'Bearer new');
  assert.equal(readCredentials().enforcer.oauth.refresh_token, 'rt-new');
  // a refusal that persists signs out, after exactly one retry
  saveCredentials({
    enforcer: {
      base_url: base,
      oauth: {
        access_token: 'old',
        refresh_token: 'rt-old',
        client_id: 'c',
        token_endpoint: base + '/token',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    },
  });
  calls = 0;
  const h2 = await authHeaders({
    fetchImpl: async () => {
      calls++;
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    },
    backoffMs: 1,
  });
  assert.equal(calls, 2);
  assert.deepEqual(h2, {});
  const { signInProblem } = await import('../src/credentials.mjs');
  assert.match(signInProblem(), /run \/enforcer:login/);
});

await ok('a dead refresh lock is reclaimed', async () => {
  const { acquireRefreshLock, refreshLockPath } = await import('../src/credentials.mjs');
  const { mkdirSync, writeFileSync: wf } = await import('node:fs');
  mkdirSync(refreshLockPath(), { recursive: true });
  wf(join(refreshLockPath(), 'pid'), '2147483646'); // fresh mtime, but no such process
  const t0 = Date.now();
  const release = await acquireRefreshLock(500);
  assert.ok(release, 'lock taken from a dead pid');
  assert.ok(Date.now() - t0 < 400, 'without waiting out the stale window');
  release();
});

await ok('status names the sign-in age and when it will stop refreshing', async () => {
  const { signInLifeLine } = await import('../bin/login.mjs');
  const now = Date.parse('2026-10-08T00:00:00Z');
  const line = signInLifeLine({ access_token: 'a', signed_in_at: '2026-10-07T18:00:00Z', refresh_expires_at: '2026-10-08T06:00:00Z' }, now);
  assert.match(line, /6 h old/);
  assert.match(line, /stops refreshing at 2026-10-08T06:00:00Z \(in 6 h\)/);
  assert.match(signInLifeLine({ access_token: 'a', signed_in_at: '2026-10-07T18:00:00Z' }, now), /did not state when the refresh token expires/);
});

as.close();
console.log(`\n  ${pass} passed`);
