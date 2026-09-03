/**
 * Client mirror of the trigger-word predicates in `server/lib/loraTriggers.js`
 * (issue #4665).
 *
 * The server is the enforcement point — it weaves each selected LoRA's first
 * activation token into the prompt at render time. These two helpers exist so
 * the UI can say the same thing the server will do: which token is missing, and
 * whether a word is already doing its job in the prompt. Keep the matching rules
 * identical to the server module or the picker's hint will contradict the render.
 */

import { escapeRegExp } from './textUtils.js';

// Only the FIRST trigger word of a LoRA activates it, per the server weave —
// Civitai `trainedWords` routinely lists a dozen loosely-related tags.
export const firstTriggerWord = (words) => {
  if (!Array.isArray(words)) return null;
  const first = words.find((w) => typeof w === 'string' && w.trim());
  return first ? first.trim() : null;
};

// What counts as "inside a word" for the boundary assertions below. Unicode
// letters/digits, not just ASCII, so a non-ASCII trigger or an accented prompt
// gets the same treatment — `\b` and a bare `[A-Za-z0-9_]` class would both
// read `aria` as present inside `ariaé` and silently skip the activation token.
const WORD_CLASS = '\\p{L}\\p{N}_';
const WORD_CHAR = new RegExp(`[${WORD_CLASS}]`, 'u');

// Whole-token, case-insensitive presence test, applied anywhere in the prompt
// (Civitai triggers are commonly woven mid-sentence). Boundaries are asserted
// only where the trigger's own edge is a word character, so `aria_tok` does not
// match inside `aria_token` while a punctuation-edged trigger still matches.
export const promptHasTriggerWord = (prompt, word) => {
  const text = typeof prompt === 'string' ? prompt : '';
  const token = typeof word === 'string' ? word.trim() : '';
  if (!text || !token) return false;
  const lead = WORD_CHAR.test(token[0]) ? `(?<![${WORD_CLASS}])` : '';
  const tail = WORD_CHAR.test(token[token.length - 1]) ? `(?![${WORD_CLASS}])` : '';
  return new RegExp(`${lead}${escapeRegExp(token)}${tail}`, 'iu').test(text);
};

/**
 * How a trigger clause attaches to the end of an existing prompt. Mirrors
 * `server/lib/loraTriggers.js#separatorFor` — the button and the server weave
 * MUST agree here, because whichever one lands the token first makes the other
 * a no-op. A single-paragraph prompt gets a comma join; a multi-paragraph one
 * gets its own paragraph, so the token can't be swallowed into a trailing
 * directive (`…\n\nno text, no watermark, aria_tok` reads the activation
 * token as one more thing to avoid).
 */
export const separatorFor = (trimmed) => {
  if (!trimmed) return '';
  if (/\n/.test(trimmed)) return '\n\n';
  return trimmed.endsWith(',') ? ' ' : ', ';
};

/**
 * The "+ trigger" button's append: add a LoRA's trigger words to the prompt,
 * comma-separated, skipping any already present.
 *
 * Unlike the server weave this appends ALL of the LoRA's trigger words — the
 * user clicked a button whose tooltip lists them, so honoring the list is the
 * point. The server only ever adds the first, and never duplicates.
 *
 * `effectivePrompt` is the text presence is judged against, defaulting to the
 * prompt itself. Pass the STYLED/enveloped prompt when the page composes one
 * before submitting: a trigger the style preset already supplies must not be
 * appended again, or the composed prompt carries it twice — and the picker's
 * hint (which reads the same composed text) would disagree with the button.
 */
export const appendTriggerWords = (prompt, words, effectivePrompt = prompt) => {
  const list = (Array.isArray(words) ? words : [])
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.trim());
  if (!list.length) return prompt;
  const haystack = typeof effectivePrompt === 'string' ? effectivePrompt : prompt;
  const fresh = list.filter((w) => !promptHasTriggerWord(haystack, w));
  if (!fresh.length) return prompt;
  const trimmed = String(prompt || '').trim();
  return `${trimmed}${separatorFor(trimmed)}${fresh.join(', ')}`;
};
