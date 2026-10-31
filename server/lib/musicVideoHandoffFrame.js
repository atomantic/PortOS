/**
 * Music Video continuing shots: where the previous shot's clip ends on screen.
 *
 * A clip is usually longer than the shot that plays it (a 5.9 s fal clip under
 * a 4.04 s shot), and the cut stops it at the shot's out-point. A continuing
 * shot must start from the frame the viewer last saw, not from the clip's true
 * last frame, which can be seconds further on. That frame sits at the clip's
 * in-point plus the shot's authored span, using the same rules as the render:
 *  - a performance take starts at its edit in-point and stops at its edit out-point;
 *  - a looping shot wraps around the clip;
 *  - a non-looping shot longer than its clip holds the clip's last frame.
 *  - a shot's clip speed and frame offset move where it ends, and a reversed clip
 *    ends on an earlier frame (its first frame when the shot outlasts it).
 * The returned time is the last displayed frame, one frame before the out-point.
 */
import { isEndFrameImageEffect, scenePhotoSequence, photoSequenceIndex } from './musicVideoImageEffects.js';
import { clipOffsetSec, clipReversed, clipSpeedRate, isLayeredComposition, sceneHasAuthoredSpan, sceneVisualLayer } from './musicVideoLayers.js';
import { selectedPerformanceInstruction } from './musicVideoShotTiming.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Seconds into the scene's clip of the last frame the cut shows, or null when
 * the scene is untimed or the clip length is unknown. `fps` sets the one-frame
 * step back from the out-point (24 when unknown).
 */
export function sceneClipOutFrameSec(scene, clipDurationSec, fps = 24) {
  const duration = Number(clipDurationSec);
  if (!sceneHasAuthoredSpan(scene) || !(duration > 0)) return null;
  const frameSec = 1 / (Number(fps) > 0 ? Number(fps) : 24);
  const span = scene.endSec - scene.startSec;
  const edit = selectedPerformanceInstruction(scene)?.edit ?? null;
  // Mirrors render.js: a hand-set speed reads the clip faster or slower, and an offset starts it
  // later (or, negative, holds its first frame that long first).
  const rate = clipSpeedRate(scene);
  const offset = clipOffsetSec(scene);
  // A reversed clip is read once from its end, so the cut ends on an earlier frame of it.
  if (!edit && clipReversed(scene)) {
    const read = Math.max(0, offset) + Math.max(0, span + Math.min(0, offset)) * rate;
    return round3(Math.min(duration - frameSec, Math.max(0, duration - read + frameSec * rate)));
  }
  const inSec = edit ? Math.min(Math.max(0, edit.inSec), duration) : 0;
  const stopSec = edit ? Math.min(edit.outSec, duration) : duration;
  // Only a pre-#8964 scene (no `loop` key) or `loop: true` repeats, and a performance take never does.
  const loops = !edit && scene.loop !== false;
  const playable = stopSec - inSec;
  if (!(playable > 0)) return round3(inSec);
  const start = Math.max(0, offset);
  const played = start + Math.max(0, span + Math.min(0, offset)) * rate;
  const within = loops && played > playable ? played % playable || playable : Math.min(played, playable);
  return round3(Math.max(inSec, inSec + within - frameSec * rate));
}

/**
 * What the cut shows at the end of `shot`, for the shot after it to start from:
 * `{ imageId }` for a still shot (its end frame when an effect plays to it, else
 * its still), `{ clip: true }` for footage with a clip to read the out-frame
 * from, or null when there is nothing to hand over (a drawn card or code shot,
 * or a missing picture). A still shot's clip, left from before it became a
 * still, is never on screen, so it is never read.
 */
export function shotHandoffSource(project, shot) {
  if (!shot) return null;
  const layer = sceneVisualLayer(shot, { layered: isLayeredComposition(project) });
  if (layer === 'still') {
    const sequence = sceneHasAuthoredSpan(shot) ? scenePhotoSequence(shot, { beats: project.audioAnalysis?.beats || [] }) : null;
    const lastPhoto = sequence?.imageIds[photoSequenceIndex(sequence, (Math.round(shot.endSec * 24) - 1) / 24)];
    const imageId = isEndFrameImageEffect(shot.imageEffect) && shot.endImageId ? shot.endImageId : sequence ? lastPhoto : shot.referenceImageId;
    return imageId ? { imageId } : null;
  }
  return layer === 'footage' && shot.videoHistoryId ? { clip: true } : null;
}

/**
 * The shot that plays immediately before `sceneId` in the cut (by start time),
 * or null for the first shot.
 */
export function previousShot(project, sceneId) {
  const timed = (project?.scenes || [])
    .filter((s) => sceneHasAuthoredSpan(s))
    .sort((a, b) => a.startSec - b.startSec);
  const idx = timed.findIndex((s) => s.sceneId === sceneId);
  return idx > 0 ? timed[idx - 1] : null;
}
