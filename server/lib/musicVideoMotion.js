/**
 * Music Video motion-prompt constants shared by the server (handoff.js
 * sceneShotPrompt, the production run) and the client board.
 *
 * An i2v model drifts toward daylight and a new palette over a 5–10 s take
 * when the motion prompt does not pin them (a night rooftop turned overcast
 * mid-shot in a real run), so every motion prompt ends with this clause.
 */
export const MOTION_CONTINUITY_CLAUSE = "hold the reference frame's lighting, time of day and palette for the whole shot";

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

const tidy = (text) => text.replace(/\s+([,.;:])/g, '$1').replace(/([,;])\s*(?=[,;.])/g, '').replace(/[ \t]{2,}/g, ' ').replace(/^[,;\s]+|[,;\s]+$/gm, '');

/**
 * A motion prompt rewritten for a video model that sees only its reference
 * frame and hears nothing (local LTX without supplied audio, Grok, Hailuo,
 * Kling and other image-to-video lanes): plain physical motion. Song timing
 * and lyric cues are removed, as are the look clauses (`styleParts` verbatim,
 * then any short subjectless clause naming film stock, grain, lens or grade),
 * since the frame already carries the look and these models act style words
 * out literally. The shot-intent block keeps its clip-relative actions but
 * drops its lyric, word and onset lines. An audio-driven or lip-sync take keeps
 * its prompt as authored.
 */
export function silentMotionPrompt(prompt, { styleParts = [] } = {}) {
  let text = String(prompt || '');
  for (const part of styleParts) {
    const trimmed = typeof part === 'string' ? part.trim() : '';
    if (trimmed) text = text.split(trimmed).join('');
  }
  return text.split('\n')
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
