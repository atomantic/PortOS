// Shared URL builder for sprite record assets served by the /data/sprites
// static mount — one place for the per-segment encoding rules.
export const spriteAssetUrl = (recordId, relPath) => `/data/sprites/${encodeURIComponent(recordId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;

// Every sprite asset is a transparent-capable PNG/GIF, and PortOS's dark
// surfaces are near-black — so alpha regions are indistinguishable from black
// pixels on a plain background. Every surface that can show one paints this
// checkerboard behind it instead (#2930).
const CHECKER_DARK = '#191919';
const CHECKER_LIGHT = '#2e2e2e';

/**
 * Inline style for a transparency checkerboard. `cell` is the square size in
 * px — use a smaller cell on thumbnails so the pattern stays legible.
 * Returns a fresh object each call (React style props must not be shared and
 * mutated), and only sets background-* properties so it composes with any
 * caller-supplied sizing/border classes.
 */
export function checkerboardStyle(cell = 8) {
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

// Pixel art must never be smoothed on upscale.
export const PIXELATED = { imageRendering: 'pixelated' };

/**
 * Checkerboard + pixelated in one style object, for an <img> that paints its
 * own background (the common case — the checker shows through the alpha).
 */
export function spritePreviewStyle(cell = 8) {
  return { ...checkerboardStyle(cell), ...PIXELATED };
}
