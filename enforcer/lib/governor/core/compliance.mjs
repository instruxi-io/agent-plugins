// The compliance fields a receipt can carry (enforcer-governance migration 049).
//
// Six optional strings, inside the hashed body, so the edge's own hash covers
// them. What an audit of an automated decision asks beyond what was decided:
// how sensitive the data was, what the action was for, the basis it was done
// under, which ruleset decided it and at which version, and which retention
// schedule the record falls under.
//
// WHERE EACH VALUE COMES FROM, and why some are often absent:
//   data_classification, purpose, legal_basis, retention_class
//     the operator's own config (`/enforcer:governor set purpose ...`). The
//     governor cannot know any of these about an action by itself, so it never
//     guesses: unset means the key is left off the receipt.
//   policy_id, policy_version
//     the LOCAL ruleset whose rule decided (rulesetOf below): the built-in
//     capability rules, the operator's config.rules, or the graph-worker
//     rules, with a content hash of exactly the rules in force. A verdict the
//     tenant's own policy decided carries neither: /authz/check does not say
//     which tenant policy or version answered, and naming the local ruleset
//     there would misattribute the decision. Spend decisions carry neither:
//     no rule decided them.
//
// THE EDGE REFUSES A BAD VALUE, so a bad value never leaves here: a value that
// is not a non-empty string, or is over its bound in UTF-8 bytes, is dropped
// from the receipt rather than sent. A dropped field is a gap in one record; a
// sent one would get the whole receipt refused.

import { createHash } from 'node:crypto';

/** Each body key and its bound in bytes, as governance's boundFields has it. */
export const BOUNDS = Object.freeze({
  data_classification: 64,
  purpose: 512,
  legal_basis: 256,
  policy_id: 256,
  policy_version: 256,
  retention_class: 64,
});

/** The settings the operator sets, and the receipt key each one fills. */
export const SETTING_KEYS = Object.freeze({
  dataClassification: 'data_classification',
  purpose: 'purpose',
  legalBasis: 'legal_basis',
  retentionClass: 'retention_class',
});

/** The value as the edge will accept it, or undefined to leave the key off. */
export function fit(key, value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v) return undefined;
  const bound = BOUNDS[key];
  if (bound === undefined || Buffer.byteLength(v, 'utf8') > bound) return undefined;
  return v;
}

/** The operator-set fields, from a config. Only the keys that are set and fit. */
export function fromConfig(cfg = {}) {
  const out = {};
  for (const [setting, key] of Object.entries(SETTING_KEYS)) {
    const v = fit(key, cfg?.[setting]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// A RegExp has no JSON form ({}), so two different patterns would hash alike.
const replacer = (_k, v) => (v instanceof RegExp ? v.toString() : v);

const cache = new WeakMap();
/**
 * Name a ruleset and version it by what it says. The version is the sha256 of
 * the rules as data, so it changes exactly when a rule does -- an upgrade that
 * leaves the rules alone keeps the version, and an operator's edited
 * config.rules gets a new one. Memoised per rules object, so the built-in and
 * worker rules are hashed once per process; config.rules is resolved afresh
 * per decision and costs one small hash when one of its rules matches.
 *
 * @param {string} id     what the rules belong to: governor.default_rules ...
 * @param {object} rules  the rules in force, as data
 * @returns {{id: string, version: string}}
 */
export function rulesetOf(id, rules) {
  const key = rules && typeof rules === 'object' ? rules : null;
  const hit = key && cache.get(key);
  if (hit && hit.id === id) return hit;
  let version = '';
  try {
    version =
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify(rules, replacer) ?? '')
        .digest('hex');
  } catch {
    /* rules that cannot be serialised get no version rather than a wrong one */
  }
  const out = Object.freeze({ id, version });
  if (key) cache.set(key, out);
  return out;
}

export const DEFAULT_RULESET = 'governor.default_rules';
export const CONFIG_RULESET = 'governor.config_rules';
export const WORKER_RULESET = 'governor.worker_rules';
