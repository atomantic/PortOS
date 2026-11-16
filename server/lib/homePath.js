/**
 * scrubHomePath replaces the running user's home-directory prefix with `~`; non-strings pass through.
 *
 * Builtins only: `scripts/doctor.js` loads it from a bare checkout (`scripts/pre-install-entrypoints.test.js`).
 */
import { homedir } from 'os';

/**
 * Replace the user's home directory prefix with `~` anywhere in a string.
 *
 * @param {*} value - any value; non-strings pass through untouched
 * @returns {*} the scrubbed string, or `value` unchanged
 */
export function scrubHomePath(value) {
  const home = homedir();
  // A root-user container reports `/` as home; substituting would rewrite every separator.
  if (typeof value !== 'string' || !home || home === '/' || home === '\\') return value;
  return value.split(home).join('~');
}
