import { useEffect, useRef, useState } from 'react';
import { filmLookFilterMarkup, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';

/**
 * An image seen through a film look, live: the same SVG filter the render and
 * the gallery bake use, sized to the image as displayed so every radius reads
 * as it will at full size. Press and hold (or press space) on the picture to
 * see the original underneath. `frame` re-seeds the grain and drift.
 */
export default function FilmLookPreview({ src, alt = '', look, frame = 0, className = '' }) {
  const imgRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [showOriginal, setShowOriginal] = useState(false);
  const filterId = useRef(`portos-film-look-${Math.random().toString(36).slice(2, 9)}`).current;
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return undefined;
    const measure = () => setSize({ width: Math.round(img.clientWidth), height: Math.round(img.clientHeight) });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
  }, [src]);
  const settings = normalizeFilmLook(look);
  const built = settings && !isFilmLookNeutral(settings) && size.width > 0
    ? filmLookFilterMarkup(settings, { frame, width: size.width, height: size.height, id: filterId })
    : null;
  const filtered = built?.active && !showOriginal;
  return (
    <div className={`relative select-none ${className}`}
      onPointerDown={() => setShowOriginal(true)} onPointerUp={() => setShowOriginal(false)} onPointerCancel={() => setShowOriginal(false)} onPointerLeave={() => setShowOriginal(false)}
      onKeyDown={(event) => { if (event.key === ' ') { event.preventDefault(); setShowOriginal(true); } }}
      onKeyUp={(event) => { if (event.key === ' ') setShowOriginal(false); }}
      role="img" aria-label={`${alt || 'Image'} with the film look applied. Hold to compare with the original.`} tabIndex={0}>
      {built && <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: built.svg }} />}
      <img ref={imgRef} src={src} alt="" draggable={false} onLoad={() => imgRef.current && setSize({ width: Math.round(imgRef.current.clientWidth), height: Math.round(imgRef.current.clientHeight) })}
        className="block max-h-full max-w-full object-contain" style={{ filter: filtered ? built.css : 'none' }} data-testid="film-look-image" />
      {built?.active && (
        <span className="port-media-overlay pointer-events-none absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px]">{showOriginal ? 'Original' : 'Hold to compare'}</span>
      )}
    </div>
  );
}
