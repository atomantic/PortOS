import { useEffect, useRef, useState } from 'react';
import { useVideoFileSrc } from './useVideoFileSrc.js';
import { clipCanLoop, clipLoops, clipNeedsMoreFootage, clipPlaybackWindow, clipSpeedRate, sceneUsesAuthoredTiming } from '../lib/musicVideoLayers.js';
import { selectedPerformanceInstruction } from '../lib/musicVideoShotTiming.js';

/** A shot's native clip metadata and render-adjusted coverage. Keep mounted with the card. */
export default function useSceneClipPlayback(scene) {
  const clipPlayerRef = useRef(null);
  // Imported .mov/.webm files keep their container. Preserve the historical
  // fallback while the existing filename lookup is in flight or has failed.
  const clipFile = useVideoFileSrc(scene.videoHistoryId, { enabled: !!scene.videoHistoryId });
  const clipSrc = scene.videoHistoryId
    ? (clipFile.src || `/data/videos/${scene.videoHistoryId}.mp4`)
    : null;
  // Key measurements to their source so replacing a clip invalidates them
  // immediately, even when the native preview is currently hidden.
  const [clipMeta, setClipMeta] = useState(null);
  const clipSec = clipMeta && clipMeta.id === scene.videoHistoryId ? clipMeta.sec : null;
  const clipSize = clipMeta && clipMeta.id === scene.videoHistoryId && clipMeta.width > 0 ? { width: clipMeta.width, height: clipMeta.height } : null;
  const edit = selectedPerformanceInstruction(scene)?.edit;
  const canLoop = clipCanLoop(scene, edit);
  const loops = clipLoops(scene, edit);
  const spanSec = sceneUsesAuthoredTiming(scene) && typeof scene.startSec === 'number' && typeof scene.endSec === 'number'
    ? scene.endSec - scene.startSec
    : null;
  const clipRate = clipSpeedRate(scene);
  const playedSec = clipSec != null ? clipPlaybackWindow(scene, edit, clipSec).sourceSec : null;
  const underCovered = clipNeedsMoreFootage({ loop: loops, holdLastFrame: scene.holdLastFrame, spanSec, clipSec: playedSec });
  useEffect(() => { if (clipPlayerRef.current) clipPlayerRef.current.playbackRate = clipRate; }, [clipRate]);

  const onLoadedMetadata = (e) => {
    e.currentTarget.playbackRate = clipRate;
    const sec = e.currentTarget.duration;
    const { videoWidth: width, videoHeight: height } = e.currentTarget;
    if (Number.isFinite(sec) && sec > 0) setClipMeta({ id: scene.videoHistoryId, sec, width, height });
  };

  return { clipPlayerRef, clipSrc, clipSec, clipSize, canLoop, loops, spanSec, playedSec, underCovered, onLoadedMetadata };
}
