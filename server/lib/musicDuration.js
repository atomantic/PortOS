// The authoritative copy, re-exported by `client/src/lib/musicDuration.js`
// (keep it pure: no Node built-in, nothing outside `server/lib`). MiniMax Music 3
// treats audio_duration as a ceiling, so auto mode sizes that ceiling from the
// lyric structure and leaves room for the composition to resolve.

import { countWords } from './textUtils.js';

export const MINIMAX_AUTO_MIN_DURATION_SEC = 60;
export const MINIMAX_AUTO_MAX_DURATION_SEC = 300;
export const MINIMAX_AUTO_DURATION_STEP_SEC = 10;

const SECONDS_PER_WORD = 0.5;
const SECONDS_PER_LINE_BREAK = 0.25;
const SECONDS_PER_SECTION_BREAK = 3;
const ENDING_CUSHION_SEC = 20;
const SAFETY_MULTIPLIER = 1.2;

function boundedNumber(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function roundUp(value, step) {
  return Math.ceil(value / step) * step;
}

/**
 * Analyze structured song lyrics without changing the user's text. The
 * returned estimate may exceed the engine maximum so callers can surface a
 * truthful "lyrics may still be too long" warning.
 */
export function analyzeMusicLyrics(lyrics, options = {}) {
  const minDurationSec = boundedNumber(options.minDurationSec, MINIMAX_AUTO_MIN_DURATION_SEC);
  const maxDurationSec = Math.max(minDurationSec, boundedNumber(options.maxDurationSec, MINIMAX_AUTO_MAX_DURATION_SEC));
  const lines = typeof lyrics === 'string' ? lyrics.split(/\r?\n/) : [];
  const contentLines = [];
  let sectionCount = 0;
  let hasOutro = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const tagged = line.match(/^\[([^\]\r\n]+)\]\s*(.*)$/);
    if (tagged) {
      sectionCount += 1;
      if (/^outro\b/i.test(tagged[1].trim())) hasOutro = true;
      if (tagged[2].trim()) contentLines.push(tagged[2].trim());
      continue;
    }
    contentLines.push(line);
  }

  const wordCount = countWords(contentLines.join('\n'));
  const contentLineCount = contentLines.length;
  const effectiveSectionCount = Math.max(1, sectionCount);
  const hasLyrics = wordCount > 0;
  const estimatedDurationSec = hasLyrics
    ? Math.ceil((
      wordCount * SECONDS_PER_WORD
      + Math.max(0, contentLineCount - 1) * SECONDS_PER_LINE_BREAK
      + Math.max(0, effectiveSectionCount - 1) * SECONDS_PER_SECTION_BREAK
      + ENDING_CUSHION_SEC
    ) * SAFETY_MULTIPLIER)
    : minDurationSec;
  const suggestedDurationSec = Math.max(
    minDurationSec,
    Math.min(maxDurationSec, roundUp(estimatedDurationSec, MINIMAX_AUTO_DURATION_STEP_SEC)),
  );

  return {
    hasLyrics,
    wordCount,
    contentLineCount,
    sectionCount,
    hasOutro,
    estimatedDurationSec,
    suggestedDurationSec,
    isCapped: hasLyrics && estimatedDurationSec > maxDurationSec,
  };
}

export function recommendMinimaxDurationSec(lyrics, options = {}) {
  return analyzeMusicLyrics(lyrics, options).suggestedDurationSec;
}
