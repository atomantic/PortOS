/**
 * The one way to render a sprite asset (#2930).
 *
 * Every sprite is a transparent PNG on PortOS's near-black surfaces, so each
 * preview needs a checkerboard behind it and `image-rendering: pixelated` on
 * the art. Applying that per call site went wrong immediately: the checker
 * belongs on the BOX, not on the <img>, because `object-contain` letterboxes
 * the image and a background set on the img itself paints only the letterboxed
 * content area — leaving the surrounding gap unmarked. Sharing the style
 * object alone let each site re-derive (and get) that rule wrong, so the
 * element is shared instead.
 */

import { checkerboardStyle, spriteAssetUrl, PIXELATED } from './spriteAssets.js';

export default function SpritePreview({
  recordId,
  path,
  alt,
  className = '',
  imgClassName = 'w-full h-full object-contain',
  cell = 6,
  loading = 'lazy',
}) {
  return (
    <span
      className={`block overflow-hidden ${className}`}
      style={checkerboardStyle(cell)}
    >
      <img
        src={spriteAssetUrl(recordId, path)}
        alt={alt ?? path}
        loading={loading}
        className={imgClassName}
        style={PIXELATED}
      />
    </span>
  );
}
