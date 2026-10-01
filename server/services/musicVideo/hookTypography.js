/**
 * Music Video — hook typography (#9291).
 *
 * The reference analysis (#9289) found hooks carried by type: a repeated line
 * lands word by word on the sung onsets, big and centered, the newest word in
 * the accent color. A lyric line sung two or more times is a hook; its text
 * cue takes the `build` template with its words' onsets.
 */

const isTime = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A line's identity for repeat counting: lowercase letters/digits, single spaces. */
export const hookKey = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** The keys of every lyric line sung two or more times. */
export function hookLines(cues) {
  const counts = new Map();
  for (const cue of Array.isArray(cues) ? cues : []) {
    const k = hookKey(cue?.text);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= 2).map(([k]) => k));
}

/** A lyric cue's aligned word onsets inside [its start, endSec), as `{ w, atSec }` (at most 80). */
export function cueWordOnsets(cue, endSec) {
  return (Array.isArray(cue?.words) ? cue.words : [])
    .filter((w) => w && typeof w.w === 'string' && w.w.trim() && isTime(w.startSec) && w.startSec >= cue.startSec - 0.05 && w.startSec < endSec)
    .slice(0, 80)
    .map((w) => ({ w: w.w.trim().slice(0, 60), atSec: w.startSec }));
}
