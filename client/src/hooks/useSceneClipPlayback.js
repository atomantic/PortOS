import { useEffect, useRef, useState } from 'react';
import { useVideoFileSrc } from './useVideoFileSrc.js';
import { clipCanLoop, clipLoops, clipNeedsMoreFootage, clipPlaybackWindow, clipSpeedRate, sceneUsesAuthoredTiming, sharedTakeExtraSec } from '../lib/musicVideoLayers.js';
import { selectedPerformanceInstruction } from '../lib/musicVideoShotTiming.js';
import { resolveSourceTake, scenePlayableClipId, sourceClipNeedSec } from '../../../server/lib/musicVideoSourceTake.js';

/** A shot's native clip metadata and render-adjusted coverage (counting later shots that reuse its take via `scenes`). Keep mounted with the card. */
export default function useSceneClipPlayback(scene, scenes = null) {
  const clipPlayerRef = useRef(null);
  const resolved = resolveSourceTake(scene, scenes);
  const clipId = scenePlayableClipId(scene, scenes);
  // Imported .mov/.webm files keep their container. Preserve the historical
  // fallback while the existing filename lookup is in flight or has failed.
  const clipFile = useVideoFileSrc(clipId, { enabled: !!clipId });
  const clipSrc = clipId
    ? (clipFile.src || `/data/videos/${clipId}.mp4`)
    : null;
  // Key measurements to their source so replacing a clip invalidates them
  // immediately, even when the native preview is currently hidden.
  const [clipMeta, setClipMeta] = useState(null);
  const clipSec = clipMeta && clipMeta.id === clipId ? clipMeta.sec : null;
  const clipSize = clipMeta && clipMeta.id === clipId && clipMeta.width > 0 ? { width: clipMeta.width, height: clipMeta.height } : null;
  const edit = resolved ? { inSec: resolved.inSec, outSec: resolved.outSec } : selectedPerformanceInstruction(scene)?.edit;
  const canLoop = clipCanLoop(scene, edit);
  const loops = clipLoops(scene, edit);
  const spanSec = sceneUsesAuthoredTiming(scene) && typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
    ? scene.endSec - scene.startSec
    : null;
  const need = sourceClipNeedSec(scene, scenes);
  const spanExtraSec = Math.max(
    sharedTakeExtraSec(scene, scenes),
    need != null && spanSec != null ? Math.max(0, need - spanSec) : 0,
  );
  const clipRate = clipSpeedRate(scene);
  const playedSec = clipSec != null ? clipPlaybackWindow(scene, edit, clipSec).sourceSec : null;
  const underCovered = clipNeedsMoreFootage({ loop: loops, holdLastFrame: scene.holdLastFrame, spanSec: spanSec != null ? spanSec + spanExtraSec : null, clipSec: playedSec });
  useEffect(() => { if (clipPlayerRef.current) clipPlayerRef.current.playbackRate = clipRate; }, [clipRate]);

  const onLoadedMetadata = (e) => {
    e.currentTarget.playbackRate = clipRate;
    const sec = e.currentTarget.duration;
    const { videoWidth: width, videoHeight: height } = e.currentTarget;
    if (Number.isFinite(sec) && sec > 0) setClipMeta({ id: clipId, sec, width, height });
  };

  return { clipPlayerRef, clipId, clipSrc, clipSec, clipSize, canLoop, loops, spanSec, spanExtraSec, playedSec, underCovered, onLoadedMetadata };
}
