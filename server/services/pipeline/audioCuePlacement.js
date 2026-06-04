/**
 * Pure cue → timeline placement for whole-episode audio (issue #863, step 4).
 *
 * Cues are derived per-arc-beat in story order (audioCues.js) but carry no
 * timeline position — the design defers `startSec`/`endSec` to episode-stitch
 * time, because the only real source of timing is the rendered episode's
 * duration (storyboard scenes carry no per-scene duration, and the VO
 * `offsetSec` is a manually-placed audio offset, not a scene-timing source).
 *
 * This module owns that auto-placement: given the ordered cues and the total
 * episode duration (ffprobed at stitch time), it tiles the cues evenly across
 * the episode end-to-end. The cue muxer loops + trims each cue to the span it's
 * placed at, so a cue's *rendered* `durationSec` is irrelevant to its span —
 * tiling by COUNT (not by rendered length) is correct, and it's what keeps the
 * arc shape: each beat gets an equal stretch rather than collapsing to a short
 * default-duration render with the final cue absorbing the rest. `durationSec`
 * stays render metadata only.
 *
 * Pure + unit-tested — no ffprobe, no filesystem. The caller probes the
 * duration and passes it in.
 */

/**
 * Place an ordered cue list onto a timeline of `totalDurationSec`. Returns a NEW
 * cue array (cues unchanged in identity) with `startSec`/`endSec` filled.
 *
 * Strategy: split the episode into N equal stretches, one per cue, in story
 * order — N = cues.length. The cue muxer loops each cue to fill its stretch, so
 * the placement is purely "how much of the episode does this beat own," not "how
 * long was it rendered." The last cue is pinned to end exactly at
 * `totalDurationSec` so the bed covers the whole episode with no trailing gap
 * from float rounding.
 *
 * @param {Array} cues               ordered cue objects (need at least `id`)
 * @param {number} totalDurationSec  episode length in seconds (> 0)
 * @returns {Array} cues with startSec/endSec set
 */
export function placeCuesOnTimeline(cues, totalDurationSec) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const total = Number(totalDurationSec);
  if (!Number.isFinite(total) || total <= 0) {
    // No usable duration — leave timing null (un-placed); the muxer skips them.
    return cues.map((c) => ({ ...c, startSec: null, endSec: null }));
  }

  // Equal stretch per cue (by count, NOT by rendered durationSec — see header).
  const slice = total / cues.length;
  return cues.map((cue, i) => ({
    ...cue,
    startSec: i * slice,
    // Pin the last cue's end to the exact episode length so float accumulation
    // can't leave a sub-second gap at the tail.
    endSec: i === cues.length - 1 ? total : (i + 1) * slice,
  }));
}
