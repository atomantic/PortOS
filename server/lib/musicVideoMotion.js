/**
 * Music Video motion-prompt constants shared by the server (handoff.js
 * sceneShotPrompt, the production run) and the client board.
 *
 * An i2v model drifts toward daylight and a new palette over a 5–10 s take
 * when the motion prompt does not pin them (a night rooftop turned overcast
 * mid-shot in a real run), so every motion prompt ends with this clause.
 */
export const MOTION_CONTINUITY_CLAUSE = "hold the reference frame's lighting, time of day and palette for the whole shot";

/** Appended to an audio-reactive (LoRA) shot's prompt so the music moves the scene, never a performer. */
export const AUDIO_REACTIVE_PERFORMANCE_GUARD = 'The music drives only environmental motion, lighting, particles, reflections, fabric, and subtle camera accents. No singing, lip-sync, speaking, mouth movement, dancing, instruments, performers, or musical performance.';

// A song reference a silent i2v model cannot hear: a quoted lyric cue ("on
// 'Sleep'"), a musical event ("on the downbeat", "in time with the snare") or
// a song timestamp ("at 1:42").
// A quoted word is a lyric cue only after a timing preposition ("on 'Sleep'") or when named as one ("before the line 'Go'").
const LYRIC_CUE = /\s*\b(?:(?:on|at|as|when|until)\s+(?:the\s+)?(?:(?:lyric|word|line)\s+)?|(?:with|to|before|after)\s+the\s+(?:lyric|word|line)\s+)["“'‘][^"”'’\n]{1,60}["”'’]/gi;
// Only unambiguous musical words: "bridge", "hook", "drop" and "kick" are also sets and props.
const MUSIC_CUE = /\s*\b(?:on|to|with|in time with|in sync with|synced to|timed to|matching)\s+(?:the|each|every|a)?\s*(?:next\s+|first\s+|final\s+|last\s+)?(?:beats?|downbeats?|backbeats?|snare(?: hits?)?|kick drums?|drum hits?|bass drop|chorus|verse|music|song|rhythm|tempo|lyrics?|vocals?|vocal line|singing)\b/gi;
const SONG_TIMESTAMP = /\s*\b(?:at|around|by|until|from)\s+\d{1,2}:\d{2}(?:\.\d+)?\b/g;
// A look word an i2v model acts out instead of reading as style (falling film for "film grain").
const LOOK_WORD = /\b(?:film grain|grain|grainy|35 ?mm|16 ?mm|super ?8|kodak|eastman|fuji|panavision|anamorphic|lens(?:es)?|bokeh|depth of field|color (?:grade|grading|timing)|colour grad(?:e|ing)|halation|saturation|microcontrast|highlight rolloff|photochemical|film stock|release print|vhs|analog cinematography|vignette|light leaks?|chromatic aberration)\b/i;
// A clause naming a subject is action ("she wipes the camera lens"), never a look clause.
const SUBJECT_WORD = /\b(?:she|he|they|we|i|you|her|his|their|its|it)\b/i;
const isLookClause = (clause) => LOOK_WORD.test(clause) && !SUBJECT_WORD.test(clause) && clause.trim().split(/\s+/).length <= 8;
// Generated intent lines that time the shot to the song.
const SONG_INTENT_LINE = /^(?:Lyric|Word) \d+(?:\.\d+)?s–\d+(?:\.\d+)?s: .*$|^Musical onsets: .*$/;
// Generated shot-intent and camera lines, kept as written.
const CONTRACT_LINE = /^(?:(?:Action|Reaction) \d+(?:\.\d+)?s–|(?:Purpose|Starting emotion|Ending emotion|Active speaker|Camera|Camera movement|Must preserve|Acceptance|Speed|Framing|End):)/;

