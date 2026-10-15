// Which project a session works for, told to the control plane at its start.
//
// The console files a session's spend under the project ("client") the session
// row carries, and that used to be written only by receipts. A session that made
// no governed decision -- or that ran before the governor was installed, or
// whose receipts had not shipped yet -- read "Attributed to no project" even
// though its telemetry was all there and this machine knew the project from the
// working directory the moment the session began. So at SessionStart the
// governor now says it: this session, this project.
//
// NOT A RECEIPT. Receipts are the hash-chained record of DECISIONS, and a
// session starting is not one. It also could not be one safely: the control
// plane refuses a verdict it does not know, and a refused receipt leaves the
// next one chained to a hash the server never stored -- a chain break on every
// install that upgraded ahead of the server. This is a label, sent outside the
// chain; the receipts that follow still carry `client` inside their hashed
// bodies, exactly as before.
//
// BEST EFFORT, ONCE. One request per SessionStart, bounded by a short timeout,
// never retried, never queued, never written to the outbox. Every failure -- signed out, shipping switched off, a
// server that predates the endpoint (404), a refusal, a timeout -- is the same
// silent no-op: the session is attributed later by its first receipt, as it
// always was. It must never be able to delay a session by more than the
// timeout, and never be able to loop.
//
// THE SAME REQUEST REGISTERS THE SESSION. With the harness and the full
// session id it is also the session's announcement (enforcer-governance
// migration 015): telemetry for a session announced at its start, under this
// harness, is held to that harness, and reaches provenance level 2 where it
// would otherwise stop at 1. A session with no project to name is still
// announced. Older servers ignore the two fields.
//
// The server side is enforcer-governance POST /api/v1/governance/ingest/attributions
// (migration 011). It takes tenant and account from the credential, holds the
// attribution until telemetry or a receipt creates the session, and lets a
// named project replace a guessed one ('?name', see policy.mjs clientFor) but
// never the reverse.
import { hookFetch } from './http.mjs';
import { authHeaders, baseUrl, credentialId } from './credentials.mjs';

export const ATTRIBUTION_PATH = '/api/v1/governance/ingest/attributions';

// Short: someone is waiting for the session to open. The managed-settings and
// identity refreshes beside it allow 3s each, but they run at most hourly and
// daily; this runs on every start, so it gets less.
export const ATTRIBUTION_TIMEOUT_MS = 1500;

// A harness name the server accepts (provenance profile names). 'unknown' is
// reserved there for rows no profile matched, so it never announces anything.
const HARNESS_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Whether a session can be announced: a real harness name, a session id, and
 * an agent id whose short form (after the first ':') starts that session id.
 * The server refuses the WHOLE request otherwise, so a registration that could
 * not stand is left off rather than costing the project with it.
 *
 * @param {{agent?: string, harness?: string, session?: string}} [s]
 * @returns {boolean}
 */
export function registers({ agent, harness, session } = {}) {
  if (!agent || !session || typeof session !== 'string' || session.length > 128) return false;
  if (!HARNESS_NAME.test(harness || '') || harness === 'unknown') return false;
  // A subagent's id is '<harness>:<session8>:<agent8>'; the session part is the second.
  const parts = agent.split(':');
  return parts.length < 2 || session.startsWith(parts[1]);
}

/**
 * Tell the control plane which project a session works for, and announce the
 * session under its harness. Never throws.
 *
 * @param {{agent?: string, client?: string, harness?: string, session?: string}} s
 *   the agent id receipts use, the project clientFor() derived ('?name' when
 *   guessed), the harness the session runs in, and its full session id.
 * @param {object} cfg  the effective config (shipOn, ingestUrl, baseUrl ...)
 * @returns {Promise<{sent: boolean, status?: number, client?: string, trust?: number, skipped?: string, detail?: string}>}
 */
export async function attributeSession(
  { agent, client, harness, session } = {},
  cfg = {},
  { fetchImpl = hookFetch, now = Date.now, timeoutMs = ATTRIBUTION_TIMEOUT_MS } = {},
) {
  // The same switch that stops receipts leaving the machine stops this: an
  // install told not to report does not report its projects either.
  if (cfg.shipOn === false) return { sent: false, skipped: 'shipping is switched off (shipOn)' };
  const named = Boolean(client) && client !== '?';
  const announce = registers({ agent, harness, session });
  if (!agent || (!named && !announce)) return { sent: false, skipped: 'no session or no project' };
  if (!credentialId() || typeof fetchImpl !== 'function') return { sent: false, skipped: 'not signed in to Enforcer' };

  try {
    // NOT under the attribution's deadline. When an OAuth access token is near
    // expiry this is the refresh_token grant, and the refresh token is single-
    // use: abandoning the call after the server rotated it, and before the new
    // pair is written back, would sign the machine out. It carries its own
    // bound (credentials.mjs), and session start already awaits it for the
    // managed-settings and identity lookups; on a fresh token it is a file read.
    const headers = await authHeaders({ fetchImpl, now });
    if (!headers['X-API-Key'] && !headers.Authorization) return { sent: false, skipped: 'not signed in to Enforcer' };
    // The same origin the shipper sends receipts to.
    const url = (cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '') + ATTRIBUTION_PATH;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, ...(named ? { client } : {}), ...(announce ? { harness, session_id: session } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return { sent: true, status: res.status };
    let data;
    try {
      data = (await res.json())?.data;
    } catch {
      /* the status is the answer */
    }
    const held = data?.client;
    const trust = data?.registration?.trust;
    return { sent: true, status: 200, ...(typeof held === 'string' && held ? { client: held } : {}), ...(Number.isInteger(trust) ? { trust } : {}) };
  } catch (e) {
    return {
      sent: false,
      detail: e?.name === 'AbortError' || e?.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : 'Enforcer could not be reached',
    };
  }
}
