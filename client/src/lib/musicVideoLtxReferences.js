// LTX 2.5 References (Ingredients IC-LoRA, mode `ic-ingredients-25`) for Music Video clips:
// the project-wide `generationMode` value, the card's shared prompt prefix, and the reasons
// the shot card cannot offer the option.

export const LTX_REFERENCES_GENERATION_MODE = 'ltxReferences';
export const LTX_REFERENCES_IC_MODE = 'ic-ingredients-25';
export const LTX_REFERENCES_MIN_FRAMES = 121;
export const LTX_REFERENCES_MAX_REFERENCES = 8;

export const isLtx25Model = (model) => model?.runtime === 'ltx25';

/** The reference-sheet lead-in the render prompt carries (and the card previews). */
export const ltxReferenceSheetPrefix = (labels) => `Reference sheet: ${labels.join(', ')}.\n\nGenerated video: `;

/**
 * Why a shot cannot use References, or null when it can. The first matching
 * reason wins. A greybox reference is reported by the card beside its checkbox.
 */
export function ltxReferencesUnavailableReason({ performance, backend, model, audioReactive, storyboardDefault }) {
  if (performance) return 'Performance shots use lip-sync, which LTX reference images cannot drive.';
  if (backend !== 'local') return 'LTX reference images need Render on set to Local.';
  if (!isLtx25Model(model)) return 'LTX reference images need an LTX 2.5 local model; pick one in Render on.';
  if (audioReactive) return 'LTX reference images are off while the project mode is Audio reactive.';
  if (storyboardDefault) return 'Generate the storyboard frame first to use LTX reference images.';
  return null;
}
