/** Sanitize character identity packs and assess their readiness for canon-locked production. */

import { IDENTITY_ASSET_ROLES, IDENTITY_PACK_REQUIRED_ROLES } from './storyBibleRoles.js';
import { BIBLE_LIMITS } from './bibleLimits.js';
import { isPlainObject } from './objects.js';
import { trimTo } from './textUtils.js';
import { cleanStringArray } from './storyBibleFields.js';

const IDENTITY_ASSET_ROLE_SET = new Set(IDENTITY_ASSET_ROLES);

export function sanitizeIdentityPack(raw, imageRefs) {
  if (!isPlainObject(raw)) return null;
  const seen = new Set();
  const assets = [];
  for (const item of Array.isArray(raw.assets) ? raw.assets : []) {
    if (!isPlainObject(item)) continue;
    const role = trimTo(item.role, 64);
    const imageRef = trimTo(item.imageRef, BIBLE_LIMITS.IMAGE_REF_MAX);
    // The pack may only curate an image the character already owns. This
    // prevents arbitrary filesystem/provider pointers from becoming canon.
    if (!IDENTITY_ASSET_ROLE_SET.has(role) || !imageRefs.includes(imageRef)) continue;
    const key = `${role}:${imageRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({ role, imageRef, approved: item.approved === true });
    if (assets.length >= BIBLE_LIMITS.IDENTITY_PACK_ASSETS_MAX) break;
  }
  const avoid = cleanStringArray(raw.avoid, BIBLE_LIMITS.IDENTITY_PACK_AVOID_ITEM_MAX, BIBLE_LIMITS.IDENTITY_PACK_AVOID_MAX);
  return assets.length || avoid.length ? { assets, avoid } : null;
}

/**
 * Resolve a portable identity-pack status for canon-locked production.
 * Consumers must refuse (or visibly degrade) a locked render unless status is
 * `ready`; an empty candidate pack is deliberately `missing`, never ready.
 */
export function characterIdentityPackReadiness(character) {
  const approved = Array.isArray(character?.identityPack?.assets)
    ? character.identityPack.assets.filter((asset) => asset?.approved === true)
    : [];
  const byRole = new Map();
  for (const asset of approved) {
    if (!IDENTITY_ASSET_ROLE_SET.has(asset?.role)) continue;
    const rows = byRole.get(asset.role) || [];
    rows.push(asset);
    byRole.set(asset.role, rows);
  }
  const missing = IDENTITY_PACK_REQUIRED_ROLES.filter((role) => !(byRole.get(role)?.length));
  const ambiguous = IDENTITY_PACK_REQUIRED_ROLES.filter((role) => (byRole.get(role)?.length || 0) > 1);
  return {
    status: ambiguous.length ? 'ambiguous' : missing.length ? 'missing' : 'ready',
    missing,
    ambiguous,
    assets: approved,
  };
}
