/**
 * Gemini Omni 1.2 Flash as the Gemini web app serves it. There is no API on this
 * route: PortOS drives gemini.google.com in the signed-in PortOS Browser, so the
 * app's composer sets what a render can ask for. It offers only two aspect
 * ratios and no length control, and it delivers a 1280x720 clip of about 10 s.
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
