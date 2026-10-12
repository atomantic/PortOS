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
const LYRIC_CUE = /\s*\b(?:on|at|with|as|when|until|before|after|to)\s+(?:the\s+)?(?:(?:lyric|word|line)\s+)?["“'‘][^"”'’\n]{1,60}["”'’]/gi;
const MUSIC_CUE = /\s*\b(?:on|to|with|in time with|in sync with|synced to|timed to|matching)\s+(?:the|each|every|a)?\s*(?:next\s+|first\s+|final\s+|last\s+)?(?:beats?|downbeats?|backbeats?|snare(?: hits?)?|kick(?: drums?)?|drum(?: hits?|s)?|bass drop|drop|hooks?|chorus|verse|bridge|music|song|rhythm|tempo|lyrics?|vocals?|vocal line|singing)\b/gi;
const SONG_TIMESTAMP = /\s*\b(?:at|around|by|until|from)\s+\d{1,2}:\d{2}(?:\.\d+)?\b/g;
// A look word an i2v model acts out instead of reading as style (falling film for "film grain").
const LOOK_SEGMENT = /\b(?:film grain|grain|grainy|35 ?mm|16 ?mm|super ?8|kodak|eastman|fuji|panavision|anamorphic|lens(?:es)?|bokeh|depth of field|color (?:grade|grading|timing)|colour grad(?:e|ing)|halation|saturation|microcontrast|highlight rolloff|photochemical|film stock|release print|vhs|analog cinematography|vignette|light leaks?|chromatic aberration)\b/i;
// Generated intent lines that time the shot to the song.
const SONG_INTENT_LINE = /^(?:Lyric|Word) \d+(?:\.\d+)?s–\d+(?:\.\d+)?s: .*$|^Musical onsets: .*$/;

const tidy = (text) => text.replace(/\s+([,.;:])/g, '$1').replace(/([,;])\s*(?=[,;.])/g, '').replace(/[ \t]{2,}/g, ' ').replace(/^[,;\s]+|[,;\s]+$/gm, '');

/**
 * A motion prompt rewritten for a video model that sees only its reference
 * frame and hears nothing (local LTX without supplied audio, Grok, Hailuo,
 * Kling and other image-to-video lanes): plain physical motion. Song timing
 * and lyric cues are removed, as are the look clauses (`styleParts` verbatim,
 * then any comma or semicolon clause naming film stock, grain, lens or grade),
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
    .map((line) => (/^(?:Action|Reaction|Purpose|Starting emotion|Ending emotion|Active speaker|Camera|Must preserve|Acceptance|Speed|Framing|End)\b/.test(line.trim()) ? line.replace(/; land the move exactly on the downbeat/, '')
      : tidy(line.replace(LYRIC_CUE, '').replace(MUSIC_CUE, '').replace(SONG_TIMESTAMP, '')
        .split(/(?<=[,;])/).filter((segment) => !LOOK_SEGMENT.test(segment)).join(''))))
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
    .join('\n').trim();
}
