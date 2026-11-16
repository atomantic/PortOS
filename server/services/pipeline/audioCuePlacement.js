/**
 * Pure cue -> timeline placement for whole-episode audio (issue #863, step 4).
 * Tiles by COUNT, not rendered `durationSec`: the cue muxer loops + trims each
 * cue to its span, so each beat gets an equal stretch of the ffprobed duration.
 */

// Returns a NEW cue array with `startSec`/`endSec`: N equal stretches, the last
// pinned to end exactly at `totalDurationSec` (> 0).
export function placeCuesOnTimeline(cues, totalDurationSec) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const total = Number(totalDurationSec);
  if (!Number.isFinite(total) || total <= 0) {
    // No usable duration: leave timing null (un-placed); the muxer skips them.
    return cues.map((c) => ({ ...c, startSec: null, endSec: null }));
  }

  // Equal stretch per cue, by count (not rendered durationSec).
  const slice = total / cues.length;
  return cues.map((cue, i) => ({
    ...cue,
    startSec: i * slice,
    // Pin the last end so float accumulation leaves no tail gap.
    endSec: i === cues.length - 1 ? total : (i + 1) * slice,
  }));
}
