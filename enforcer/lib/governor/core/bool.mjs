// One reading of a boolean setting, for config.json, the organisation floor,
// the gate, the rule resolver, status and report. Before this the gate read
// `rulesOn === false` (anything else enforced) while status read `=== true`
// (anything else printed OFF), so the two could disagree about the same file.

export const BOOLEAN_SETTINGS = Object.freeze(['budgetOn', 'rulesOn', 'policyOn', 'shadow', 'allowEnvOff', 'shipOn', 'adviseModel', 'codexTelemetry']);

const TRUE = new Set(['true', 'on', 'yes', '1']);
const FALSE = new Set(['false', 'off', 'no', '0']);

/** true / false for an accepted spelling, undefined for anything else. */
export function toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (TRUE.has(s)) return true;
    if (FALSE.has(s)) return false;
  }
  return undefined;
}

/** The ONE predicate: is this setting on? Unrecognised and absent are not on. */
export const isOn = (v) => toBool(v) === true;
/** Is this setting explicitly off? Unrecognised and absent are not off. */
export const isOff = (v) => toBool(v) === false;

const noticed = new Set();
/**
 * Coerce the boolean settings of a loaded object once. An unrecognised value is
 * dropped (so the default applies) with one stderr notice per key and value.
 * Returns a new object; other keys are untouched.
 */
export function normalizeBooleans(obj, where = 'config') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const key of BOOLEAN_SETTINGS) {
    if (!(key in out)) continue;
    const b = toBool(out[key]);
    if (b === undefined) {
      const id = `${where}:${key}:${JSON.stringify(out[key])}`;
      if (!noticed.has(id)) {
        noticed.add(id);
        try {
          process.stderr.write(
            `enforcer-governor: ${where} ${key}=${JSON.stringify(out[key])} is not a boolean (use true or false); ignored, the default applies\n`,
          );
        } catch {}
      }
      delete out[key];
    } else out[key] = b;
  }
  return out;
}
