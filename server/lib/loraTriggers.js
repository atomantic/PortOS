/**
 * LoRA trigger-word weaving (issue #4665): append missing activation tokens to a render prompt.
 *
 * Given the user's prompt and the trigger words of the LoRAs selected for THIS render, append the missing activation tokens
 * (a LoRA loaded without its trigger looks broken). Render call sites (imageGen/local.js, videoGen/local.js) own the sidecar reads and provenance stamping.
 */

import { escapeRegExp } from './textUtils.js';

// Only the FIRST trigger word per LoRA: Civitai `trainedWords` lists a dozen loosely-related tags and appending all would rewrite the render; matches `characterLoraResolver.js`.
export const firstTriggerWord = (words) => {
  if (!Array.isArray(words)) return null;
  const first = words.find((w) => typeof w === 'string' && w.trim());
  return first ? first.trim() : null;
};

// Unicode letters/digits, not ASCII only: `\b` or `[A-Za-z0-9_]` would read `aria` as present inside `ariaé` and skip the token.
const WORD_CLASS = '\\p{L}\\p{N}_';
const WORD_CHAR = new RegExp(`[${WORD_CLASS}]`, 'u');

// Whole-token presence: boundaries apply only where the word's own edge is a word character (underscore counts, which LoRA tokens rely on), so `aria_tok` doesn't match inside
// `aria_token` while a punctuation-edged trigger still matches. Matches anywhere in the prompt, not just comma segments, so a mid-sentence trigger isn't double-weighted.
export const promptHasTriggerWord = (prompt, word) => {
  const text = typeof prompt === 'string' ? prompt : '';
  const token = typeof word === 'string' ? word.trim() : '';
  if (!text || !token) return false;
  const lead = WORD_CHAR.test(token[0]) ? `(?<![${WORD_CLASS}])` : '';
  const tail = WORD_CHAR.test(token[token.length - 1]) ? `(?![${WORD_CLASS}])` : '';
  return new RegExp(`${lead}${escapeRegExp(token)}${tail}`, 'iu').test(text);
};

// A single paragraph gets a comma join; a MULTI-paragraph prompt gets its own paragraph because its last line may be a directive: VideoGen ends muted renders with
// `\n\nno music, no soundtrack`, and a comma join would put the token in a negation list, where the encoder may read it as suppressed.
export const separatorFor = (trimmed) => {
  if (!trimmed) return '';
  if (/\n/.test(trimmed)) return '\n\n';
  return trimmed.endsWith(',') ? ' ' : ', ';
};

/**
 * Append the missing activation tokens of the selected LoRAs to `prompt` as a trailing clause in selection order, never reordering the user's text. Idempotent: present words aren't duplicated.
 * @param {string} prompt - the user's own text; never reordered or rewritten.
 * @param {Array<string[]|string|null>} triggerWordLists - one entry per LoRA; only its first usable word is considered
 * @returns {{ prompt: string, added: string[] }}
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
    // Dedupe across LoRAs: adapters trained on the same token must not stack it.
    if (seen.has(key)) continue;
    seen.add(key);
    if (promptHasTriggerWord(original, word)) continue;
    added.push(word);
  }
  if (!added.length) return { prompt: original, added: [] };
  const trimmed = original.trim();
  return { prompt: `${trimmed}${separatorFor(trimmed)}${added.join(', ')}`, added };
};
