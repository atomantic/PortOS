/**
 * The client-side `+ trigger` append (#4665) over the trigger-word predicates in `server/lib/loraTriggers.js`.
 *
 * `firstTriggerWord` / `promptHasTriggerWord` are re-exported from the server leaf, the enforcement point (it weaves each selected LoRA's first activation token at render time), so the picker's hint reads the identical rule and can't contradict the render.
 * `appendTriggerWords(prompt, words, effectivePrompt?)` is client-only: it adds ALL of a LoRA's words (the server only weaves the first) and judges presence against the composed prompt the page will actually submit.
 */
import { promptHasTriggerWord, separatorFor } from '../../../server/lib/loraTriggers.js';

export { firstTriggerWord, promptHasTriggerWord } from '../../../server/lib/loraTriggers.js';

/**
 * The "+ trigger" button's append: add a LoRA's trigger words to the prompt, comma-separated, skipping any already present. Unlike the server weave this appends ALL of the words (the user clicked a button whose tooltip lists them); the server only adds the first and never duplicates.
 * `effectivePrompt` is what presence is judged against (default: the prompt). Pass the STYLED/enveloped prompt when the page composes one: a trigger the style preset already supplies must not be appended twice, and the picker's hint reads the same composed text.
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
