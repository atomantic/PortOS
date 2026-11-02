import { promptAddition } from './modelInput.js';

export const CAST_SETS_IMAGE_EDIT_MAX = 2000;
const PRESERVE_IMAGE = 'Edit the attached image. Recreate it exactly, changing only what the instruction below requests. Preserve the same people and faces, identity, clothing, objects, layout, panels, framing, lighting, colors and image style everywhere else. Do not add another reference image.';

/** Shared by the card composer and queue submission; the instruction stays as written. */
export function buildCastSetsImageEditPrompt(instruction) {
  return {
    prompt: `${PRESERVE_IMAGE}\n\n${instruction}`,
    promptAdditions: [promptAddition('cast-sets-image-edit', 'Preserve this image', PRESERVE_IMAGE)],
  };
}
