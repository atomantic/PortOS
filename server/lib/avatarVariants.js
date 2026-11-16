/**
 * Rigged-record avatar variant spelling: the `rigged-<modelId>` namespace over `?variant=`, sharing the route's
 * strict traversal guard. Pure string/shape helpers only.
 *
 * Record lookup and file serving stay in `server/routes/avatar.js`.
 */

/** Namespace prefix separating record-backed variants from file-backed ones. */
export const RIGGED_VARIANT_PREFIX = 'rigged-';

/** The one charset variants accept (mirrors `server/routes/avatar.js`); keeps slashes and dots out of path joins. */
export const AVATAR_VARIANT_PATTERN = /^[a-z0-9-]+$/;

/** Record id from a rigged variant spelling, or `null` if not rigged or the id fails the charset guard. */
export function parseRiggedVariant(variant) {
  if (typeof variant !== 'string' || !variant.startsWith(RIGGED_VARIANT_PREFIX)) return null;
  const id = variant.slice(RIGGED_VARIANT_PREFIX.length);
  return id && AVATAR_VARIANT_PATTERN.test(id) ? id : null;
}

/** The `?variant=` spelling for a record, or `null` when the id is not variant-safe. */
export function riggedVariantForId(modelId) {
  if (typeof modelId !== 'string' || !AVATAR_VARIANT_PATTERN.test(modelId)) return null;
  return `${RIGGED_VARIANT_PREFIX}${modelId}`;
}

/**
 * Whether an image-to-3D record has a verified animated GLB (the retarget lane persists
 * `status: 'ready'` plus the run id only after verification); otherwise not selectable.
 */
export function isAnimatedRecordReady(record) {
  const retarget = record?.retarget;
  return retarget?.status === 'ready'
    && typeof retarget?.retargetId === 'string'
    && retarget.retargetId.length > 0;
}
