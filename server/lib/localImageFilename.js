// Shared resolver for "is this a local gallery image, and what's its filename?"
//
// Several federated-record domains (authors `headshotImageUrl`, artists
// `portraitImageUrl`, albums `coverImageUrl`, Creative Director projects
// `startingImageFile`) need to reduce a stored image reference to the bare
// filename under `data/images/` that the peer-sync asset pipeline hashes +
// transfers. They all carried a byte-identical copy of this logic; this is the
// single source of truth they re-export thin wrappers around.
//
// Contract: return the basename of a local gallery image, or `null` when there
// is nothing local to ship —
//   - empty / non-string input,
//   - an external URL (`http(s)://…`, `data:`, `blob:`) the receiver fetches
//     itself (we don't proxy third-party bytes),
//   - any non-`/data/images/` absolute path (videos, `image-refs`, etc. — those
//     federate through their own manifests).
// A leading `/data/images/` mount prefix or a bare filename both reduce to the
// basename. Path-traversal scrubbing happens downstream in
// `sanitizeAssetFilename`; here we only decide IS-this-a-local-image + basename.

const isStr = (v) => typeof v === 'string';

/**
 * Strip any querystring/hash a stored reference might carry, then reduce it to
 * the basename — the bare unit the peer-sync asset pipeline hashes + transfers.
 * This is the "what's the filename" primitive shared by every app-asset
 * resolver: `localImageFilename` below (gallery `/data/images/`) and
 * `imageUrlToAppAsset` in `moodBoard/logic.js` (which also resolves
 * `/data/image-refs/`), so the basename logic lives in exactly one place.
 *
 * @param {unknown} pathOrName - a path segment or bare filename (no mount prefix)
 * @returns {string|null} the basename, or null when it collapses to empty
 */
export function assetBasename(pathOrName) {
  if (!isStr(pathOrName)) return null;
  const base = pathOrName.split(/[?#]/)[0].split('/').pop();
  return base || null;
}

/**
 * Resolve a stored image URL/path to the bare gallery-image filename under
 * `data/images/`, or null when there's nothing local to ship.
 *
 * @param {unknown} urlOrPath - a stored image reference (URL, mount path, or bare filename)
 * @returns {string|null}
 */
export function localImageFilename(urlOrPath) {
  if (!isStr(urlOrPath)) return null;
  const url = urlOrPath.trim();
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return null;
  // Only gallery images sync as assets. Accept the canonical mount path or a
  // bare filename; reject any other absolute path (videos, image-refs, etc.).
  const imagesPrefix = '/data/images/';
  if (url.startsWith(imagesPrefix)) return assetBasename(url.slice(imagesPrefix.length));
  if (url.startsWith('/')) return null; // some other absolute path → not a gallery image
  return assetBasename(url);
}
