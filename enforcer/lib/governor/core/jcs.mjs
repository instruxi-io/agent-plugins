// RFC 8785, the JSON Canonicalization Scheme (JCS):
// https://www.rfc-editor.org/rfc/rfc8785
//
// One byte string per JSON value, whatever order its keys were built in and
// whatever language built it. That is what a receipt hash needs to be
// recomputable outside JavaScript: JSON.stringify writes keys in insertion
// order, which Go, Python or a SQL function cannot reproduce from the value.
//
// The RFC defines JCS in terms of ECMAScript's own JSON serialisation, so in
// JavaScript it is short:
//   - literals as JSON writes them (null, true, false);
//   - numbers as Number.prototype.toString (RFC 8785 section 3.2.2.3), which
//     is String(n); NaN and the infinities are not JSON and are refused;
//   - strings as JSON.stringify writes them (section 3.2.2.2); a lone
//     surrogate is not valid I-JSON (RFC 7493) and is refused;
//   - object members sorted by their keys as arrays of UTF-16 code units
//     (section 3.2.3), which is exactly what Array.prototype.sort compares;
//   - no whitespace anywhere.
//
// It canonicalises a JSON VALUE: plain objects, arrays, strings, finite
// numbers, booleans and null. Anything JSON.stringify would silently drop or
// rewrite (undefined, a function, a Date, a BigInt) is refused instead, so a
// caller that hashes an in-memory object learns at once that the file will
// not hold what was hashed. Callers holding such an object normalise it first
// with JSON.parse(JSON.stringify(x)).
//
// Duplicate keys cannot be detected here: JSON.parse has already kept the last
// one. The Go side, which canonicalises TEXT, refuses them.
//
// Mirrored in enforcer-governance internal/jcs; both run the same vectors
// (lib/governor/test/fixtures/jcs-vectors.json here, internal/jcs/testdata
// there).

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function str(s) {
  if (LONE_SURROGATE.test(s)) throw new TypeError('jcs: string contains a lone surrogate');
  return JSON.stringify(s);
}

/**
 * The RFC 8785 canonical form of a JSON value, as a string. Hash its UTF-8
 * bytes. Throws TypeError on anything that is not a JSON value.
 */
export function canonicalize(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('jcs: NaN and Infinity are not JSON numbers');
      return String(v); // -0 prints as "0", as the RFC requires
    case 'string':
      return str(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('jcs: only plain objects are JSON objects');
      const keys = Object.keys(v).sort(); // UTF-16 code unit order
      return '{' + keys.map((k) => str(k) + ':' + canonicalize(v[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`jcs: a ${typeof v} is not a JSON value`);
  }
}
