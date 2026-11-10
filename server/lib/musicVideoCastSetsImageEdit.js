export const CAST_SETS_IMAGE_EDIT_MAX = 2000;
const PRESERVE_IMAGE = 'Edit the attached image. Recreate it exactly, changing only what the instruction below requests. Preserve the same people and faces, identity, clothing, objects, layout, panels, framing, lighting, colors and image style everywhere else. Anatomical identity firewall: preserve head shape, bone structure, jaw and chin, cheekbones, eye shape, spacing and tilt, iris color, brow shape, nose, mouth width, ears, skin tone and finish, body build and proportions, and existing identity markers in their exact positions unless specifically targeted by the edit instruction. Do not add another reference image.';

/** Shared by the card composer and queue submission; the instruction stays as written. */
export function buildCastSetsImageEditPrompt(instruction) {
  return {
    prompt: `${PRESERVE_IMAGE}\n\n${instruction}`,
    promptAdditions: [{ id: 'cast-sets-image-edit', label: 'Preserve this image', text: PRESERVE_IMAGE }],
  };
}
