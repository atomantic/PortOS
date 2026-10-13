import { useCallback, useEffect, useRef } from 'react';
import { IMAGE_EFFECT_FOG_COLOR, imageEffectState } from '../../lib/musicVideoImageEffects.js';

/**
 * A still shot's image effect in the storyboard animatic: the still, cover-fitted
 * as the final render crops it, with the effect's flash and emulsion laid over it
 * and its contrast and colour filtered, all from the same curves the render uses
 * (`imageEffectState`). Paused it paints the frame at `time`; playing it repaints
 * every animation frame from the song's clock, writing styles directly so the
 * board does not re-render per frame.
 */
export default function ImageEffectStill({ src, effect, startSec, audioRef, time }) {
  const imgRef = useRef(null);
  const fogRef = useRef(null);
  const flashRef = useRef(null);
  const paint = useCallback((t) => {
    const state = imageEffectState(effect, t - startSec);
    if (imgRef.current) imgRef.current.style.filter = `contrast(${state.contrast}) saturate(${state.saturation})`;
    if (fogRef.current) fogRef.current.style.opacity = String(state.fog);
    if (flashRef.current) flashRef.current.style.opacity = String(state.flash);
  }, [effect, startSec]);
  useEffect(() => { paint(time); }, [time, paint]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    let handle = 0;
    const tick = () => {
      paint(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(handle); paint(audio.currentTime || 0); };
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(handle);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, [audioRef, paint]);
  return (
    <div className="relative h-full w-full" data-testid="animatic-image-effect">
      <img ref={imgRef} src={src} alt="" className="h-full w-full object-cover" />
      <div ref={fogRef} className="pointer-events-none absolute inset-0" style={{ background: IMAGE_EFFECT_FOG_COLOR, opacity: 0 }} />
      <div ref={flashRef} className="pointer-events-none absolute inset-0" style={{ background: '#fff', opacity: 0 }} />
    </div>
  );
}
