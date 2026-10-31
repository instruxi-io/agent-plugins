// A person's answer to an `ask`, decided on the control plane instead of in a
// dialog on this machine (enforcer-governance READ_API.md §2k).
//
// Off unless the operator turns `serverApprovals` on. With it on, an `ask`
// receipt is shipped at once and the PreToolUse hook waits, for at most
// `serverApprovalWaitSec`, for a person to approve or deny that receipt in
// Enforcer. The answer is the server's signed record, and it is acted on only
// after this file has checked it:
//
//   1. sha256(message) == hash
//   2. the first line, the message type, is enforcer-governance/approval/v1
//   3. the signer key id line names the key the item says signed it, and that
//      key is one we trust (pinned in config.json `approvalKeys`, else the
//      server's unauthenticated GET /chain-heads/public-keys, retired keys
//      refused: a decision made seconds ago is signed by a current key)
//   4. the Ed25519 signature over message verifies under that key
//   5. the install and receipt-hash lines are the ones polled
//   6. the decision line is approved or denied (and agrees with the JSON field)
//
// The decision acted on is the one in the SIGNED message, never the JSON
// field beside it. Anything that does not pass is `invalid`, and invalid,
// denied, timeout and unavailable all block: only a verified `approved` lets
// the tool run. The plugin cannot read the tenant's ask expiry with its ingest
// key, so it stops at its own limit and treats silence as not approved.
//
// Why a bounded wait inside the hook: a hook's answer is the only moment the
// tool call can be held, and every harness here runs PreToolUse synchronously
// under a timeout (Claude Code and Codex 30 s, Cursor's shim 25 s). So the wait
// is capped at MAX_WAIT_SEC, well inside the shortest of them, and a timed-out
// ask is remembered (governor.mjs): when the agent retries the same action,
// the earlier ask's receipt is polled too, so a person who approves after the
// first wait ran out is not ignored.
//
// The network lives here; nothing else in the decision path reaches it for this.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { hookFetch } from './http.mjs';
import { authHeaders, baseUrl, isFederated } from './credentials.mjs';
import { isOff } from './bool.mjs';

