// `composeStyledPrompt` (single preset or an array of presets) is a pure leaf
// re-exported from server/lib/composeStyledPrompt.js so the browser and the
// server compose style presets with identical logic (#8442).
import { composeStyledPrompt } from '../../../server/lib/composeStyledPrompt.js';
import { universeStylePreset } from './universeStylePreset';

export { composeStyledPrompt };

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