// The opening of each block musicVideoCreativeContext() writes. A shot prompt the
// board composed from an older copy of the project still carries its bible, which
// the verbatim strip cannot match; the block runs to the clause that follows it.
const CREATIVE_CONTEXT_START = /Character style \(fixed identity|Universe style: |Look \(palette, light and texture only\): |Mood board look \(palette, lighting and texture only|Production bible \(use the subjects/;
const CREATIVE_CONTEXT_END = /\n(?=Camera|Shot intent \(clip-relative seconds\):|(?:Action|Reaction) \d)/;

function withoutCreativeContext(text, ends) {
  let out = text;
  for (let start = out.search(CREATIVE_CONTEXT_START); start >= 0; start = out.search(CREATIVE_CONTEXT_START)) {
    const rest = out.slice(start);
    const stops = [...ends.map((end) => rest.indexOf(end)), rest.search(CREATIVE_CONTEXT_END)].filter((i) => i > 0);
    const length = stops.length ? Math.min(...stops) : rest.length;
    out = `${out.slice(0, start)}${out.slice(start + length)}`;
  }
  return out;
}

const tidy = (text) => text.replace(/\s+([,.;:])/g, '$1').replace(/([,;])\s*(?=[,;.])/g, '').replace(/[ \t]{2,}/g, ' ').replace(/^[,;\s]+|[,;\s]+$/gm, '');

/**
 * A motion prompt rewritten for a video model that sees only its reference
 * frame and hears nothing (local LTX without supplied audio, Grok, Hailuo,
 * Kling and other image-to-video lanes): plain physical motion. Song timing
 * and lyric cues are removed, as are the look clauses (`styleParts` verbatim,
 * then any short subjectless clause naming film stock, grain, lens or grade),
 * since the frame already carries the look and these models act style words
 * out literally. The shot-intent block keeps its clip-relative actions but
 * drops its lyric, word and onset lines. A creative-context block left over
 * (the bible from an older copy of the project) is cut up to the first of
 * `keep`, the continuity clause or the camera and shot-intent lines. An
 * audio-driven or lip-sync take keeps its prompt as authored.
 */
export function silentMotionPrompt(prompt, { styleParts = [], keep = [] } = {}) {
  let text = String(prompt || '');
  for (const part of styleParts) {
    const trimmed = typeof part === 'string' ? part.trim() : '';
    if (trimmed) text = text.split(trimmed).join('');
  }
  const ends = [MOTION_CONTINUITY_CLAUSE, ...keep].map((part) => (typeof part === 'string' ? part.trim() : '')).filter(Boolean);
  return withoutCreativeContext(text, ends).split('\n')
    .filter((line) => !SONG_INTENT_LINE.test(line.trim()))
    .map((line) => {
      if (CONTRACT_LINE.test(line.trim())) return line.replace(/; land the move exactly on the downbeat/, '');
      const stripped = tidy(line.replace(LYRIC_CUE, '').replace(MUSIC_CUE, '').replace(SONG_TIMESTAMP, '')
        .split(/(?<=[,;.!?])/).filter((clause) => !isLookClause(clause)).join(''));
      // Stripping never empties an authored line of its action.
      return stripped.trim() || !line.trim() ? stripped : line;
    })
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
    .join('\n').trim();
}

// Render bookkeeping a video model cannot act on: a leading song span with its length
// ("26.45-28.31s (1.87 s)." or "0:26.4–0:28.3:"), and a trim note ("Use the first ~1.9 s.").
// A span has a decimal, a seconds unit or a m:ss clock, so a leading count ("2-3: two dancers") stays.
const SONG_SPAN_PREFIX = /^\s*(?=[\d:.]*[.:]\d|[\d\s:.–—-]*\ds)(?:\d{1,2}:)?\d+(?:\.\d+)?\s*s?\s*[-–—]\s*(?:\d{1,2}:)?\d+(?:\.\d+)?\s*s?\s*(?:\(\s*~?\d+(?:\.\d+)?\s*s(?:ec(?:onds?)?)?\s*\))?\s*[.:]\s*/;
const TRIM_NOTE = /(^|[.!?;]\s+)(?:Use|Keep)\s+(?:only\s+)?the\s+(?:first|last|opening|final)\s+~?\d+(?:\.\d+)?\s*s(?:ec(?:onds?)?)?\b(?:\s+of\s+(?:the\s+)?(?:clip|take|output|render|shot))?\s*(?:[.!?]|$)/gi;
// "No lip-sync." tells a model that hears nothing to avoid what it cannot do.
const NO_LIP_SYNC = /(^|[.!?;]\s+)No\s+(?:singing\s*(?:,|or)\s*)?lip[- ]?sync(?:ing)?(?:\s*(?:,|or)\s*(?:singing|speaking|talking))?\s*(?:[.!?]|$)/gi;

/**
 * The prompt a video model receives: the authored prompt without render bookkeeping
 * (a leading song span and clip length, a "use the first N s" trim note), and without
 * a "No lip-sync." line when the take hears no audio. Applied at video submit and by
 * the shot card's preview, so the preview shows what is sent.
 */
export function videoModelPrompt(prompt, { hearsAudio = false } = {}) {
  return String(prompt || '').split('\n').map((line) => {
    let text = line.replace(SONG_SPAN_PREFIX, '').replace(TRIM_NOTE, '$1');
    if (!hearsAudio) text = text.replace(NO_LIP_SYNC, '$1');
    return text === line ? line : text.replace(/[ \t]{2,}/g, ' ').trim();
  }).join('\n').trim();
}
