// The served 512px WebP derivative of a gallery PNG (`/data/images/x.png` →
// `/data/image-thumbnails/x.webp`, generated on first request), or null when
// `src` is not a gallery PNG. Callers keep the original as the fallback.
export function imageThumbnailSrc(src) {
  const match = /^\/data\/images\/([^/?#]+)\.png$/i.exec(typeof src === 'string' ? src : '');
  return match ? `/data/image-thumbnails/${match[1]}.webp` : null;
}
