/**
 * Client mirror of the character-rigging readiness reason labels in `server/services/rigging/readiness.js`.
 *
 * The server returns stable kebab-case reason codes (`unsupported-platform`, `module-unimportable`, …) whenever rigging is not ready; this is the label side. The client can't import the server module (the runtime probe reaches `node:fs` / `child_process`), so this is a hand-maintained mirror;
 * `server/services/rigging/unavailableReasons.parity.test.js` asserts drift and that the key set equals the codes `riggingUnavailableReason()` returns. Names are prefixed (`RIGGING_…`) so a call site importing the image-to-3D lane's `UNAVAILABLE_REASONS` too never has to alias.
 */

export const RIGGING_UNAVAILABLE_REASONS = Object.freeze({
  'unsupported-platform': 'Rigging needs macOS on Apple Silicon, or Linux',
  'runtime-not-installed': 'The Blender rigging runtime is not installed yet',
  // The failure this phase names: the env resolved, the module did not import (reporting ready would trade a named blocker for a render-time crash).
  'module-unimportable': 'The rigging runtime is only half installed',
  // "We could not look" is not "nothing there": never report an absent runtime we failed to probe (AGENTS.md sentinel rule).
  'runtime-probe-failed': 'Could not check the rigging runtime on this host',
});

export const RIGGING_REASON_FALLBACK = 'Rigging is unavailable on this host';

/**
 * User-facing label for a reason code; own-property lookup only, so an Object.prototype key name can't render as a function.
 * @param {string|null} [reason]
 * @param {string} [fallback]
 * @returns {string}
 */
export function riggingReasonLabel(reason, fallback = RIGGING_REASON_FALLBACK) {
  return Object.hasOwn(RIGGING_UNAVAILABLE_REASONS, reason ?? '') ? RIGGING_UNAVAILABLE_REASONS[reason] : fallback;
}
