/**
 * Image Gen — shared "the CLI exited without writing an image" narrator.
 *
 * Both cloud-CLI providers finish the same way when no PNG lands: they hold a
 * rolling tail of the child's stdout narration and have to turn it into the
 * most useful error they can — the model's own words (content declines,
 * tool-failure notes) beat a fixed guess, with a provider-specific enablement
 * hint as the fallback when it said nothing usable.
 *
 * `buildNoImageReason` owns that pipeline (strip ANSI → drop structural noise →
 * keep the last few narration lines → cap length) so the two error narrations
 * can't drift; each provider supplies only what actually differs: its own
 * structural line filter, its fallback hint, and how it phrases the result.
 */

import { stripAnsi } from '../../lib/ansiStrip.js';

// Structural noise every CLI emits: dashed rules and bare token counts.
const isStructuralNoise = (line) => /^-{2,}$/.test(line) || /^[\d,]+$/.test(line);

// How many trailing narration lines to quote, and the cap on the quote.
const NARRATION_LINES = 4;
const NARRATION_MAX_CHARS = 600;

/**
 * @param {string} stdoutTail  rolling tail of the child's stdout
 * @param {object} opts
 * @param {string} opts.hint       fallback message when nothing usable was said
 * @param {(line: string) => boolean} [opts.dropLine]  extra per-provider filter
 * @param {(said: string) => string} opts.describe     phrase the quoted output
 */
export function buildNoImageReason(stdoutTail = '', { hint, dropLine, describe }) {
  const clean = stripAnsi(String(stdoutTail)).trim();
  const lines = clean.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isStructuralNoise(l) && !(dropLine?.(l)));
  const said = lines.slice(-NARRATION_LINES).join(' ').slice(-NARRATION_MAX_CHARS);
  return said ? describe(said) : hint;
}
