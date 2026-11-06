// Host-side confirmation gate for a remote MCP connector.
//
// The tests drive this module with the locked tool-names manifest. It does not
// open a socket, read a live tools/list, or consult the Cursor or Grok shims.
// A deny or cancel never calls the tool. An approval calls it once, with the
// name and arguments that were approved. A missing decision calls a tool only
// when that tool is a pure read or one of the five intentional unconfirmed writes.
//
// Annotations are the three MCP hints the catalog assessment attributes to the
// server's effect classification (readOnlyHint, destructiveHint, idempotentHint).
// Anthropic `_meta["anthropic/requiresUserInteraction"]` is recorded so a test
// can show the gate ignores it. The private server repository was not readable
// from this environment, so this shape is the assessment's description, not a
// copy of tools.ts and not a captured tools/list payload.
import { readFileSync } from 'node:fs';

const pin = JSON.parse(readFileSync(new URL('../fixtures/confirmation/pin.json', import.meta.url), 'utf8'));

export const INTENTIONAL_UNCONFIRMED_WRITES = Object.freeze([...pin.unconfirmedWrites]);
export const MUST_CONFIRM = Object.freeze([...pin.mustConfirm]);
export const KNOWN_SIDE_EFFECTS = Object.freeze(pin.knownSideEffects.map((s) => Object.freeze({ ...s })));
export const ANNOTATION_SHAPE = Object.freeze([...pin.annotationShape]);

const UNCONFIRMED = new Set(INTENTIONAL_UNCONFIRMED_WRITES);
const SIDE_EFFECT = new Map(KNOWN_SIDE_EFFECTS.map((s) => [s.tool, s]));

export const REASON = Object.freeze({
  deny: 'deny',
  cancel: 'cancel',
  unconfirmed: 'unconfirmed',
  approved: 'approved',
  notApproved: 'not-the-approved-call',
  mismatch: 'advertisement-mismatch',
  noPrompt: 'no-confirmation-required',
});

/** MCP hints for a classified effect. A read is advertised as read-only and idempotent. */
export function annotationsForEffect(effect) {
  if (effect !== 'read' && effect !== 'write' && effect !== 'destructive') throw new Error(`unknown effect: ${effect}`);
  const read = effect === 'read';
  return {
    readOnlyHint: read,
    destructiveHint: effect === 'destructive',
    idempotentHint: read,
  };
}

/**
 * Anthropic-only flag. Classified non-reads carry it except the five
 * intentional unconfirmed writes. The gate below does not read this object.
 */
export function anthropicConfirmationMeta(name, effect) {
  if (effect === 'read' || UNCONFIRMED.has(name)) return undefined;
  return { 'anthropic/requiresUserInteraction': true };
}

/** One tool as a remote host would see it, plus any side effect the pin names. */
export function advertise(tool, annotations) {
  const effect = tool.effect;
  const built = annotations || annotationsForEffect(effect);
  return {
    name: tool.name,
    effect,
    annotations: built,
    _meta: anthropicConfirmationMeta(tool.name, effect),
    knownSideEffect: SIDE_EFFECT.get(tool.name) || null,
  };
}

function hinted(annotations) {
  return !!annotations && typeof annotations === 'object';
}

/**
 * Whether a host may treat the advertisement as a pure read.
 * A known side effect overrides a read-only hint: the tool still needs confirmation.
 * The five unconfirmed writes are mutations that skip the prompt; they are not reads.
 */
export function classify(ad) {
  const a = hinted(ad.annotations) ? ad.annotations : {};
  const shapeOk = ANNOTATION_SHAPE.every((k) => typeof a[k] === 'boolean');
  const advertisedPureRead = a.readOnlyHint === true && a.destructiveHint !== true && a.idempotentHint === true;
  const misAdvertisedRead = !!(ad.knownSideEffect && a.readOnlyHint === true);
  const exception = UNCONFIRMED.has(ad.name);
  const pureRead = shapeOk && advertisedPureRead && !ad.knownSideEffect && !exception;
  const requiresConfirmation = !exception && !pureRead;
  return { shapeOk, advertisedPureRead, misAdvertisedRead, exception, pureRead, requiresConfirmation };
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

function callOf(x) {
  const args = x && x.arguments && typeof x.arguments === 'object' && !Array.isArray(x.arguments) ? x.arguments : {};
  return { name: x && x.name, arguments: args };
}

function sameCall(a, b) {
  return a.name === b.name && canonical(a.arguments) === canonical(b.arguments);
}

function cloneCall(call) {
  return JSON.parse(JSON.stringify(call));
}

/**
 * Apply one decision to one intended call.
 *
 * `request` is the call the model asked for. `approved`, when set, is the
 * call the person confirmed. They must name the same tool and the same
 * arguments or nothing runs. `decision` 'approve' runs that call once.
 * 'deny' and 'cancel' run nothing. Any other decision runs a call only when
 * confirmation is not required (a pure read, or one of the five exceptions).
 *
 * `invoke` is the connector's dispatch. It is called at most once.
 */
export function applyDecision({ advertisement, request, approved, decision, invoke }) {
  const classification = classify(advertisement);
  const asked = callOf(request);
  if (decision === 'deny' || decision === 'cancel') return { dispatched: false, reason: decision, classification };
  if (advertisement.name !== asked.name) return { dispatched: false, reason: REASON.mismatch, classification };
  if (approved && !sameCall(callOf(approved), asked)) return { dispatched: false, reason: REASON.notApproved, classification };
  const absent = decision === undefined || decision === null;
  if (classification.requiresConfirmation && decision !== 'approve') return { dispatched: false, reason: REASON.unconfirmed, classification };
  if (!absent && decision !== 'approve') return { dispatched: false, reason: REASON.unconfirmed, classification };
  const call = cloneCall(approved ? callOf(approved) : asked);
  invoke(call);
  return {
    dispatched: true,
    reason: decision === 'approve' ? REASON.approved : REASON.noPrompt,
    call,
    classification,
  };
}
