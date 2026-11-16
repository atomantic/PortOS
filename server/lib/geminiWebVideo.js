/**
 * Gemini Omni 1.2 Flash as the Gemini web app serves it: clip length, reference limit and the
 * composer's aspect choice.
 */

export const GEMINI_OMNI_WEB_MODEL = Object.freeze({
  id: 'gemini-omni-1.2-flash',
  label: 'Gemini Omni 1.2 Flash',
  clipSeconds: 10,
});

// Reference images beside the start frame. The web app states no limit for this tool,
// so this matches the Grok lane; Gemini's own refusal is reported if it wants fewer.
export const GEMINI_WEB_CLIP_REFERENCE_LIMIT = 7;

/** The composer's aspect choice for a project aspect such as 9:16. Anything not taller than wide is Landscape. */
export function geminiWebAspectChoice(aspect, width, height) {
  const [w, h] = typeof aspect === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(aspect)
    ? aspect.split(':').map(Number)
    : [Number(width), Number(height)];
  return h > w ? 'Portrait (9:16)' : 'Landscape (16:9)';
}
