import { useCallback, useEffect, useRef } from 'react';
import { IMAGE_EFFECT_FOG_COLOR, imageEffectState } from '../../lib/musicVideoImageEffects.js';

/**
 * A still shot's image effect, as the final render plays it: the still (and,
 * for an end-frame effect, the end frame over it), cover-fitted as the render
 * crops them, with the effect's flash and emulsion laid over and its contrast
 * and colour filtered, all from the same curves the render uses
 * (`imageEffectState`). Stopped it paints the moment at `time` (song seconds);
 * while `playing` it repaints every animation frame from `getTime()`, writing
 * styles directly so its parent does not re-render per frame.
 *
 * The picture on top carries `data-shown`, so a glitch painted over the
 * frame (TransitionGlitch) reads the picture that is showing.
 */
export default function ImageEffectStill({ src, endSrc = null, effect, startSec, time, playing = false, getTime = null, fps = 24 }) {
  const imgRef = useRef(null);
  const endRef = useRef(null);
  const fogRef = useRef(null);
  const flashRef = useRef(null);
  const paint = useCallback((t) => {
    const state = imageEffectState(effect, t - startSec, { fps });
    if (imgRef.current) {
      imgRef.current.style.filter = `contrast(${state.contrast}) saturate(${state.saturation})`;
      imgRef.current.dataset.shown = state.end < 1 ? 'true' : 'false';
    }
    if (endRef.current) {
      endRef.current.style.opacity = String(state.end);
      endRef.current.dataset.shown = state.end >= 1 ? 'true' : 'false';
    }
    if (fogRef.current) fogRef.current.style.opacity = String(state.fog);
    if (flashRef.current) flashRef.current.style.opacity = String(state.flash);
  }, [effect, startSec, fps]);
  useEffect(() => { paint(time); }, [time, paint]);
  useEffect(() => {
    if (!playing || !getTime) return undefined;
    let handle = 0;
    const tick = () => {
      paint(getTime());
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, getTime, paint]);
  return (
    <div className="relative h-full w-full" data-testid="animatic-image-effect">
      {/* The start frame comes first, so a plain `img` lookup (Save frame) still finds the shot's still. */}
      <img ref={imgRef} src={src} alt="" data-shown="true" className="h-full w-full object-cover" />
      {endSrc && <img ref={endRef} src={endSrc} alt="" data-shown="false" className="pointer-events-none absolute inset-0 h-full w-full object-cover" style={{ opacity: 0 }} />}
      <div ref={fogRef} className="pointer-events-none absolute inset-0" style={{ background: IMAGE_EFFECT_FOG_COLOR, opacity: 0 }} />
      <div ref={flashRef} className="pointer-events-none absolute inset-0" style={{ background: '#fff', opacity: 0 }} />
    </div>
  );
}
