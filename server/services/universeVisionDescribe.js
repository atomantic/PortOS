/**
 * Universe Builder — vision-to-prose describer.
 *
 * Takes one or more reference images of a character / place / object and asks
 * a vision-capable model to turn them into an image-gen-ready prose
 * description that can seed the canon entry's descriptor field.
 *
 * Single image → describe that subject. Multiple images → find the visual
 * traits CONSISTENT across all of them (the same character shot from several
 * angles, a location across lighting conditions, a prop in different hands) and
 * describe that shared subject, ignoring incidental differences.
 *
 * Vision is an API-provider-only capability: the toolkit's executeApiRun is the
 * only runner path that base64-encodes images into `image_url` content blocks
 * (CLI/TUI providers receive prompts via stdin only). So we resolve an
 * API-type provider up front and throw NO_API_PROVIDER when none is configured,
 * rather than silently running a text-only completion that hallucinates a
 * description from nothing.
 */

import { resolveAPIProvider, stripCodeFences } from '../lib/aiProvider.js';
import { runPromptThroughProvider, assertProvider } from '../lib/promptRunner.js';
import { ServerError } from '../lib/errorHandler.js';

// Singular kind → render-prompt focus. Mirrors the descriptor emphasis the
// canon render path already uses (CanonCard's descField placeholders).
export const VISION_KINDS = ['character', 'place', 'object'];

// Cap the number of images per call. The runner base64-inlines every image
// into a single request body, so a large batch balloons the prompt and the
// provider's context window. 8 angles is plenty to triangulate a consistent
// subject.
export const VISION_MAX_IMAGES = 8;

const KIND_NOUN = {
  character: 'character',
  place: 'place / location',
  object: 'object / prop',
};

const KIND_FOCUS = {
  character:
    'Focus on the figure itself: apparent age range, build, face, hair, skin, distinctive features, wardrobe/clothing, posture, signature props, and color palette. Ignore background and incidental scenery unless it is part of who they are.',
  place:
    'Focus on the location: architecture or terrain, scale, materials, dominant color palette, lighting and time of day, weather, atmosphere/mood, and recurring visual motifs. Ignore any people or transient subjects passing through.',
  object:
    'Focus on the object: overall form and silhouette, size, materials, color, texture, wear/condition, moving parts or mechanisms, and distinctive markings. Ignore the background and surroundings.',
};

/**
 * Build the vision prompt. The model is told to return ONE prose paragraph
 * suitable for a Stable-Diffusion-style image generator — no markdown, no
 * preamble, no bullet lists — so the result can drop straight into the canon
 * descriptor field.
 */
function buildVisionPrompt({ kind, name, context, imageCount }) {
  const noun = KIND_NOUN[kind];
  const focus = KIND_FOCUS[kind];
  const subject = name ? `the ${noun} "${name}"` : `this ${noun}`;
  const intro = imageCount > 1
    ? `You are looking at ${imageCount} reference images of the same ${noun}${name ? ` (${subject})` : ''}. They show the same subject under different conditions (angle, lighting, framing, background). Identify the visual traits that stay CONSISTENT across all of them and describe that single shared subject. Ignore differences that are incidental to a particular shot (pose, camera angle, background, lighting).`
    : `You are looking at a reference image of ${subject}. Describe what you see.`;

  const ctx = context && context.trim()
    ? `\n\nKnown context (use it to disambiguate, do not contradict the images): ${context.trim()}`
    : '';

  return `${intro}

${focus}

Write a SINGLE paragraph of image-generation-ready prose (roughly 40–120 words) describing ${subject}. Pack it with concrete, renderable visual detail — comma-separated descriptive phrases work well. Do NOT include markdown, headings, bullet points, a "Description:" label, camera/photography jargon, or any commentary about the images themselves. Output only the description.${ctx}`;
}

/**
 * Describe a canon entity from reference image(s).
 *
 * @param {object} args
 * @param {'character'|'place'|'object'} args.kind
 * @param {string} [args.name] — entity name, for prompt context
 * @param {string} [args.context] — extra known context to disambiguate
 * @param {string[]} args.screenshots — image paths the runner can load
 *   (filenames under data/screenshots, or absolute paths)
 * @param {string} [args.providerId] — preferred API provider id
 * @param {string} [args.model] — preferred model id
 * @returns {Promise<{ description: string, llm: { provider: string, model: string|null } }>}
 */
export async function describeEntityFromImages({ kind, name, context, screenshots, providerId, model } = {}) {
  if (!VISION_KINDS.includes(kind)) {
    throw new ServerError(`Unsupported kind "${kind}" — expected one of ${VISION_KINDS.join(', ')}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const images = Array.isArray(screenshots) ? screenshots.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (images.length === 0) {
    throw new ServerError('At least one image is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (images.length > VISION_MAX_IMAGES) {
    throw new ServerError(`Too many images — describe at most ${VISION_MAX_IMAGES} at once`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const provider = await resolveAPIProvider(providerId);
  assertProvider(provider, {
    message:
      'Describing an image needs an API-based AI provider with a vision-capable model (e.g. Ollama with a llava/qwen-vl model, LM Studio, or an OpenAI-compatible endpoint). Configure one under Settings → Providers.',
    code: 'NO_API_PROVIDER',
    status: 503,
  });

  const prompt = buildVisionPrompt({ kind, name, context, imageCount: images.length });

  const result = await runPromptThroughProvider({
    provider,
    prompt,
    source: 'universe-vision-describe',
    // `model || undefined` so an empty-string UI sentinel falls through to the
    // provider's default rather than resolving to a bogus model id.
    model: model || undefined,
    screenshots: images,
  });

  // The runner can swap providers two ways: a proactive swap inside createRun
  // (when the chosen API provider was already benched — leaves
  // usedFallback/fallbackProvider UNSET) and a retry fallback after a failure
  // (sets them). Both surface the provider that actually ran as `result.provider`.
  // A CLI/TUI provider has no vision path and silently drops the images, so the
  // completion would be prose hallucinated from the text prompt alone — reject
  // it outright (resolving an API provider up front was meant to guarantee the
  // model actually sees the references).
  const ranProvider = result.provider || result.fallbackProvider || provider;
  if (ranProvider.type && ranProvider.type !== 'api') {
    throw new ServerError(
      'The vision request fell back to a non-vision provider that cannot read images. Configure a reliable vision-capable API provider and retry.',
      { status: 502, code: 'VISION_FALLBACK_DROPPED_IMAGES' },
    );
  }

  const description = stripCodeFences(result.text || '').trim();
  if (!description) {
    throw new ServerError('The vision model returned an empty description — try a different model or clearer images.', {
      status: 502,
      code: 'VISION_EMPTY',
    });
  }

  return {
    description,
    // Report the provider/model that ACTUALLY ran (a proactive or retry swap
    // may have changed it), so the UI's picker can reflect reality instead of
    // the request.
    llm: {
      provider: ranProvider.id || provider.id,
      model: result.model || null,
    },
  };
}

export const __testing = { buildVisionPrompt };
