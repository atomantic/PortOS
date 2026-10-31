import { useCallback, useEffect, useRef } from 'react';
import { IMAGE_EFFECT_FOG_COLOR, imageEffectState, photoSequenceIndex, photoSequenceLayers, photoSequenceMaxLayers } from '../../lib/musicVideoImageEffects.js';

const photoUrl = id => `/data/images/${encodeURIComponent(id)}`;

// #14277: one stacked layer as the render draws it — a laid-out photo fitted whole,
// scaled, turned and faded about its centre; otherwise cover-fitted to the frame.
function photoLayerStyle(layout) {
  if (!layout) return { left: '0%', top: '0%', width: '100%', height: '100%', objectFit: 'cover', transform: 'none', opacity: '1' };
  return {
    left: `${50 + layout.x * 100 - layout.scale * 50}%`, top: `${50 + layout.y * 100 - layout.scale * 50}%`,
    width: `${layout.scale * 100}%`, height: `${layout.scale * 100}%`, objectFit: 'contain',
    transform: layout.rotation ? `rotate(${layout.rotation}deg)` : 'none', opacity: String(layout.opacity),
  };
}

/**
 * A still shot's image effect, as the final render plays it: the still (and,
 * for an end-frame effect, the end frame over it), cover-fitted as the render
 * crops them, with the effect's flash and emulsion laid over and its contrast
 * and colour filtered, all from the same curves the render uses
 * (`imageEffectState`). Stopped it paints the moment at `time` (song seconds);
 * while `playing` it repaints every animation frame from `getTime()`, writing
 * styles directly so its parent does not re-render per frame.
 *
 * A stacked sequence (overlap or per-photo layouts) paints a fixed pool of layers,
 * oldest at the bottom, from `photoSequenceLayers` — the same list the renders
 * compose.
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
    if (sequence?.stacked) {
      const layers = photoSequenceLayers(sequence, t, { fps });
      imgRefs.current.forEach((img, i) => {
        if (!img) return;
        const layer = layers[i];
        img.style.display = layer ? '' : 'none';
        img.dataset.shown = layer && i === layers.length - 1 && state.end < 1 ? 'true' : 'false';
        if (!layer) return;
        const url = photoUrl(sequence.imageIds[layer.index]);
        if (img.getAttribute('src') !== url) img.setAttribute('src', url);
        Object.assign(img.style, photoLayerStyle(layer.layout));
        img.style.filter = `contrast(${state.contrast}) saturate(${state.saturation})`;
      });
    } else {
      const selected = sequence ? photoSequenceIndex(sequence, t, { fps }) : 0;
      imgRefs.current.forEach((img, i) => {
        if (!img) return;
        img.style.filter = `contrast(${state.contrast}) saturate(${state.saturation})`;
        img.style.opacity = i === selected ? '1' : '0';
        img.dataset.shown = i === selected && state.end < 1 ? 'true' : 'false';
      });
    }
    if (endRef.current) {
      endRef.current.style.opacity = String(state.end);
      endRef.current.dataset.shown = state.end >= 1 ? 'true' : 'false';
    }
    if (fogRef.current) fogRef.current.style.opacity = String(state.fog);
    if (flashRef.current) flashRef.current.style.opacity = String(state.flash);
  }, [effect, sequence, startSec, fps]);
  useEffect(() => { paint(time); }, [time, paint]);
  // A stacked layer swaps its source as photos arrive; warm them so a swap never flashes.
  useEffect(() => {
    if (sequence?.stacked) sequence.imageIds.forEach(id => { const im = new Image(); im.src = photoUrl(id); });
  }, [sequence]);
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
    <div className={`relative h-full w-full${sequence?.stacked ? ' overflow-hidden bg-black' : ''}`} data-testid="animatic-image-effect">
      {/* The start frame comes first, so a plain `img` lookup (Save frame) still finds the shot's still. */}
      {sequence?.stacked ? Array.from({ length: photoSequenceMaxLayers(sequence) }, (_, i) => (
        <img key={i} ref={el => { imgRefs.current[i] = el; }} src={photoUrl(sequence.imageIds[0])} alt=""
          data-shown={i === 0 ? 'true' : 'false'} style={{ display: i === 0 ? undefined : 'none' }} className="absolute h-full w-full object-cover" />
      )) : (sequence ? sequence.imageIds.map(photoUrl) : [src]).map((url, i) => (
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
