/**
 * Time spans of a lyric sheet's sections (`[Verse 1]`, `[Chorus]`, …) once
 * its lines are timed. Browser-safe: shared by the music video analysis
 * relabel (lyricMarkers.js) and the storyboard fit.
 * Markers are `{ type: 'section', label, kind, line }` with `line` the
 * lyric-cue index the section starts at.
 */

const isTime = (value) => typeof value === 'number' && Number.isFinite(value);

// First timed cue at or after `line` and before `stop`.
function firstTimed(cues, line, stop) {
  for (let i = line; i < Math.min(stop, cues.length); i++) if (isTime(cues[i]?.startSec)) return cues[i];
  return null;
}

/** End of the last timed cue in [from, stop) (its start when it has no end); null when none. */
export function lastTimedCueEnd(cues, from, stop) {
  for (let i = Math.min(stop, cues.length) - 1; i >= from; i--) {
    const cue = cues[i];
    if (isTime(cue?.endSec)) return cue.endSec;
    if (isTime(cue?.startSec)) return cue.startSec;
  }
  return null;
}

/**
 * A section runs from its first timed line to the next section's first timed
 * line (the last one to its last timed line). Sections with no timed line are
 * left out.
 */
export function lyricSectionSpans(cues, markers) {
  const list = Array.isArray(cues) ? cues : [];
  const sections = (Array.isArray(markers) ? markers : []).filter((m) => m?.type === 'section');
  const spans = [];
  sections.forEach((section, index) => {
    const stop = index + 1 < sections.length ? sections[index + 1].line : list.length;
    const first = firstTimed(list, section.line, stop);
    if (!first) return;
    spans.push({ label: section.label, kind: section.kind, startSec: first.startSec, stop, line: section.line });
  });
  return spans.map((span, index) => {
    const next = spans[index + 1];
    const endSec = next ? next.startSec : lastTimedCueEnd(list, span.line, span.stop);
    return { label: span.label, kind: span.kind, startSec: span.startSec, endSec: isTime(endSec) && endSec > span.startSec ? endSec : span.startSec };
  }).filter((span) => span.endSec > span.startSec);
}
