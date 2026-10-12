import { MUSIC_VIDEO_FRAME_FITS } from '../../lib/musicVideoLayers.js';
import { matchesMusicVideoAspect } from '../../lib/musicVideoAspect.js';

export const FRAME_FIT_LABELS = Object.freeze({
  fill: 'Zoom to fill',
  still: 'Keep ratio, still at the edges',
  vhs: 'Keep ratio, VHS edges',
  black: 'Keep ratio, black bars',
});

/** The shot's frame fit: an unset or unknown value zooms to fill. */
export const sceneFrameFit = (scene) => (MUSIC_VIDEO_FRAME_FITS.includes(scene?.frameFit) ? scene.frameFit : 'fill');

/**
 * How a clip whose shape is not the video's fills the frame, in the final
 * render and the preview. Shown only when the clip's size (read from the
 * player) differs from the video's aspect, or a fit was already picked.
 */
export default function SceneFrameFit({ id, scene, clipSize, aspect = '16:9', onChange, disabled = false }) {
  const fit = sceneFrameFit(scene);
  const offShape = clipSize && !matchesMusicVideoAspect(clipSize.width, clipSize.height, aspect);
  if (!offShape && fit === 'fill') return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <label htmlFor={id} className="text-xs text-port-text-muted">{offShape ? `Not ${aspect}` : 'Frame'}</label>
      <select id={id} value={fit} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className="min-w-0 max-w-full bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50">
        {MUSIC_VIDEO_FRAME_FITS.map((value) => <option key={value} value={value}>{FRAME_FIT_LABELS[value]}</option>)}
      </select>
    </span>
  );
}
