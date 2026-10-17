/**
 * Which timed lyric lines a shot's span anchors. A line counts from its first
 * sung word to its last when it has word timing (#9074), not from its line
 * window: lyric alignment opens each line where the line before it ended, so
 * an instrumental gap before a line would otherwise tie the shots in that gap
 * to a lyric nobody sings over them. A line without words keeps its window.
 */
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** `{ startSec, endSec }` of the singing in a cue, or null when it is untimed. */
function sungCueSpan(cue) {
  const words = Array.isArray(cue?.words) ? cue.words.filter((w) => finite(w?.startSec) && finite(w?.endSec)) : [];
  if (words.length) return { startSec: Math.min(...words.map((w) => w.startSec)), endSec: Math.max(...words.map((w) => w.endSec)) };
  return finite(cue?.startSec) && finite(cue?.endSec) ? { startSec: cue.startSec, endSec: cue.endSec } : null;
}

/** The cues whose singing overlaps `[startSec, endSec)`, in song order. */
export function cuesSungWithin(cues, startSec, endSec) {
  return (Array.isArray(cues) ? cues : []).filter((cue) => {
    const span = sungCueSpan(cue);
    return span && span.startSec < endSec && span.endSec > startSec;
  });
}

/** The sung lines shown on a shot, or null when its span contains no lyric. */
export function sungLyricTextWithin(cues, startSec, endSec) {
  const sung = new Set(cuesSungWithin(cues, startSec, endSec));
  const lines = (Array.isArray(cues) ? cues : [])
    .filter((cue) => {
      if (sung.has(cue)) return true;
      // Legacy start-only lines still label their split piece. They have no
      // positive-duration span to anchor; valid word timing always takes priority.
      const wordTimed = Array.isArray(cue?.words) && cue.words.some((word) => finite(word?.startSec) && finite(word?.endSec));
      return !wordTimed && finite(cue?.startSec) && cue.endSec == null
        && cue.startSec < endSec - 1e-6 && cue.startSec >= startSec - 1e-6;
    })
    .map((cue) => (typeof cue.text === 'string' ? cue.text.trim() : ''))
    .filter(Boolean);
  return lines.length ? lines.join(' / ').slice(0, 2000) : null;
}
