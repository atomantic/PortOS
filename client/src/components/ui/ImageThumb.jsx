import { useState, useEffect } from 'react';
import { galleryTileSources } from '../../lib/imageThumbnailSrc';

/**
 * List-card thumbnail with graceful fallback. Renders the image from
 * `/data/images/<imageRef>` and swaps to `FallbackIcon` when there's no ref or
 * the image 404s (e.g. a peer synced the pointer but not the bytes yet). Shared
 * by the universe reference thumbnail (square) and the series cover thumbnail
 * (comic-book portrait — pass `sizeClass`). `sizeClass` sets only the box
 * dimensions; the frame styling is constant. Loads the 512px WebP derivative
 * first (a 48px tile does not need the multi-MB original) and retries the
 * original before giving up.
 */
export default function ImageThumb({ imageRef, FallbackIcon, alt = '', sizeClass = 'w-12 h-12' }) {
  const sources = imageRef ? galleryTileSources([encodeURIComponent(imageRef)]).map(({ src }) => src) : [];
  const [failures, setFailures] = useState(0);
  // Reset the error state when the ref changes — otherwise a stale/404 ref that
  // exhausted the sources would keep the fallback icon stuck even after
  // `imageRef` updates to a valid filename (cover rendered / synced while the
  // list stayed mounted), until a remount.
  useEffect(() => { setFailures(0); }, [imageRef]);
  const showImage = failures < sources.length;
  return (
    <div className={`flex-shrink-0 ${sizeClass} rounded-md overflow-hidden bg-port-bg border border-port-border flex items-center justify-center`}>
      {showImage ? (
        <img
          src={sources[failures]}
          alt={alt}
          loading="lazy"
          onError={() => setFailures((n) => n + 1)}
          className="w-full h-full object-cover"
        />
      ) : (
        <FallbackIcon className="w-5 h-5 text-gray-600" aria-hidden="true" />
      )}
    </div>
  );
}
