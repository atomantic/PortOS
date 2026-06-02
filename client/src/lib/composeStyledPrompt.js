// Compose user prompt + negative with an optional style preset.
// Preset prompt prefixes the user prompt — diffusion models weight earlier
// tokens heaviest, so the broad aesthetic carries over the user's content.
// Preset negative appends to user negative so user-specified avoids stay
// first-class.

import { universeStylePreset } from './universeStylePreset';

export function composeStyledPrompt(userPrompt, userNegative, preset) {
  const prompt = (userPrompt || '').trim();
  const negative = (userNegative || '').trim();
  if (!preset) return { prompt, negativePrompt: negative };
  const stylePart = (preset.prompt || '').trim();
  const styleNeg = (preset.negativePrompt || '').trim();
  // Avoid trailing ". " when only one of the two parts is non-empty so the
  // composed prompt is clean and deterministic regardless of which input
  // is missing.
  const composedPrompt = stylePart && prompt ? `${stylePart}. ${prompt}` : (stylePart || prompt);
  return {
    prompt: composedPrompt,
    negativePrompt: [negative, styleNeg].filter(Boolean).join(', '),
  };
}

// Build the styled `{ prompt, negativePrompt }` for a single named canon subject
// (character / place / object) layered on the universe's style preset. This is
// the routine the Universe Builder's canon section and the Story Builder's
// characters step both render through — `"<name>: <description>"` as the user
// prompt, the base render's negative as the user negative, and the universe's
// style preset on top. Centralizing it keeps the two call sites from drifting
// (e.g. a change to how the name/description join, or which negative seeds the
// compose). `baseNegative` is typically `renderOpts.negativePrompt`.
export function composeCanonStyledPrompt({ name, description, universe, baseNegative = '' }) {
  return composeStyledPrompt(
    `${name}: ${description}`,
    baseNegative || '',
    universe ? universeStylePreset(universe) : null,
  );
}
