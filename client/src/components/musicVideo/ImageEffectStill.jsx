import { useCallback, useEffect, useRef } from 'react';
import { IMAGE_EFFECT_FOG_COLOR, imageEffectState, photoSequenceIndex } from '../../lib/musicVideoImageEffects.js';

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
export default function ImageEffectStill({ src, endSrc = null, effect, sequence = null, startSec, time, playing = false, getTime = null, fps = 24 }) {
  const imgRefs = useRef([]);
  const endRef = useRef(null);
  const fogRef = useRef(null);
  const flashRef = useRef(null);
  const paint = useCallback((t) => {
    const state = effect ? imageEffectState(effect, t - startSec, { fps }) : { contrast: 1, saturation: 1, end: 0, fog: 0, flash: 0 };
    const selected = sequence ? photoSequenceIndex(sequence, t, { fps }) : 0;
    imgRefs.current.forEach((img, i) => {
      if (!img) return;
      img.style.filter = `contrast(${state.contrast}) saturate(${state.saturation})`;
      img.style.opacity = i === selected ? '1' : '0';
      img.dataset.shown = i === selected && state.end < 1 ? 'true' : 'false';
    });
    if (endRef.current) {
      endRef.current.style.opacity = String(state.end);
      endRef.current.dataset.shown = state.end >= 1 ? 'true' : 'false';
    }
    if (fogRef.current) fogRef.current.style.opacity = String(state.fog);
    if (flashRef.current) flashRef.current.style.opacity = String(state.flash);
  }, [effect, sequence, startSec, fps]);
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
      {(sequence ? sequence.imageIds.map(id => `/data/images/${encodeURIComponent(id)}`) : [src]).map((url, i) => (
        <img key={`${i}:${url}`} ref={el => { imgRefs.current[i] = el; }} src={url} alt=""
          data-shown={i === 0 ? 'true' : 'false'} style={{ opacity: i === 0 ? 1 : 0 }}
          className="absolute inset-0 h-full w-full object-cover" />
      ))}
      {endSrc && <img ref={endRef} src={endSrc} alt="" data-shown="false" className="pointer-events-none absolute inset-0 h-full w-full object-cover" style={{ opacity: 0 }} />}
      <div ref={fogRef} className="pointer-events-none absolute inset-0" style={{ background: IMAGE_EFFECT_FOG_COLOR, opacity: 0 }} />
      <div ref={flashRef} className="pointer-events-none absolute inset-0" style={{ background: '#fff', opacity: 0 }} />
    </div>
  );
}
