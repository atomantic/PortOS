import { useEffect, useId, useRef, useState } from 'react';
import { filmLookFilterMarkup, filmLookMotionLayers, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';

// Before the box is measured (and in a test DOM that never lays out), radii
// scale to a nominal preview width rather than to nothing.
const NOMINAL = { width: 1280, height: 720 };

/**
 * Children seen through a film look, live, sized to this box so every radius
 * reads as it will at full size. `frame` is the song frame; it re-seeds the
 * grain and drives the weave, flicker and leak drift the way the render's frame
 * does. Two renderings of the same look:
 *
 * - paused (`playing` false): the exact SVG filter the render and the gallery
 *   bake use, over the whole box — one evaluation per frame shown;
 * - playing: `filmLookMotionLayers`, CSS filter functions and blended overlay
 *   layers the compositor runs per video frame for free, because a browser
 *   re-runs an SVG filter chain over every decoded frame and the full look
 *   stalled a phone's playback after #11215. The glows, fringing and split tone
 *   wait for the pause.
 *
 * A neutral look renders the children untouched.
 */
export default function FilmLookFrame({ look, frame = 0, playing = false, className = '', children }) {
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
  const exact = active && !playing ? filmLookFilterMarkup(settings, { frame, width: size.width, height: size.height, id: filterId }) : null;
  const motion = active && playing ? filmLookMotionLayers(settings, { frame, width: size.width, height: size.height }) : null;
  // Off, paused or playing, the children sit in one wrapper at one place in the tree, so a
  // switch between the renderings (play, pause, the look going on or off) keeps them mounted:
  // a video remounted there loads again, and its picture is gone until it has. Outside the
  // playing rendering the wrapper makes no box, so the children lay out as this box's own.
  return (
    <div ref={ref} className={`relative ${motion ? 'overflow-hidden ' : ''}${className}`} style={exact?.active ? { filter: exact.css } : undefined}
      data-film-look={motion ? 'motion' : exact?.active ? 'exact' : undefined}
      data-film-look-frame={exact ? frame : undefined} data-film-look-width={exact ? size.width : undefined} data-film-look-height={exact ? size.height : undefined}>
      {exact?.active && <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: exact.svg }} />}
      <div className={motion ? 'absolute inset-0' : 'contents'} style={motion ? { filter: motion.filter || undefined, transform: motion.transform || undefined } : undefined}
        data-film-look-layer={motion ? 'picture' : undefined}>{children}</div>
      {motion?.overlays.map((layer) => (
        <div
          key={layer.key}
          aria-hidden="true"
          data-film-look-layer={layer.key}
          className={`pointer-events-none absolute ${layer.kind === 'tile' ? 'left-0 top-0 h-[200%] w-[200%]' : 'inset-0'}`}
          style={{
            opacity: layer.opacity,
            mixBlendMode: layer.blend,
            ...(layer.kind === 'flat' ? { backgroundColor: layer.color } : {}),
            ...(layer.kind === 'gradient' ? { backgroundImage: layer.gradient } : {}),
            ...(layer.kind === 'tile' ? {
              backgroundImage: `url("${layer.image}")`,
              backgroundSize: `${layer.size[0]}px ${layer.size[1]}px`,
              backgroundRepeat: 'repeat',
              // Half the oversized tile layer is spare on each axis: the shift slides it compositor-side.
              transform: `translate(${-layer.shift[0] * 50}%, ${-layer.shift[1] * 50}%)`,
            } : {}),
          }}
        />
      ))}
    </div>
  );
}
