/**
 * `planThreejsClipPoseSamples(clips)` plans which clip times the Three.js model gates measure, and `getThreejsClipPoseState` resolves a part's pose at one of them.
 *
 * The physical audit (attachments held mid-motion) and the penetration gate
 * (parts passing through each other mid-motion) walk the SAME poses, so a time
 * one of them reports is a time the other measured too. The plan lives here so
 * the two cannot drift into sampling different moments of the same clip.
 *
 * Boundaries alone miss motion that leaves and comes back inside one window — an
 * arm turned through 360° is back at rest at both ends — so each sequence also
 * contributes interior samples. The budget is dealt round-robin across clips, so
 * a sequence-heavy first clip cannot starve a later one, and every sample that
 * does not fit is reported rather than dropped.
 */

import { evaluateThreejsModelClipPose } from './threejsModelClipPose.js';

// Clip poses measured per gate run, shared by every clip. 48 keeps the walk
// bounded (12 clips is the schema maximum, four poses each) while covering a
// typical model completely.
export const MAX_CLIP_AUDIT_POSES = 48;
// A rotating sequence gets one interior sample per this many degrees of turn,
// up to MAX_INTERIOR_SEGMENTS segments; every sequence gets at least its midpoint.
const MAX_ROTATION_STEP_DEGREES = 90;
const MAX_INTERIOR_SEGMENTS = 8;
// Omitted times are listed for the reader up to this many per clip; the count
// is always exact.
export const MAX_LISTED_OMITTED_TIMES = 24;

const roundTime = (value) => Number(value.toFixed(4));

const sequenceSegments = (sequence) => {
  const range = sequence.channels?.rotationDegrees;
  const turn = range && Array.isArray(range.from) && Array.isArray(range.to)
    ? Math.max(...range.from.map((value, axis) => Math.abs((range.to[axis] ?? value) - value)))
    : 0;
  return Math.min(MAX_INTERIOR_SEGMENTS, Math.max(2, Math.ceil(turn / MAX_ROTATION_STEP_DEGREES)));
};

/**
 * Every pose time worth measuring in one clip, highest priority first: the clip
 * boundaries, then each sequence's midpoint, then sequence boundaries, then the
 * extra subdivisions of large rotations. Priority only matters when the budget
 * runs out, and then it decides which poses are reported as omitted.
 */
const planClipSampleTimes = (clip) => {
  const sequences = (Array.isArray(clip.sequences) ? clip.sequences : [])
    .filter((sequence) => Number.isFinite(sequence.startSeconds) && Number.isFinite(sequence.endSeconds))
    .sort((a, b) => (a.startSeconds - b.startSeconds) || (a.endSeconds - b.endSeconds));
  const tiers = [
    [0, Number.isFinite(clip.durationSeconds) ? clip.durationSeconds : 0],
    sequences.map((sequence) => (sequence.startSeconds + sequence.endSeconds) / 2),
    sequences.flatMap((sequence) => [sequence.startSeconds, sequence.endSeconds]),
    sequences.flatMap((sequence) => {
      const segments = sequenceSegments(sequence);
      const span = sequence.endSeconds - sequence.startSeconds;
      return Array.from({ length: segments - 1 }, (_, index) => sequence.startSeconds + ((span * (index + 1)) / segments));
    }),
  ];
  const ordered = [];
  const seen = new Set();
  for (const time of tiers.flat()) {
    const rounded = roundTime(time);
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    ordered.push(rounded);
  }
  return ordered;
};

// Round-robin, in clip declaration order: deterministic, and no clip gets a
// second pose until every clip with candidates left has had another one.
const allocateClipPoseBudget = (candidateLists, budget) => {
  const quotas = candidateLists.map(() => 0);
  let remaining = budget;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    candidateLists.forEach((candidates, index) => {
      if (remaining <= 0 || quotas[index] >= candidates.length) return;
      quotas[index] += 1;
      remaining -= 1;
      progressed = true;
    });
  }
  return quotas;
};

/**
 * @param {Array<object>} clips validated clips in declaration order
 * @returns {Array<{clip: object, candidates: number[], timesToTest: number[], omittedTimes: number[]}>}
 *   `timesToTest` ascending within the budget; `omittedTimes` ascending and COMPLETE
 *   (callers cap what they print, never what they count).
 */
export function planThreejsClipPoseSamples(clips) {
  const candidateTimes = clips.map(planClipSampleTimes);
  const quotas = allocateClipPoseBudget(candidateTimes, MAX_CLIP_AUDIT_POSES);
  return clips.map((clip, index) => {
    const candidates = candidateTimes[index];
    return {
      clip,
      candidates,
      timesToTest: candidates.slice(0, quotas[index]).sort((a, b) => a - b),
      omittedTimes: candidates.slice(quotas[index]).sort((a, b) => a - b),
    };
  });
}

/**
 * Resolver from a spec part to the state it holds in `clip` at `timeSeconds`.
 * It is the pose the preview and the exported player show
 * (`threejsModelClipPose.js`); a part no sequence drives keeps its authored pose.
 */
export function getThreejsClipPoseState(clip, timeSeconds) {
  const pose = evaluateThreejsModelClipPose(clip, timeSeconds);
  return (part) => {
    const driven = pose[part.id] || {};
    return {
      position: driven.position ?? part.position ?? [0, 0, 0],
      rotationDegrees: driven.rotationDegrees ?? part.rotationDegrees ?? [0, 0, 0],
      scale: driven.scale ?? part.scale ?? [1, 1, 1],
      visible: driven.visible ?? (part.visible !== false),
      opacity: driven.opacity ?? part.opacity ?? 1,
    };
  };
}
