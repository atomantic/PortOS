// Compose user prompt + negative with optional style preset(s).
// Preset prompts prefix the user prompt — diffusion models weight earlier
// tokens heaviest, so the broad aesthetic carries over the user's content.
// Preset negatives append to the user negative so user-specified avoids stay
// first-class. An array is accepted when a caller combines independent style
// sources, such as a universe style and a built-in preset.

import { universeStylePreset } from './universeStylePreset';

export function composeStyledPrompt(userPrompt, userNegative, preset) {
  const prompt = (userPrompt || '').trim();
  const negative = (userNegative || '').trim();
  const presets = Array.isArray(preset) ? preset : [preset];
  const stylePart = presets.map((item) => (item?.prompt || '').trim()).filter(Boolean).join('. ');
  const styleNeg = presets.map((item) => (item?.negativePrompt || '').trim()).filter(Boolean).join(', ');
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
