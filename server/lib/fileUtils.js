/**
 * Backward-compatible facade re-exporting the focused file utility modules so existing deep imports
 * need no caller changes.
 */

/**
 * Backward-compatible file utility facade.
 *
 * New code should import from the focused module that owns the helper. Existing
 * deep imports remain stable while callers migrate opportunistically.
 */
export * from './fileCore.js';
export * from './jsonIo.js';
export * from './paths.js';
export * from './pathSafety.js';
