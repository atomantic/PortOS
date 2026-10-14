import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import ImageEffectStill from './ImageEffectStill.jsx';
import { sceneImageEffect } from '../../lib/musicVideoImageEffects.js';

// A shot with no span still previews its effect over this long.
const FALLBACK_SPAN_SEC = 4;

/**
 * What a still shot shows in a composed render, in the shot card's Clip
 * column instead of its old clip: the still alone, or the still playing its
 * image effect, looped over the shot's length with a play/pause toggle.
 */
export default function ScenePicturePreview({ scene }) {
  const effect = sceneImageEffect(scene, { layered: true });
  const spanSec = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
    ? scene.endSec - scene.startSec : FALLBACK_SPAN_SEC;
  const [playing, setPlaying] = useState(true);
  const [pausedAt, setPausedAt] = useState(0);
  const startedAt = useRef(0);
  // Time into the shot, looping over its span.
  const getTime = useCallback(() => ((performance.now() - startedAt.current) / 1000) % spanSec, [spanSec]);
  useEffect(() => {
    if (playing) startedAt.current = performance.now() - pausedAt * 1000;
    // Restart the loop when the effect or its timing changes.
  }, [playing, pausedAt, effect?.effect, effect?.developSec, effect?.changeSec]);
  const toggle = () => {
    if (playing) setPausedAt(getTime());
    setPlaying((on) => !on);
  };
  if (!scene.referenceImageId) {
    return <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-port-border text-xs text-port-text-muted">No still yet</div>;
  }
  const src = `/data/images/${scene.referenceImageId}`;
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black" data-testid="scene-picture-preview">
      {effect ? (
        <>
          <ImageEffectStill src={src} endSrc={scene.endImageId ? `/data/images/${scene.endImageId}` : null} effect={effect}
            startSec={0} time={pausedAt} playing={playing} getTime={getTime} />
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause effect preview' : 'Play effect preview'}
            className="port-media-overlay port-media-overlay-item absolute bottom-1 left-1 flex min-h-[44px] min-w-[44px] items-center justify-center rounded sm:min-h-0 sm:min-w-0 sm:p-1.5">
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </>
      ) : (
        <img src={src} alt="" className="h-full w-full object-cover" />
      )}
    </div>
  );
}