export const MESSAGE_TYPE = 'enforcer-governance/approval/v1';
// api-used: reads data.items; headers X-API-Key
export const APPROVALS_PATH = '/api/v1/governance/approvals';
// api-used: reads data.keys
export const PUBLIC_KEYS_PATH = '/api/v1/governance/chain-heads/public-keys';
/** The longest a hook may wait: under every harness's PreToolUse timeout, with room to ship and answer. */
export const MAX_WAIT_SEC = 20;
export const DEFAULT_WAIT_SEC = 20;
export const POLL_MS = 2000;
// A message is fifteen fields, then the reason (which alone may hold newlines).
const FIELDS = 15;
const L = { type: 0, install: 5, receiptHash: 7, decision: 10, decidedBy: 11, decidedAt: 13, signer: 14 };

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** The wait the config asks for, clamped to (0, MAX_WAIT_SEC]. */
export function waitSec(cfg = {}) {
  const n = Number(cfg.serverApprovalWaitSec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_SEC;
  return Math.min(n, MAX_WAIT_SEC);
}

/** Split a v1 message into its fifteen fields and the reason, or null when it is not one. */
export function parseMessage(message) {
  if (typeof message !== 'string') return null;
  const fields = [];
  let at = 0;
  for (let i = 0; i < FIELDS; i++) {
    const nl = message.indexOf('\n', at);
    if (nl < 0) return null;
    const f = message.slice(at, nl);
    if (f.includes('\r')) return null;
    fields.push(f);
    at = nl + 1;
  }
  return { fields, reason: message.slice(at) };
}

/**
 * Trusted keys, { [key_id]: KeyObject }, from config.json's `approvalKeys`
 * ({ "cs1": "<base64 32-byte Ed25519 public key>" }) or from a
 * GET /chain-heads/public-keys body. Retired keys are left out; a malformed
 * entry is skipped, never trusted.
 */
export function keysFrom(source) {
  const out = {};
  const add = (id, b64) => {
    try {
      const raw = Buffer.from(String(b64), 'base64');
      if (typeof id !== 'string' || !id || raw.length !== 32) return;
      out[id] = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    } catch {}
  };
  const list = source?.data?.keys ?? source?.keys;
  if (Array.isArray(list)) {
    for (const k of list) if (k && !k.retired && (k.algorithm === undefined || k.algorithm === 'ed25519')) add(k.key_id, k.public_key);
  } else if (source && typeof source === 'object') {
    for (const [id, b64] of Object.entries(source)) add(id, b64);
  }
  return out;
}

/**
 * Check one item from GET /approvals against what was polled. Pure.
 * Returns { ok: true, decision: 'approved'|'denied', reason, decidedBy, decidedAt, hash } or { ok: false, why }.
 * @param {any} item
 * @param {any} [ctx]
 * @returns {any}
 */
export function verifyApproval(item, ctx = {}) {
  const { install, receiptHash, keys = {} } = ctx;
  const no = (why) => ({ ok: false, why });
  if (!item || typeof item !== 'object') return no('the answer is not an approval');
  const { message, hash, signature, signer_key_id: signer } = item;
  if (typeof message !== 'string' || typeof hash !== 'string' || typeof signature !== 'string' || typeof signer !== 'string')
    return no('the answer is missing its message, hash, signature or signer');
  if (sha256(message) !== hash) return no('sha256(message) does not equal its hash');
  const m = parseMessage(message);
  if (!m) return no('the message is not fifteen fields and a reason');
  if (m.fields[L.type] !== MESSAGE_TYPE) return no(`the message type is not ${MESSAGE_TYPE}`);
  if (m.fields[L.signer] !== signer) return no('the message names a different signer key than the answer');
  const key = Object.prototype.hasOwnProperty.call(keys, signer) ? keys[signer] : null;
  if (!key) return no(`signer key ${JSON.stringify(signer).slice(0, 40)} is not a trusted key`);
  const sig = Buffer.from(signature, 'base64');
  let good = false;
  try {
    good = sig.length === 64 && cryptoVerify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    good = false;
  }
  if (!good) return no('the Ed25519 signature does not verify');
  if (m.fields[L.install] !== install) return no('the message is about a different install');
  if (m.fields[L.receiptHash] !== receiptHash) return no('the message is about a different receipt');
  const decision = m.fields[L.decision];
  if (decision !== 'approved' && decision !== 'denied') return no('the message decision is neither approved nor denied');
  if (item.decision !== undefined && item.decision !== decision) return no('the answer and its signed message disagree on the decision');
  return { ok: true, decision, reason: m.reason, decidedBy: m.fields[L.decidedBy], decidedAt: m.fields[L.decidedAt], hash };
}

/**
 * Wait for a person's verified answer to one ask (or to an earlier ask of the
 * same action, `earlier`). Never throws.
 *
 * deps: { fetchImpl, now, sleep, ship, headers, keys }
 *   ship()    put the ask receipt on the server; called before each empty poll
 *             until it reports nothing pending (in-process shipAll by default)
 *   headers() the ingest credential's headers (authHeaders)
 *   keys      pinned keys, else fetched once from PUBLIC_KEYS_PATH
 *
 * Resolves to { status: 'approved'|'denied'|'invalid'|'timeout'|'unavailable',
 *   why, receiptHash, install, decidedBy?, decidedAt?, reason?, approvalHash?, waitedMs }.
 * @param {any} req  { install, receiptHash, earlier?, cfg? }
 * @param {any} [deps]
 * @returns {Promise<any>}
 */
export async function awaitApproval(req, deps = {}) {
  const { install, receiptHash, earlier = [], cfg = {} } = req;
  const fetchImpl = deps.fetchImpl || hookFetch;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || sleepMs;
  const started = now();
  const deadline = started + waitSec(cfg) * 1000;
  const left = () => deadline - now();
  const out = (status, why, extra = {}) => ({ status, why, receiptHash, install, waitedMs: now() - started, ...extra });
  // Whatever runs against the clock is cut off at the deadline: a hung request
  // must not carry the hook past its harness's timeout.
  const bounded = (p) =>
    Promise.race([
      Promise.resolve(p).catch(() => ({ error: true })),
      new Promise((r) => /** @type {any} */ (setTimeout(() => r({ error: true, late: true }), Math.max(0, left()))).unref?.()),
    ]);

  if (!receiptHash) return out('unavailable', 'the ask was not recorded on the receipt chain, so there is nothing to approve');
  if (!install) return out('unavailable', 'this machine has no install id to name the ask by');
  if (!deps.ship && isOff(cfg.shipOn)) return out('unavailable', 'receipts are not shipped (shipOn is off), so the ask never reaches Enforcer');
  if (!deps.headers && !isFederated()) return out('unavailable', 'this machine is not signed in to Enforcer, so nobody can approve the ask there');

  let base;
  try {
    base = String(cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '');
  } catch {
    return out('unavailable', 'no Enforcer origin is configured');
  }
  const headers = deps.headers || (() => authHeaders({ fetchImpl: globalThis.fetch }));
  const ship = deps.ship || (async () => (await import('./ship.mjs')).shipAll(cfg));

  let keys =
    deps.keys || (cfg.approvalKeys && typeof cfg.approvalKeys === 'object' && Object.keys(cfg.approvalKeys).length ? keysFrom(cfg.approvalKeys) : null);
  const pinned = !!keys;
  const loadKeys = async () => {
    if (pinned) return keys;
    const res = await bounded(fetchImpl(base + PUBLIC_KEYS_PATH, { method: 'GET', headers: { Accept: 'application/json' } }));
    if (!res || res.error || res.status !== 200) return null;
    try {
      return keysFrom(await res.json());
    } catch {
      return null;
    }
  };

  // The current ask first, then any earlier ask of the same action.
  const targets = [receiptHash, ...earlier.filter((h) => typeof h === 'string' && h && h !== receiptHash)];
  let shipped = false;
  let lastProblem = '';
  for (;;) {
    if (!shipped) {
      const s = await bounded(ship());
      // Caught up (nothing pending) or another shipper holds the lock and will send it.
      shipped = !!s && !s.error && !s.pending && (s.shipped !== undefined || /another shipper/.test(String(s.skipped || '')));
    }
    let h;
    try {
      h = await bounded(headers());
    } catch {
      h = null;
    }
    if (!h || h.error || (!h['X-API-Key'] && !h.Authorization))
      return out('unavailable', 'this machine is not signed in to Enforcer, so nobody can approve the ask there');

    for (const target of [...targets]) {
      if (left() <= 0) break;
      const q = `?install=${encodeURIComponent(install)}&receipt_hash=${encodeURIComponent(target)}`;
      const res = await bounded(fetchImpl(`${base}${APPROVALS_PATH}${q}`, { method: 'GET', headers: { ...h, Accept: 'application/json' } }));
      if (!res || res.error) {
        lastProblem = 'the control plane did not answer';
        continue;
      }
      if (res.status === 401 || res.status === 403)
        return out('unavailable', `the control plane refused this machine's credential for the approval poll (HTTP ${res.status})`);
      if (res.status === 400) return out('unavailable', 'the control plane refused the approval poll as malformed (HTTP 400)');
      if (res.status !== 200) {
        lastProblem = `the control plane answered HTTP ${res.status}`;
        continue;
      }
      let items;
      try {
        items = (await res.json())?.data?.items;
      } catch {
        return out('invalid', 'the approval answer was not JSON');
      }
      if (!Array.isArray(items)) return out('invalid', 'the approval answer has no items list');
      if (items.length === 0) continue;
      if (items.length > 1) return out('invalid', 'the control plane returned more than one decision for one ask');
      if (!keys || !Object.prototype.hasOwnProperty.call(keys, items[0]?.signer_key_id)) {
        // Fetched once, and again only for a signer it did not list (a rotation).
        const fresh = await loadKeys();
        if (fresh) keys = fresh;
      }
      if (!keys) return out('invalid', "the server's public keys could not be read, so the decision cannot be verified");
      const v = verifyApproval(items[0], { install, receiptHash: target, keys });
      if (!v.ok) return out('invalid', `the decision did not verify: ${v.why}`, { receiptHash: target });
      const via = { receiptHash: target, decidedBy: v.decidedBy, decidedAt: v.decidedAt, reason: v.reason, approvalHash: v.hash };
      if (v.decision === 'approved') return out('approved', 'a person approved it in Enforcer', via);
      // A denial of the CURRENT ask is final; one of an earlier ask only drops it.
      if (target === receiptHash) return out('denied', 'a person denied it in Enforcer', via);
      targets.splice(targets.indexOf(target), 1);
    }
    if (left() <= 0) break;
    await sleep(Math.min(POLL_MS, left()));
    if (left() <= 0) break;
  }
  return out('timeout', `nobody approved it in Enforcer within ${waitSec(cfg)}s${lastProblem ? ` (${lastProblem})` : ''}`);
}

/** The fingerprint an ask is remembered by, so a retry of the same action finds it. */
export function askFingerprint(event = {}, tool = '') {
  return sha256(JSON.stringify([String(event.agent || ''), String(tool), String(event.action || ''), String(event.cwd || '')]));
}

// How long, and how many, timed-out asks are remembered. The server refuses to
// record a decision after the tenant's expiry (24 h by default), so an older
// one could never be answered.
export const REMEMBER_MS = 24 * 60 * 60 * 1000;
const PER_ACTION = 3;
const TOTAL = 50;

/** Earlier unanswered asks of this action, newest first. Pure. */
export function earlierAsks(waits, fp, t = Date.now()) {
  return (Array.isArray(waits) ? waits : [])
    .filter((w) => w && w.fp === fp && t - w.at < REMEMBER_MS)
    .sort((a, b) => b.at - a.at)
    .map((w) => w.hash);
}

/** The remembered asks after an outcome. Pure: returns a new list. */
export function rememberOutcome(waits, fp, result, t = Date.now()) {
  let list = (Array.isArray(waits) ? waits : []).filter((w) => w && typeof w.hash === 'string' && t - w.at < REMEMBER_MS);
  // An ask that got its answer is done with, either way.
  if (result.status === 'approved' || result.status === 'denied') list = list.filter((w) => w.hash !== result.receiptHash);
  if (result.status === 'timeout' && result.receiptHash) {
    list.push({ fp, hash: result.receiptHash, at: t });
    const mine = list.filter((w) => w.fp === fp).sort((a, b) => b.at - a.at);
    const drop = new Set(mine.slice(PER_ACTION).map((w) => w.hash));
    list = list.filter((w) => !drop.has(w.hash));
  }
  return list.sort((a, b) => a.at - b.at).slice(-TOTAL);
}
