/**
 * Text repair for values bound to PostgreSQL.
 *
 * `jsonb` refuses a lone UTF-16 surrogate (`\ud83d`, e.g. an emoji cut in half by
 * `.slice()`) and both `jsonb` and `text` refuse NUL. Every file store these
 * records came from tolerated both, so a write that used to succeed started
 * throwing after the move to PostgreSQL. The repair is the same lossy one a
 * UTF-8 file write always applied: a bad unit becomes U+FFFD.
 */

const REPLACEMENT = '�';

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function normalizePgString(s) {
  return s.toWellFormed().replaceAll('\0', REPLACEMENT);
}

// JSON.stringify never shows its replacer an object key, so a key holding a bad
// unit is repaired by handing back a copy with normalized keys.
function normalizeKeys(value) {
  const keys = Object.keys(value);
  if (keys.every((key) => normalizePgString(key) === key)) return value;
  return Object.fromEntries(keys.map((key) => [normalizePgString(key), value[key]]));
}

function repairJsonValue(_key, value) {
  if (typeof value === 'string') return normalizePgString(value);
  return isPlainObject(value) ? normalizeKeys(value) : value;
}

/** `JSON.stringify` for a `json`/`jsonb` parameter: strings and object keys are repaired first. */
export function toPgJson(value) {
  return JSON.stringify(value, repairJsonValue);
}

const normalizeParam = (param) => {
  if (typeof param === 'string') return normalizePgString(param);
  if (Array.isArray(param)) return param.map(normalizeParam);
  // Mirrors node-postgres, which JSON-serializes a plain object parameter itself.
  return isPlainObject(param) ? toPgJson(param) : param;
};

/**
 * Repair a query's bound parameters in one place. Strings are repaired as-is
 * (never unescaped: a `text` value may legitimately contain the characters `\^@`),
 * array elements likewise, and plain objects become repaired JSON text.
 */
export function normalizePgParams(params) {
  return Array.isArray(params) ? params.map(normalizeParam) : params;
}
