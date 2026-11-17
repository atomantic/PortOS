// Shared resolver for "is this a local gallery image, and what's its filename?"
//
// `localImageFilename(urlOrPath)` resolves a stored image reference to the bare gallery-image filename under `data/images/`, the unit the peer-sync
// asset pipeline hashes + transfers. Returns null for empty/non-string input, external URLs (`http(s):`, `data:`, `blob:`), and any other absolute path
// (videos, `image-refs` federate through their own manifests). Path-traversal scrubbing happens downstream in `sanitizeAssetFilename`.

import { isStr } from './textUtils.js';
/**
 * Strip querystring/hash and reduce to the basename; shared with `imageUrlToAppAsset` in `moodBoard/logic.js`.
 * @param {unknown} pathOrName - a path segment or bare filename (no mount prefix)
 * @returns {string|null} the basename, or null when it collapses to empty
 */
export function assetBasename(pathOrName) {
  if (!isStr(pathOrName)) return null;
  const base = pathOrName.split(/[?#]/)[0].split('/').pop();
  return base || null;
}

/**
 * @param {unknown} urlOrPath - a stored image reference (URL, mount path, or bare filename)
 * @returns {string|null}
 */
export function localImageFilename(urlOrPath) {
  if (!isStr(urlOrPath)) return null;
  const url = urlOrPath.trim();
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return null;
  // Only gallery images sync as assets: canonical mount path or bare filename.
  const imagesPrefix = '/data/images/';
  if (url.startsWith(imagesPrefix)) return assetBasename(url.slice(imagesPrefix.length));
  if (url.startsWith('/')) return null; // some other absolute path → not a gallery image
  return assetBasename(url);
}
