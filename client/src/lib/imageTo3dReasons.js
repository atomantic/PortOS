/**
 * Image-to-3D unavailable-reason labels (re-exported from `server/lib/imageTo3dReasons.js`) plus the `isTargetReady` readiness predicate.
 *
 * The server returns stable kebab-case reason codes (`requires-cuda`, `cuda-probe-failed`, …) on every unavailable target; the label side the UI renders is the one definition in the server leaf.
 */

export { UNAVAILABLE_REASONS, UNAVAILABLE_REASON_FALLBACK, unavailableReasonLabel } from '../../../server/lib/imageTo3dReasons.js';

/**
 * Is this target ready to render on this host? `installed` is TRI-STATE: `true` = local weights present, `false` = installable but not installed, `null` = no install concept (a hosted API lane), ready as soon as it is available.
 * Gating on plain `target.installed` truthiness silently reports a hosted target as not-ready. Shared so the `/3d` readiness summary and the Models → 3D badge can't disagree.
 * @param {{available?: boolean, installed?: boolean|null}|null} [target]
 */
export const isTargetReady = (target) => !!target && !!target.available && target.installed !== false;
