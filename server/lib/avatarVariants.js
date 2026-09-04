/**
 * Rigged-record avatar variants (issue #5894).
 *
 * A completed rigged + animated image-to-3D record is selectable as an avatar
 * through the SAME `?variant=` namespace as the file-backed variants in
 * `server/routes/avatar.js`, under the `rigged-<modelId>` spelling. The record
 * id charset (`image3d-<uuid>`) already satisfies the route's strict variant
 * guard, so the prefix is a namespace — not a second guard — and traversal
 * attempts are still rejected by the one shared pattern.
 *
 * Pure string/shape helpers only: record lookup and file serving stay in the
 * route, and clip coverage stays in `services/rigging/clipCapabilities.js`.
 */

/** Namespace prefix separating record-backed variants from file-backed ones. */
export const RIGGED_VARIANT_PREFIX = 'rigged-';

/**
 * The one charset the avatar variant namespace accepts. Mirrors the guard in
 * `server/routes/avatar.js` — both the full file-variant spelling and the
 * record id inside a `rigged-` spelling must match it, so a malicious
 * `?variant` can never carry a slash, a dot, or an extension into a path join.
 */
export const AVATAR_VARIANT_PATTERN = /^[a-z0-9-]+$/;

/**
 * Extract the record id from a rigged variant spelling, or `null` when the
 * value is not a rigged spelling or its id fails the shared charset guard.
 * @param {unknown} variant
 * @returns {string|null}
 */
export function parseRiggedVariant(variant) {
  if (typeof variant !== 'string' || !variant.startsWith(RIGGED_VARIANT_PREFIX)) return null;
  const id = variant.slice(RIGGED_VARIANT_PREFIX.length);
  return id && AVATAR_VARIANT_PATTERN.test(id) ? id : null;
}

/**
 * The `?variant=` spelling that selects a record, or `null` when the id is
 * not variant-safe (never emit an unresolvable spelling into a selector).
 * @param {unknown} modelId
 * @returns {string|null}
 */
export function riggedVariantForId(modelId) {
  if (typeof modelId !== 'string' || !AVATAR_VARIANT_PATTERN.test(modelId)) return null;
  return `${RIGGED_VARIANT_PREFIX}${modelId}`;
}

/**
 * Whether an image-to-3D record has a published, verified animated GLB worth
 * offering as an avatar. Mirrors the retarget lane's own readiness read
 * (`retargetImageTo3dModel` persists `status: 'ready'` plus the run id only
 * after the published pair verifies) — absent/`null` (pre-rigging records)
 * and non-ready states are all "not selectable", never errors.
 * @param {object|null} record
 * @returns {boolean}
 */
export function isAnimatedRecordReady(record) {
  const retarget = record?.retarget;
  return retarget?.status === 'ready'
    && typeof retarget?.retargetId === 'string'
    && retarget.retargetId.length > 0;
}
