// How a receipt is hashed onto the chain. One place, because four places
// computed it (the governor twice, verify, the shipper) and a fifth language
// -- the control plane's Go -- has to agree with all of them.
//
// v1, every receipt written before hash v2 and every one written while the
// control plane has not said it understands v2:
//
//   hash = hex(sha256(prev + JSON.stringify(body)))
//
// `body` is the receipt without its `hash`. JSON.stringify writes keys in the
// order the object was built, so reproducing a v1 hash needs those exact
// bytes; nothing but JavaScript, re-serialising a line it just parsed, gets
// them back reliably.
//
// v2, a receipt whose body carries "hv": 2:
//
//   hash = hex(sha256("enforcer-receipt/v2\n" + prev + "\n" + JCS(body)))
//
// JCS is RFC 8785 (jcs.mjs): the same bytes for the same value in any
// language. The prefix names the scheme, so a v2 preimage can never equal a v1
// one (a v1 preimage starts with a 64-hex hash or "genesis", never with
// "enforcer-receipt/"), and the newline after prev keeps prev and body apart.
// `hv` is inside the hashed body, so the version a line claims is itself
// covered by its hash. `prev` is the previous chained hash whatever ITS
// version: a v2 receipt chains onto a v1 one with no special case.
//
// Strings are hashed as their UTF-8 bytes in both versions.
import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.mjs';

export const GENESIS = 'genesis';
export const V2_PREFIX = 'enforcer-receipt/v2\n';
/** The hash versions this code can write and check. */
export const VERSIONS = Object.freeze([1, 2]);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The version a body says it was hashed under: 1 when it says nothing. */
export const versionOf = (body) => (body && body.hv !== undefined ? body.hv : 1);

/**
 * The hash of `body` (a receipt without `hash`) chained onto `prev`.
 * Throws on a version it does not know, and on a v2 body that is not a JSON
 * value -- either way the line cannot be checked, which callers treat as a
 * break.
 */
export function receiptHash(prev, body) {
  const hv = versionOf(body);
  if (hv === 1) return sha256(prev + JSON.stringify(body));
  if (hv === 2) return sha256(V2_PREFIX + prev + '\n' + canonicalize(body));
  throw new TypeError(`unknown receipt hash version ${JSON.stringify(hv)}`);
}

/**
 * Hash a new receipt onto `prev` under version `hv`, returning the entry as it
 * must be written and its hash. A v2 entry is normalised through JSON first,
 * so the value hashed is exactly the value the line will parse back to: the
 * receipt builders leave `undefined` fields that JSON.stringify drops.
 */
export function seal(prev, entry, hv = 1) {
  if (hv !== 2) return { entry, hash: receiptHash(prev, entry) };
  const { hv: _old, ...rest } = entry;
  const body = JSON.parse(JSON.stringify({ ...rest, hv: 2 }));
  return { entry: body, hash: receiptHash(prev, body) };
}
