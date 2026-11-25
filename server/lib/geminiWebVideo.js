/**
 * Gemini Omni 1.2 Flash as the Gemini web app serves it: clip length, reference limit and the
 * two canvases its composer offers.
 */

export const GEMINI_OMNI_WEB_MODEL = Object.freeze({
  id: 'gemini-omni-1.2-flash',
  label: 'Gemini Omni 1.2 Flash',
  clipSeconds: 10,
});

// Reference images beside the start frame. The web app states no limit for this tool,
// so this matches the Grok lane; Gemini's own refusal is reported if it wants fewer.
export const GEMINI_WEB_CLIP_REFERENCE_LIMIT = 7;

/** The only canvases the composer offers. */
export const GEMINI_WEB_ASPECTS = Object.freeze(['16:9', '9:16']);

// Same 2% the image lanes allow before calling a frame off-ratio (imageGen/aspectConform.js).
const ASPECT_TOLERANCE = 0.02;

const requestedShape = (aspect, width, height) => (
  typeof aspect === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(aspect)
    ? aspect.split(':').map(Number)
    : [Number(width), Number(height)]
);

/** The composer's aspect choice for a project aspect such as 9:16. Anything not taller than wide is Landscape. */
export function geminiWebAspectChoice(aspect, width, height) {
  const [w, h] = requestedShape(aspect, width, height);
  return h > w ? 'Portrait (9:16)' : 'Landscape (16:9)';
}

/**
 * Whether Gemini renders the requested canvas as asked. A request that states no shape is
 * not a mismatch (the composer's default applies); a square or 4:3 one is, because
 * `geminiWebAspectChoice` would quietly answer it with Landscape.
 */
export function geminiWebRendersCanvas(aspect, width, height) {
  const [w, h] = requestedShape(aspect, width, height);
  if (!(w > 0 && h > 0)) return true;
  return GEMINI_WEB_ASPECTS.some((offered) => {
    const [ow, oh] = offered.split(':').map(Number);
    return Math.abs((w / h) / (ow / oh) - 1) <= ASPECT_TOLERANCE;
  });
}
