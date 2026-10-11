import { useEffect, useId, useRef, useState } from 'react';
import { filmLookFilterMarkup, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';

// Before the box is measured (and in a test DOM that never lays out), radii
// scale to a nominal preview width rather than to nothing.
const NOMINAL = { width: 1280, height: 720 };

/**
 * Children seen through a film look, live: the same SVG filter the render and
 * the gallery bake use, sized to this box so every radius reads as it will at
 * full size. `frame` is the song frame; it re-seeds the grain and drift so the
 * texture moves the way the finished render's does. A neutral look renders the
 * children untouched.
 */
export default function FilmLookFrame({ look, frame = 0, className = '', children }) {
  const ref = useRef(null);
  const [size, setSize] = useState(NOMINAL);
  const filterId = `portos-film-look-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const settings = normalizeFilmLook(look);
  const active = !!settings && !isFilmLookNeutral(settings);
  useEffect(() => {
    const box = ref.current;
    if (!box || !active) return undefined;
    const measure = () => { if (box.clientWidth > 0) setSize({ width: Math.round(box.clientWidth), height: Math.round(box.clientHeight) }); };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [active]);
  const built = active ? filmLookFilterMarkup(settings, { frame, width: size.width, height: size.height, id: filterId }) : null;
  return (
    <div ref={ref} className={`relative ${className}`} style={built?.active ? { filter: built.css } : undefined} data-film-look={built?.active ? 'on' : undefined}>
      {built?.active && <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: built.svg }} />}
      {children}
    </div>
  );
}
