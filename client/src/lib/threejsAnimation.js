/**
 * Pure pose evaluator for the declarative clip contract in
 * `server/lib/threejsModel.js`, used by the Three.js Models preview.
 *
 * A clip is data, never code: named sequences carry one part between two
 * authored endpoints inside a bounded window, and the easing is a NAME resolved
 * against `utils/easing`'s curve map. So the pose at time T is a pure function
 * of (clip, T) — the same input gives the same pose whether it arrived from a
 * play loop, a scrub, or a test — and nothing here touches Three.js, the DOM, or
 * a clock.
 *
 * Semantics, chosen so the function stays total and deterministic:
 * - Before a sequence starts, its channel holds `from`; after it ends, `to`.
 *   Between two sequences on the same channel, the earlier one's `to` holds, so
 *   a part never snaps back to its authored pose in a gap.
 * - `visible` is a STEP: `from` for the whole window, `to` the instant the
 *   sequence completes. A boolean has no midpoint, and inventing a fade here
 *   would make playback disagree with the exported factory's data.
 * - A part with no sequence in the clip is absent from the pose entirely, which
 *   every consumer reads as "render exactly what the spec authored".
 *
 * The schema guarantees the invariants this relies on (windows inside the clip,
 * no two sequences on one part+channel at once, every `partId` real), so there
 * is no conflict resolution here to get wrong.
 */

import { EASING_CURVES, linear } from '../utils/easing.js';

/** Channels a sequence may drive, in the order the schema declares them. */
export const THREEJS_CLIP_CHANNELS = ['position', 'rotationDegrees', 'scale', 'opacity', 'visible'];

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

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

const interpolate = (range, progress) => {
  const { from, to } = range;
  if (Array.isArray(from) && Array.isArray(to)) {
    return from.map((value, axis) => value + ((to[axis] - value) * progress));
  }
  return from + ((to - from) * progress);
};

// `from` until the window closes, `to` from that instant on. Used for the one
// channel that cannot be interpolated.
const step = (range, progress) => (progress >= 1 ? range.to : range.from);

const channelValue = (sequence, range, channel, timeSeconds) => {
  const span = sequence.endSeconds - sequence.startSeconds;
  // A zero-length window is unreachable through the schema, which requires
  // `endSeconds > startSeconds`; a hand-repaired record that has one reads as
  // already finished rather than dividing by zero.
  const raw = span > 0 ? (timeSeconds - sequence.startSeconds) / span : 1;
  const progress = clamp01(raw);
  if (channel === 'visible') return step(range, progress);
  const curve = EASING_CURVES[sequence.easing] || linear;
  return interpolate(range, curve(progress));
};

// 2 = this window contains the instant, 1 = it is behind the playhead, 0 = it is
// still ahead. The schema forbids two windows on one part+channel from
// overlapping, so a tie can only happen at a shared endpoint or among windows
// that all sit on the same side of the playhead.
const rankAt = (sequence, time) => {
  if (time >= sequence.startSeconds && time <= sequence.endSeconds) return 2;
  return sequence.endSeconds < time ? 1 : 0;
};

const outranks = (candidate, current, time) => {
  const candidateRank = rankAt(candidate, time);
  const currentRank = rankAt(current, time);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  // Two windows meeting at a shared instant: the one that has just BEGUN wins,
  // so forward playback reads as the handover it is rather than replaying the
  // finished sequence's final frame.
  if (candidateRank === 2) return candidate.startSeconds > current.startSeconds;
  if (candidateRank === 1) return candidate.endSeconds > current.endSeconds;
  return candidate.startSeconds < current.startSeconds;
};

/**
 * Pose for every part a clip drives at an absolute time.
 *
 * @param {object|null} clip a validated clip, or null
 * @param {number} timeSeconds absolute seconds from the clip's start
 * @returns {{timeSeconds: number, pose: object, activeSequenceIds: string[], activePartIds: string[]}}
 *   `pose` is a null-prototype map of partId → `{ position?, rotationDegrees?, scale?, opacity?, visible? }`;
 *   `activeSequenceIds` are the sequences whose window contains the time.
 */
export function evaluateThreejsClipPose(clip, timeSeconds) {
  // Null-prototype: part ids are provider-authored and the id schema accepts
  // `toString`, so a bare lookup on a plain object can hand back a function.
  const pose = Object.create(null);
  const sequences = Array.isArray(clip?.sequences) ? clip.sequences : [];
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const activeSequenceIds = [];
  const activeParts = new Set();

  // Each part+channel is resolved from the ONE sequence that owns the instant:
  // the window containing it, else the most recent window behind it (whose `to`
  // still holds), else the next window ahead (whose `from` has not moved yet).
  // Declaration order decides nothing, so a spec that lists its sequences out of
  // time order evaluates identically.
  const owners = new Map();
  for (const sequence of sequences) {
    for (const channel of THREEJS_CLIP_CHANNELS) {
      const range = sequence.channels?.[channel];
      if (!range) continue;
      const key = `${sequence.partId}|${channel}`;
      const current = owners.get(key);
      if (!current || outranks(sequence, current.sequence, time)) {
        owners.set(key, { sequence, range, channel });
      }
    }
    if (time >= sequence.startSeconds && time <= sequence.endSeconds) {
      activeSequenceIds.push(sequence.id);
      activeParts.add(sequence.partId);
    }
  }
  const activePartIds = [...activeParts];

  for (const { sequence, range, channel } of owners.values()) {
    const partPose = pose[sequence.partId] || (pose[sequence.partId] = {});
    partPose[channel] = channelValue(sequence, range, channel, time);
  }

  return { timeSeconds: time, pose, activeSequenceIds, activePartIds };
}

/**
 * Cues whose sequence starts inside the half-open interval `[fromSeconds,
 * toSeconds)` — what a play loop crossed since its last frame.
 *
 * Half-open on purpose: consecutive frames tile the timeline with no cue fired
 * twice and none skipped, and a cue at 0 fires on the first frame of playback.
 * A scrub calls this never — silence while dragging is the whole reason a cue
 * is an identifier the host maps to its own sound rather than embedded audio.
 *
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
