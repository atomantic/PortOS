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

/** The one singer of every voiced line in `[startSec, endSec)`, or null when none or several sing. */
export function singerWithin(cues, startSec, endSec) {
  const voices = new Set(cuesSungWithin(cues, startSec, endSec).map((cue) => cue.voice).filter(Boolean));
  return voices.size === 1 ? [...voices][0] : null;
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

// A phrase ends on a word that closes with a comma, colon, semicolon, dash or
// sentence mark (trailing quotes and brackets allowed), and always at a line end.
const PHRASE_END = /[,;:!?.…—–]["'”’)\]]*$/u;

/**
 * Cut points for a lyric range (#14820): one per sung word (`mode: 'word'`) or
 * one per phrase (`'phrase'`), in song order, each at its first word's onset,
 * with `endSec` where its last word ends (the line's end when that word has none).
 * `words[i]` is the i-th whitespace token of the cue text (timedText.js keeps
 * the two in step), so `{ cueId, wordIndex, wordCount }` names the words.
 * Returns `{ cuts, untimed }`; `untimed` lists selected lines with no word timing.
 */
export function lyricWordCuts(cues, cueIds, mode = 'phrase') {
  const wanted = new Set(cueIds || []);
  const cuts = [];
  const untimed = [];
  for (const cue of Array.isArray(cues) ? cues : []) {
    if (!wanted.has(cue?.id) || !(typeof cue.text === 'string' && cue.text.trim())) continue;
    const words = Array.isArray(cue.words) ? cue.words : [];
    if (!words.length || !words.every((w) => finite(w?.startSec))) { untimed.push(cue.text.trim()); continue; }
    let first = 0;
    words.forEach((word, i) => {
      if (mode !== 'word' && i < words.length - 1 && !PHRASE_END.test(String(word.w || ''))) return;
      cuts.push({ cueId: cue.id, wordIndex: first, wordCount: i - first + 1, startSec: words[first].startSec, endSec: word.endSec ?? cue.endSec ?? null,
        text: words.slice(first, i + 1).map((w) => w.w).join(' ') });
      first = i + 1;
    });
  }
  return { cuts: cuts.sort((a, b) => a.startSec - b.startSec), untimed };
}

/**
 * Where a shot's word anchor (`{ cueId, wordIndex, wordCount }`) is sung now:
 * `{ startSec, text }`, or null when its line, word or timing is gone.
 */
export function lyricAnchorOnset(cues, anchor) {
  const cue = (Array.isArray(cues) ? cues : []).find((c) => c?.id === anchor?.cueId);
  const words = Array.isArray(cue?.words) ? cue.words : [];
  const count = anchor?.wordCount || 1;
  const picked = words.slice(anchor?.wordIndex ?? 0, (anchor?.wordIndex ?? 0) + count);
  if (!Number.isInteger(anchor?.wordIndex) || picked.length !== count || !finite(picked[0]?.startSec)) return null;
  return { startSec: picked[0].startSec, text: picked.map((w) => w.w).join(' ') };
}

/**
 * Deterministic spelling-based mouth cues, not a pronunciation dictionary.
 * `words` reuses a caller's selected lyric tokens; all holds use clip time.
 * Unsupported scripts and tokens without increasing finite times are skipped.
 */
export function phoneticLipSyncSummary(cues, startSec, endSec, { words, offsetSec = 0 } = {}) {
  const timed = (words ?? (Array.isArray(cues) ? cues : []).flatMap((cue) => Array.isArray(cue?.words) ? cue.words : []))
    .filter((word) => finite(word?.startSec) && finite(word?.endSec) && word.endSec > word.startSec
      && word.startSec < endSec && word.endSec > startSec && typeof word.w === 'string')
    .map((word) => ({ ...word, spelling: word.w.normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '').toLowerCase() }))
    .filter((word) => /^[a-z]+(?:['’-][a-z]+)*$/.test(word.spelling));
  if (!timed.length) return null;
  const distinct = (selected) => [...new Set(selected.map((word) => word.w))].map((word) => JSON.stringify(word)).join(', ');
  // Exclude common silent consonants and treat PH as F; pronunciation still wins.
  const seals = timed.filter((word) => /[bpm]/.test(word.spelling.replace(/ph/g, 'f').replace(/b(?=t)/g, '').replace(/^p(?=[snt])/, '')));
  const contacts = timed.filter((word) => /[fv]|ph/.test(word.spelling));
  const holds = timed.filter((word) => word.endSec - word.startSec >= 0.45 - 1e-6 && /[aeiouy]/.test(word.spelling));
  const time = (sec) => `${(sec - startSec + offsetSec).toFixed(3)}s`;
  const lines = [
    seals.length ? `Lip-seal closures (P/B/M — when pronounced, press both lips fully shut before releasing) on: ${distinct(seals)}.` : '',
    contacts.length ? `Teeth-on-lip contacts (F/V — when pronounced, upper teeth touch the lower lip) on: ${distinct(contacts)}.` : '',
    holds.length ? `Sustained vowel holds (hold the vowel mouth shape open, without chattering or dropping half-shut): ${holds.map((word) => `${JSON.stringify(word.w)} ${time(Math.max(startSec, word.startSec))}–${time(Math.min(endSec, word.endSec))}`).join(', ')}.` : '',
  ];
  return lines.filter(Boolean).join('\n') || null;
}
