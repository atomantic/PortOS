/**
 * LoRA trigger-word weaving (issue #4665).
 *
 * PortOS records each installed LoRA's activation vocabulary at install time
 * (`civitai.js#buildSidecar` → `triggerWords`, `huggingfaceLora.js` → the HF
 * instance prompt, `loraTraining/sidecar.js` → the dataset's trained token),
 * but the manual render paths only ever *displayed* it. A user who ticks a
 * LoRA in the picker and hits Generate got a render that loaded the adapter
 * without ever activating it — the LoRA looked broken.
 *
 * This module is the pure half of the fix: given the user's prompt and the
 * trigger words of the LoRAs selected for THIS render, decide which activation
 * tokens are missing and append them. The render call sites (imageGen/local.js,
 * videoGen/local.js) own the sidecar reads and the provenance stamping.
 */

import { escapeRegExp } from './textUtils.js';

// Only the FIRST trigger word of each LoRA is woven. Civitai's `trainedWords`
// routinely lists a dozen loosely-related tags (style hints, sample-prompt
// fragments); appending all of them would rewrite the render rather than
// activate the adapter. First-word-only matches what `characterLoraResolver.js`
// already treats as the canonical activation token for character LoRAs.
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

/**
 * Whole-token presence test. `\b`-style boundaries are applied only where the
 * trigger word's own edge is a word character, so a token like `aria_tok` does
 * NOT match inside `aria_token` (underscore counts as a word char, which is
 * exactly what LoRA trigger tokens rely on), while a punctuation-edged trigger
 * (`3d-render.`) still matches literally instead of never matching at all.
 *
 * Substring matching is deliberately allowed *within* the prompt rather than
 * restricted to comma-separated segments: Civitai triggers are frequently woven
 * mid-sentence ("a portrait of aria_tok on a rooftop"), and re-appending a word
 * that is already doing its job would double-weight it.
 */
export const promptHasTriggerWord = (prompt, word) => {
  const text = typeof prompt === 'string' ? prompt : '';
  const token = typeof word === 'string' ? word.trim() : '';
  if (!text || !token) return false;
  const lead = WORD_CHAR.test(token[0]) ? `(?<![${WORD_CLASS}])` : '';
  const tail = WORD_CHAR.test(token[token.length - 1]) ? `(?![${WORD_CLASS}])` : '';
  return new RegExp(`${lead}${escapeRegExp(token)}${tail}`, 'iu').test(text);
};

/**
 * How the trigger clause attaches to the end of an existing prompt.
 *
 * A single-paragraph prompt gets a plain comma join — the trigger reads as one
 * more subject term, which is what a diffusion prompt wants.
 *
 * A MULTI-paragraph prompt gets its own paragraph instead, because the last
 * line of a structured prompt is frequently a directive the trigger must not be
 * swallowed into. The case that forces this: VideoGen's prompt envelope ends a
 * muted render with a `\n\nno music, no soundtrack` paragraph, so a comma join
 * would produce `no music, no soundtrack, aria_tok` — the activation token
 * lands as the third item of a NEGATION list, and the encoder is as likely to
 * read it as suppressed as activated. That is the exact inverse of the point.
 * The pipeline's `\n\nFeaturing <Name> (<trigger>).` clause has the same shape.
 */
export const separatorFor = (trimmed) => {
  if (!trimmed) return '';
  if (/\n/.test(trimmed)) return '\n\n';
  return trimmed.endsWith(',') ? ' ' : ', ';
};

/**
 * Weave the missing activation tokens of the selected LoRAs into `prompt`.
 *
 * @param {string} prompt - the user's own text; never reordered or rewritten.
 * @param {Array<string[]|string|null>} triggerWordLists - one entry per selected
 *   LoRA, in selection order. Each entry is that LoRA's `triggerWords` array (a
 *   bare string is accepted for convenience); only its first usable word is
 *   considered. Entries with no trigger words contribute nothing.
 * @returns {{ prompt: string, added: string[] }} - the prompt to actually render
 *   with, plus the tokens that were appended (empty when nothing was missing).
 *
 * Missing words are appended as a trailing comma-joined clause in selection
 * order, so the user's own phrasing keeps its position — and, for weighted
 * samplers, its emphasis. An already-present word is never duplicated, which
 * makes the weave idempotent: re-rendering a prompt that already carries its
 * triggers is a no-op.
 */
export const weaveLoraTriggers = (prompt, triggerWordLists) => {
  const original = typeof prompt === 'string' ? prompt : '';
  const lists = Array.isArray(triggerWordLists) ? triggerWordLists : [];
  const added = [];
  const seen = new Set();
  for (const list of lists) {
    const word = firstTriggerWord(typeof list === 'string' ? [list] : list);
    if (!word) continue;
    const key = word.toLowerCase();
    // Dedupe across LoRAs too — two adapters trained on the same token (a
    // character LoRA and its style companion, say) must not stack it twice.
    if (seen.has(key)) continue;
    seen.add(key);
    if (promptHasTriggerWord(original, word)) continue;
    added.push(word);
  }
  if (!added.length) return { prompt: original, added: [] };
  const trimmed = original.trim();
  return { prompt: `${trimmed}${separatorFor(trimmed)}${added.join(', ')}`, added };
};
