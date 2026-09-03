/**
 * Client mirror of the character-rigging readiness reason labels in
 * `server/services/rigging/readiness.js`. The server returns stable kebab-case reason
 * codes (`unsupported-platform`, `module-unimportable`, …) whenever rigging is not
 * ready; this is the label side the UI renders.
 *
 * The client can't import the server module (it reaches `node:fs` / `child_process`
 * through the runtime probe), so this is a hand-maintained mirror — drift is asserted
 * by `server/services/rigging/unavailableReasons.parity.test.js`, which also checks the
 * key set still equals the codes `riggingUnavailableReason()` returns. If you change
 * one side, change the other.
 *
 * Names are prefixed (`RIGGING_…`) rather than reusing the image-to-3D lane's generic
 * `UNAVAILABLE_REASONS`, because both modules are flat `export *` members of the same
 * `client/src/lib` barrel and a shared identifier there is a collision.
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
