// Shared URL builder for sprite record assets served by the /data/sprites static mount: one place for the per-segment encoding rules.
//
// `version` is an optional content token (a sha256 from the run manifest) that changes the URL whenever the bytes do (#3020): the packer rewrites a strip IN PLACE at a stable path,
// so without a token the browser keeps painting the decoded image (no request, no ETag revalidation). A CONTENT hash, not `Date.now()`, so caching still works when pixels are unchanged.
//
// The token is used VERBATIM: truncating corrupted a composite `mtimeMs-size` token (22 chars) by dropping the size half that catches a rewrite too fast for mtime resolution.
// Shortening is the caller's call (see `stripVersionToken`): only it knows whether the token is a hash (safe to truncate) or a composite (not).
export const spriteAssetUrl = (recordId, relPath, version) => {
  const path = `/data/sprites/${encodeURIComponent(recordId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  // Only a non-empty STRING versions the URL: a stray number/object would stringify into nonsense, and `?v=undefined` would be a cache-buster that never changes.
  return typeof version === 'string' && version ? `${path}?v=${encodeURIComponent(version)}` : path;
};

// No client-side "which token field wins" resolver: the server normalizes every run's strip token into `stripPreview.stripVersion` (normalizeStripPreview in services/sprites/walk.js), so consumers just pass it through.

/**
 * Cache-busting token for an asset row from `listSpriteAssets` (#3020). A reprocess also rewrites packaged phase frames and the contrast review sheet in place, the surfaces a user opens to confirm the
 * strip was repacked, so without a token they show pre-reprocess art. Every asset row already carries `mtime` and `size`; same composite shape as the redraw strip token and likewise never truncated.
 */
export const assetVersionToken = (asset) => (
  asset?.mtime > 0 && asset?.size >= 0 ? `${Math.round(asset.mtime)}-${asset.size}` : undefined
);

// Sprite assets are transparent-capable PNG/GIF and PortOS's dark surfaces are near-black, so every surface that can show alpha paints this checkerboard behind it (#2930).
// Read through CSS custom properties so a light theme can re-map them in index.css; the literals are the dark defaults.
const CHECKER_DARK = 'var(--sprite-checker-dark, #191919)';
const CHECKER_LIGHT = 'var(--sprite-checker-light, #2e2e2e)';

/**
 * Inline style for a transparency checkerboard; `cell` is the square size in px (smaller for thumbnails). Inline because the cell size varies per surface; returns a fresh object each call
 * (React style props must not be shared and mutated) and sets only background-* properties so it composes with caller sizing/border classes.
 */
export function checkerboardStyle(cell = 6) {
  const tile = cell * 2;
  return {
    backgroundColor: CHECKER_DARK,
    backgroundImage: [
      `linear-gradient(45deg, ${CHECKER_LIGHT} 25%, transparent 25%)`,
      `linear-gradient(-45deg, ${CHECKER_LIGHT} 25%, transparent 25%)`,
      `linear-gradient(45deg, transparent 75%, ${CHECKER_LIGHT} 75%)`,
      `linear-gradient(-45deg, transparent 75%, ${CHECKER_LIGHT} 75%)`,
    ].join(', '),
    backgroundSize: `${tile}px ${tile}px`,
    backgroundPosition: `0 0, 0 ${cell}px, ${cell}px -${cell}px, -${cell}px 0`,
  };
}

// Pixel art must never be smoothed on upscale. Frozen and shared (React style props are read-only).
export const PIXELATED = Object.freeze({ imageRendering: 'pixelated' });

// No canvas-painted checkerboard variant: painting it INTO a backing store ties the square size to the canvas scale factor (the Loop Trimmer's attempt, #2933, shrank squares to noise at source
// resolution, #2977). Every surface puts `checkerboardStyle` on the wrapping box, as SpritePreview documents.

// sharp probes more formats than a browser paints (a TIFF yields metadata but a broken-image icon), so the server probe list and this "can I put it in an <img>" list differ on purpose.
const RENDERABLE_FORMATS = new Set(['png', 'gif', 'webp', 'jpeg', 'jpg', 'svg']);

/**
 * Can this asset row be previewed inline as an image? Driven by the SERVER's probe result (`format`/`width`/`height` set only for images it read) rather than a client extension regex, which would drift
 * and pass a truncated PNG. The RENDERABLE_FORMATS gate covers probed-fine-but-unpaintable formats.
 */
export const hasSpritePreview = (asset) => Boolean(
  asset?.width && asset?.height && RENDERABLE_FORMATS.has(asset.format),
);

// Walk runs keep their grok i2v source clip (`generated/source-video.mp4`) in the listing so the inspector plays it inline.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

export const isVideoAsset = (asset) => VIDEO_EXT.test(asset?.path || '');
