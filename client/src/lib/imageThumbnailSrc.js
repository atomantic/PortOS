// The served 512px WebP derivative of a gallery PNG (`/data/images/x.png` →
// `/data/image-thumbnails/x.webp`, generated on first request), or null when
// `src` is not a gallery PNG. Callers keep the original as the fallback.
export function imageThumbnailSrc(src) {
  const match = /^\/data\/images\/([^/?#]+)\.png$/i.exec(typeof src === 'string' ? src : '');
  return match ? `/data/image-thumbnails/${match[1]}.webp` : null;
}

// Load order for gallery filenames shown as small tiles: each file's WebP
// derivative, then its original, before moving on to the next filename.
export function galleryTileSources(filenames) {
  return filenames.flatMap((name) => {
    const original = `/data/images/${name}`;
    const thumb = imageThumbnailSrc(original);
    return (thumb ? [thumb, original] : [original]).map((src) => ({ name, src }));
  });
}
