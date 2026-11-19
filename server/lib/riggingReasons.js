/**
 * Character-rigging readiness reason codes mapped to their user-facing labels (`riggingReasonLabel`).
 *
 * ONE definition: `server/services/rigging/readiness.js` re-exports it and `client/src/lib/riggingReasons.js` re-exports it for the browser. The codes are SERVER vocabulary (what `riggingUnavailableReason()` returns); `readiness.test.js` pins that this key set equals the returned codes. No imports, so the browser bundle can load it (the runtime probe in `readiness.js` reaches `node:fs` / `child_process`). Labels are never interpolated: machine-specific values travel in `detail`.
 */

export const RIGGING_UNAVAILABLE_REASONS = Object.freeze({
  'unsupported-platform': 'Rigging needs macOS on Apple Silicon, or Linux',
  'runtime-not-installed': 'The Blender rigging runtime is not installed yet',
  // The failure this phase exists to name: the env resolved, the module did not import.
  // Reporting it as ready would trade a named blocker for a render-time crash.
  'module-unimportable': 'The rigging runtime is only half installed',
  // "We could not look" is not "there is nothing there" — never report an absent
  // runtime we failed to probe (AGENTS.md sentinel rule).
  'runtime-probe-failed': 'Could not check the rigging runtime on this host',
});

/** Label for a reason code the map doesn't know (or a null/absent code). */
export const RIGGING_REASON_FALLBACK = 'Rigging is unavailable on this host';

/**
 * User-facing label for a reason code. Own-property lookup only, so a code that
 * happens to name an Object.prototype key can't render as a function/object.
 * @param {string|null} [reason]
 * @param {string} [fallback]
 * @returns {string}
 */
export function riggingReasonLabel(reason, fallback = RIGGING_REASON_FALLBACK) {
  return Object.hasOwn(RIGGING_UNAVAILABLE_REASONS, reason ?? '') ? RIGGING_UNAVAILABLE_REASONS[reason] : fallback;
}
