/**
 * Image Gen — shared "the CLI exited without writing an image" narrator. The model's own
 * words (declines, tool-failure notes) beat a fixed guess, with a provider hint as
 * fallback; one pipeline keeps the two cloud-CLI narrations from drifting.
 */

import { stripAnsi } from '../../lib/ansiStrip.js';

// Structural noise every CLI emits: dashed rules and bare token counts.
const isStructuralNoise = (line) => /^-{2,}$/.test(line) || /^[\d,]+$/.test(line);

// How many trailing narration lines to quote, and the cap on the quote.
const NARRATION_LINES = 4;
const NARRATION_MAX_CHARS = 600;

// opts: `hint` fallback when nothing usable was said, `dropLine` extra per-provider
// filter, `describe` phrases the quoted output.
export function buildNoImageReason(stdoutTail = '', { hint, dropLine, describe }) {
  const clean = stripAnsi(String(stdoutTail)).trim();
  const lines = clean.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isStructuralNoise(l) && !(dropLine?.(l)));
  const said = lines.slice(-NARRATION_LINES).join(' ').slice(-NARRATION_MAX_CHARS);
  return said ? describe(said) : hint;
}

// Frames that decode but have no content (#4173): the verdict is a `reason` from
// `lib/imageFrameStats.js`, not stdout.
const DEGENERATE_FRAME_DETAIL = {
  'solid-fill': 'it is a single flat color',
  'fully-transparent': 'it is fully transparent',
  'near-empty': 'it has almost no detail',
};

export function describeDegenerateFrame(reason) {
  const detail = DEGENERATE_FRAME_DETAIL[reason];
  return detail
    ? `The backend wrote an image with no content — ${detail}. Nothing was saved; try again or switch models.`
    : 'The backend wrote an image with no content. Nothing was saved; try again or switch models.';
}
