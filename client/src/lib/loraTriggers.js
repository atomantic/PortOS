/**
 * The client-side `+ trigger` append, over the trigger-word predicates in
 * `server/lib/loraTriggers.js` (#4665).
 *
 * `firstTriggerWord` / `promptHasTriggerWord` / `separatorFor` are re-exported
 * from the server leaf rather than copied: the server is the enforcement point
 * (it weaves each selected LoRA's first activation token into the prompt at
 * render time), so the picker's hint reads the identical matching rules and
 * cannot contradict the render.
 */
import { promptHasTriggerWord, separatorFor } from '../../../server/lib/loraTriggers.js';

export { firstTriggerWord, promptHasTriggerWord, separatorFor } from '../../../server/lib/loraTriggers.js';

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
