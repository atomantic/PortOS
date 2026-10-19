/**
 * Pure pose evaluator for the declarative clip contract in `threejsModel.js`,
 * shared by the Three.js Models preview (`client/src/lib/threejsAnimation.js`
 * re-uses it) and the gates that measure a clip mid-motion
 * (`threejsModelPhysicalAudit.js`), so the audit measures the pose the user sees.
 *
 * The semantics MIRROR the player emitted into an exported factory
 * (`threejsModelPlayerSource.js`):
 * per part+channel the owning sequence is the window containing the instant, else
 * the most recent window behind it (its `to` holds), else the next window ahead
 * (its `from` has not moved yet); `visible` is a step that takes `to` only once
 * the window completes; `easeInOut` is smoothstep. The player is a fixed source
 * string that cannot import this module, so `threejsModelClipPose.test.js`
 * executes both against the same clip to keep them from drifting apart.
 */

const CLIP_CHANNELS = ['position', 'rotationDegrees', 'scale', 'opacity', 'visible'];

const EASING_CURVES = Object.freeze({
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => t * t * (3 - (2 * t)),
});

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

const interpolate = ({ from, to }, progress) => (
  Array.isArray(from) && Array.isArray(to)
    ? from.map((value, axis) => value + ((to[axis] - value) * progress))
    : from + ((to - from) * progress)
);

const channelValue = (sequence, range, channel, time) => {
  const span = sequence.endSeconds - sequence.startSeconds;
  const progress = clamp01(span > 0 ? (time - sequence.startSeconds) / span : 1);
  if (channel === 'visible') return progress >= 1 ? range.to : range.from;
  const curve = EASING_CURVES[sequence.easing] || EASING_CURVES.linear;
  return interpolate(range, curve(progress));
};

const rankAt = (sequence, time) => {
  if (time >= sequence.startSeconds && time <= sequence.endSeconds) return 2;
  return sequence.endSeconds < time ? 1 : 0;
};

const outranks = (candidate, current, time) => {
  const candidateRank = rankAt(candidate, time);
  const currentRank = rankAt(current, time);
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidateRank === 2) return candidate.startSeconds > current.startSeconds;
  if (candidateRank === 1) return candidate.endSeconds > current.endSeconds;
  return candidate.startSeconds < current.startSeconds;
};

/**
 * Pose for every part a clip drives at an absolute time.
 *
 * @param {object|null} clip a validated clip, or null
 * @param {number} timeSeconds absolute seconds from the clip's start
 * @returns {object} null-prototype map of partId → `{ position?, rotationDegrees?, scale?, opacity?, visible? }`;
 *   a part no sequence drives is absent, which reads as "the authored pose".
 */
export function evaluateThreejsModelClipPose(clip, timeSeconds) {
  const pose = Object.create(null);
  const sequences = Array.isArray(clip?.sequences) ? clip.sequences : [];
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const owners = new Map();
  for (const sequence of sequences) {
    for (const channel of CLIP_CHANNELS) {
      const range = sequence.channels?.[channel];
      if (!range) continue;
      const key = `${sequence.partId}|${channel}`;
      const current = owners.get(key);
      if (!current || outranks(sequence, current.sequence, time)) {
        owners.set(key, { sequence, range, channel });
      }
    }
  }
  for (const { sequence, range, channel } of owners.values()) {
    const partPose = pose[sequence.partId] || (pose[sequence.partId] = {});
    partPose[channel] = channelValue(sequence, range, channel, time);
  }
  return pose;
}
