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
