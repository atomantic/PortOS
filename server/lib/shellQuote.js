/**
 * POSIX single-quote shell escaping for values interpolated into shell command
 * strings (display command lines, copy-paste command blocks in agent prompts).
 *
 * Bare-safe tokens (`[A-Za-z0-9_./:=+-]`) are returned untouched for readability;
 * anything else is wrapped in single quotes with embedded `'` escaped as `'\''`.
 * This is the canonical helper — do NOT hand-roll another escaper.
 *
 * @param {*} value
 * @returns {string}
 */
export function shellQuote(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
