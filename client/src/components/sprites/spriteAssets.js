// Shared URL builder for sprite record assets served by the /data/sprites
// static mount — one place for the per-segment encoding rules.
export const spriteAssetUrl = (recordId, relPath) => `/data/sprites/${encodeURIComponent(recordId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;

// Every sprite asset is a transparent-capable PNG/GIF, and PortOS's dark
// surfaces are near-black — so alpha regions are indistinguishable from black
// pixels on a plain background. Every surface that can show one paints this
// checkerboard behind it instead (#2930). Read through CSS custom properties
// so a light theme can re-map them in index.css; the literals are the dark
// defaults, since a theme that sets neither still needs a working checker.
const CHECKER_DARK = 'var(--sprite-checker-dark, #191919)';
const CHECKER_LIGHT = 'var(--sprite-checker-light, #2e2e2e)';

/**
 * Inline style for a transparency checkerboard. `cell` is the square size in
 * px — thumbnails want a smaller cell so the pattern stays legible, the
 * inspector a larger one. Inline rather than a CSS class because the cell size
 * varies per surface. Returns a fresh object each call (React style props must
 * not be shared and mutated), and only sets background-* properties so it
 * composes with any caller-supplied sizing/border classes.
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

// Pixel art must never be smoothed on upscale. Frozen and shared — it's a
// constant, and every consumer treats React style props as read-only.
export const PIXELATED = Object.freeze({ imageRendering: 'pixelated' });

// Canvas equivalent of the CSS checkerboard above (#2933). A `<canvas>` can't
// read `var(--sprite-checker-*)` or paint a CSS gradient, so the Loop Trimmer's
// canvases resolve the same custom properties off the document root (falling
// back to the dark literals when a theme sets neither) and fill the squares by
// hand. Kept next to `checkerboardStyle` so the two stay the same pattern.
function checkerColor(name, fallback) {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function paintCheckerboard(ctx, width, height, cell = 6) {
  if (!ctx) return; // jsdom / a context-less canvas — nothing to paint
  ctx.fillStyle = checkerColor('--sprite-checker-dark', '#191919');
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = checkerColor('--sprite-checker-light', '#2e2e2e');
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) ctx.fillRect(x, y, cell, cell);
    }
  }
}

// sharp can probe more formats than a browser can paint — a TIFF yields clean
// metadata but renders as a broken-image icon in Chrome/Firefox. So the server
// probe list (for metadata) and this list (for "can I put it in an <img>") are
// deliberately different sets, not duplicates of each other.
const RENDERABLE_FORMATS = new Set(['png', 'gif', 'webp', 'jpeg', 'jpg', 'svg']);

/**
 * Can this asset row be previewed inline as an image? Driven by the SERVER's
 * probe result (`listSpriteAssets` sets `format`/`width`/`height` only for
 * images it read successfully) rather than by a client-side copy of the
 * extension regex — that copy would silently drift, and a truncated PNG passes
 * any extension test while rendering as a broken <img>. The extra
 * RENDERABLE_FORMATS gate covers the opposite case: probed fine, but the
 * browser still can't paint it.
 */
export const hasSpritePreview = (asset) => Boolean(
  asset?.width && asset?.height && RENDERABLE_FORMATS.has(asset.format),
);

// Walk runs keep their grok i2v source clip (`generated/source-video.mp4`) in
// the listing, so the inspector plays it inline rather than making the user
// download it just to review a render.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

export const isVideoAsset = (asset) => VIDEO_EXT.test(asset?.path || '');
