import { useState } from 'react';

/**
 * Square list-card thumbnail with graceful fallback. Renders the image from
 * `/data/images/<imageRef>` and swaps to `FallbackIcon` when there's no ref or
 * the image 404s (e.g. a peer synced the pointer but not the bytes yet). Shared
 * by the universe reference thumbnail and the series cover thumbnail.
 */
export default function ImageThumb({ imageRef, FallbackIcon, alt = '' }) {
  const [broken, setBroken] = useState(false);
  const showImage = imageRef && !broken;
  return (
    <div className="flex-shrink-0 w-12 h-12 rounded-md overflow-hidden bg-port-bg border border-port-border flex items-center justify-center">
      {showImage ? (
        <img
          src={`/data/images/${encodeURIComponent(imageRef)}`}
          alt={alt}
          loading="lazy"
          onError={() => setBroken(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <FallbackIcon className="w-5 h-5 text-gray-600" aria-hidden="true" />
      )}
    </div>
  );
}
