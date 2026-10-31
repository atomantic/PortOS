/**
 * The prompt contract for a clip rendered from a storyboard panel (Adam,
 * 2026-10-31): the panel is layout guidance, never the first frame, and the
 * reference images set the cinematic look. Shared by every lane that renders
 * such a clip (Grok image-first, fal reference-to-video) so each names the two
 * roles the same way, and listed as a visible prompt addition (#11317).
 * Browser-safe: the shot card reads it too.
 */

export const STORYBOARD_GUIDANCE_ADDITION_ID = 'storyboard-guidance';
// The panel plus this many references fit the image backends' reference caps
// (MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES, Grok's image_edit array).
export const STORYBOARD_GUIDANCE_MAX_REFERENCES = 4;
// The fal model a storyboard-guided clip uses when the request names none.
export const FAL_STORYBOARD_GUIDANCE_MODEL = 'bytedance/seedance-2.5/reference-to-video';

const nameList = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * What a model is told about each input image. `guidance` and `references`
 * are the names the model knows the images by (a file path for an agent, a
 * prompt token such as @Image1 for a reference model).
 */
export function storyboardGuidanceText({ guidance, references = [] }) {
  const lines = [
    `${guidance} is a storyboard panel: use it only for the layout, framing, camera angle and blocking (who is where, doing what). It is not the first frame. Never copy its drawing style: no pencil or marker lines, flat gray tones, arrows, motion marks or blank faces.`,
    references.length
      ? `${nameList(references)} set the look: the people's likeness and wardrobe, the location and the photographic style. Build a cinematic, photographic shot that matches ${references.length === 1 ? 'it' : 'them'}.`
      : 'Build a cinematic, photographic shot from the prompt.',
  ];
  return lines.join('\n');
}

/** The gallery basename of the first frame a storyboard clip was animated from (videoGen/grok.js), or null. */
export const storyboardFirstFrameFile = (result) => (typeof result?.firstFrameFile === 'string' && /^[^/\\]+\.png$/i.test(result.firstFrameFile)
  ? result.firstFrameFile : null);

/** Why a shot cannot render a clip from its storyboard panel on `backend`, or null. Browser-safe. */
export function storyboardClipBlockedReason({ backend, performance = false, audioReactive = false }) {
  if (performance) return 'A lip-sync or music-driven shot renders from its still, not from the storyboard panel.';
  if (audioReactive || (backend !== 'grok' && backend !== 'fal')) return 'A clip from the storyboard renders on Grok or fal.ai. Pick one of those, or render the full still first.';
  return null;
}

/** The labeled addition a storyboard-guided render records and the compose screen shows. */
// The modelInput.promptAddition shape, built here so the module stays browser-safe (it imports no zod).
export const storyboardGuidanceAddition = (text) => ({ id: STORYBOARD_GUIDANCE_ADDITION_ID, label: 'Storyboard panel as guidance', text: text.trim() });

/** The name a fal reference model knows its `index`-th (0-based) reference image by (@Image1 or "Image 1"), or null when it takes none. */
export function falReferenceImageName(model, index) {
  if (!model?.referenceImages) return null;
  return (model.referenceImages.promptName ?? 'Image 1').replace(/1$/, String(index + 1));
}

/** Why `model` cannot render from a storyboard panel, or null when it can. */
export function falStoryboardGuidanceProblem(model) {
  if (!model?.referenceImages) return `${model?.label || 'This fal.ai model'} takes no reference images. Pick a reference model such as Seedance 2.5 (reference) to render from a storyboard panel.`;
  if (model.image?.required) return `${model.label} always starts on its first image, so it cannot treat a storyboard panel as guidance.`;
  return null;
}
