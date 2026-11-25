/**
 * Pure pose evaluator for the declarative clip contract in `server/lib/threejsModel.js`, used by the Three.js Models preview.
 *
 * A clip is data, never code: named sequences carry one part between two authored endpoints inside a bounded window, with the easing a NAME resolved against a fixed curve map. The pose at time T is a pure
 * function of (clip, T), the same from a play loop, a scrub or a test, and nothing here touches Three.js, the DOM or a clock.
 * Semantics (total and deterministic):
 * - Before a sequence starts its channel holds `from`; after it ends, `to`. Between two sequences on one channel the earlier `to` holds, so a part never snaps back in a gap.
 * - `visible` is a STEP (`from` for the whole window, `to` once the sequence completes): a boolean has no midpoint and a fade would make playback disagree with the exported factory's data.
 * - A part with no sequence in the clip is absent from the pose, which consumers read as "render what the spec authored".
 * The schema guarantees the invariants (windows inside the clip, no two sequences on one part+channel at once, every `partId` real), so there is no conflict resolution here.
 * The pose comes from `server/lib/threejsModelClipPose.js`, the evaluator the server's physical audit measures, so audit and preview cannot disagree. Its semantics are MIRRORED by the player emitted into an exported
 * factory (`server/lib/threejsModelPlayerSource.js`), pinned by `threejsModelClipPose.test.js`: change one and change the other.
 */

import { evaluateThreejsModelClipPose } from '../../../server/lib/threejsModelClipPose.js';

/** Declared clips for a spec, or `[]` for a static assembly. */
export const listThreejsClips = (spec) => (Array.isArray(spec?.animation?.clips) ? spec.animation.clips : []);

/** Declared sound cues for a spec, or `[]`. Data identifiers — never audio. */
export const listThreejsCues = (spec) => (Array.isArray(spec?.animation?.cues) ? spec.animation.cues : []);

/**
 * The clip a URL/selection names, or the first declared clip when it names none
 * or one this spec does not have. Returns null for a static assembly, so a
 * caller can gate the whole transport on a single check.
 */
export function resolveThreejsClip(spec, clipId) {
  const clips = listThreejsClips(spec);
  if (clips.length === 0) return null;
  return clips.find((clip) => clip.id === clipId) || clips[0];
}

/** Authored duration of a clip — the window, not the last sequence's end. */
export const getThreejsClipDuration = (clip) => (Number.isFinite(clip?.durationSeconds) ? clip.durationSeconds : 0);

/**
 * Pose for every part a clip drives at an absolute time.
 * @param {object|null} clip a validated clip, or null
 * @param {number} timeSeconds absolute seconds from the clip's start
 * @returns {{timeSeconds: number, pose: object, activeSequenceIds: string[], activePartIds: string[]}}
 *   `pose` is a null-prototype map of partId → `{ position?, rotationDegrees?, scale?, opacity?, visible? }`;
 *   `activeSequenceIds` are the sequences whose window contains the time.
 */
export function evaluateThreejsClipPose(clip, timeSeconds) {
  const sequences = Array.isArray(clip?.sequences) ? clip.sequences : [];
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const active = sequences.filter((sequence) => time >= sequence.startSeconds && time <= sequence.endSeconds);
  return {
    timeSeconds: time,
    pose: evaluateThreejsModelClipPose(clip, time),
    activeSequenceIds: active.map((sequence) => sequence.id),
    activePartIds: [...new Set(active.map((sequence) => sequence.partId))],
  };
}

/**
 * Cues whose sequence starts inside the half-open interval `[fromSeconds, toSeconds)`, i.e. what a play loop crossed since its last frame: consecutive frames tile the timeline with no cue fired twice or skipped,
 * and a cue at 0 fires on the first frame. A scrub never calls this: silence while dragging is why a cue is an identifier the host maps to its own sound.
 * @returns {Array<{cueId: string, sequenceId: string, partId: string, atSeconds: number}>}
 */
export function collectThreejsCues(clip, fromSeconds, toSeconds) {
  if (!(toSeconds > fromSeconds)) return [];
  return (Array.isArray(clip?.sequences) ? clip.sequences : [])
    .filter((sequence) => sequence.cueId
      && sequence.startSeconds >= fromSeconds
      && sequence.startSeconds < toSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((sequence) => ({
      cueId: sequence.cueId,
      sequenceId: sequence.id,
      partId: sequence.partId,
      atSeconds: sequence.startSeconds,
    }));
}
