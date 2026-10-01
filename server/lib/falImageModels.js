/**
 * fal.ai image model catalog — the curated set of fal.ai endpoints the
 * `fal` image backend (services/imageGen/fal.js) may call, with one request
 * builder and one cost estimator per model family.
 *
 * A dependency-free leaf (like `imageGenCapabilities.js`, which reads the
 * per-model reference caps from here) so the Settings model picker and the
 * Image Gen page offer exactly the ids the server accepts — `cloudModel` for a
 * fal render is validated against THIS list, never passed through as free
 * text, because every id is a different price.
 *
 * Every family is a text-to-image endpoint plus its `/edit` sibling. The user
 * picks a FAMILY (either endpoint id names it); the provider routes to the
 * edit endpoint whenever the render carries any input image, so mood-board
 * references reach a model that actually conditions on them.
 *
 * Input schemas and prices were read from fal.ai's per-endpoint OpenAPI
 * (`fal.ai/api/openapi/queue/openapi.json?endpoint_id=…`), the pricing API
 * (`api.fal.ai/v1/models/pricing`) and the model pages on 2026-09-29. None of
 * these models takes a negative prompt, so it is folded into the prompt as an
 * "Avoid:" clause — the same fallback the fal.ai video backend uses. Safety
 * knobs (`safety_tolerance`, `enable_safety_checker`) are left at fal.ai's
 * defaults on purpose: PortOS does not pick a moderation posture for the user.
 */

/** How a family takes its output geometry. */
export const FAL_IMAGE_SIZING = Object.freeze({
  // `aspect_ratio` enum + `resolution` tier (Gemini-backed nano-banana models).
  ASPECT_RATIO: 'aspect-ratio',
  // `image_size: { width, height }` in pixels (Seedream, FLUX.2).
  PIXELS: 'pixels',
});

const NANO_BANANA_ASPECT_RATIOS = Object.freeze(['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16']);

/**
 * The curated families. Per family:
 *  - `textEndpoint` / `editEndpoint` — the two fal.ai endpoint ids.
 *  - `maxInputImages` — the documented reference cap of the edit endpoint
 *      (nano-banana: "up to 14 reference images"; Seedream v5 lite: "up to 10
 *      image inputs … only the last 10 will be used"; FLUX.2 [pro]: "up to 9
 *      reference images"). None of the OpenAPI schemas declare `maxItems`, so
 *      these come from the model pages — re-read them, don't raise on a whim.
 *  - `sizing` — FAL_IMAGE_SIZING; aspect-ratio families also list their
 *      `aspectRatios` and `resolutions` alphabets.
 *  - `alignTo` — pixel-size families whose dimensions must be a multiple of N.
 *  - `seed` — whether the schema accepts `seed` (Seedream v5 lite does not).
 *  - `outputFormat` — the `output_format` to request, or null when the
 *      endpoint has no such field (the provider transcodes whatever arrives).
 *  - `pricing` — `{ unit: 'image', usd, resolutionMultipliers? }` or
 *      `{ unit: 'megapixel', firstMegapixelUsd, extraMegapixelUsd }`.
 */
export const FAL_IMAGE_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    textEndpoint: 'fal-ai/nano-banana-pro',
    editEndpoint: 'fal-ai/nano-banana-pro/edit',
    maxInputImages: 14,
    sizing: FAL_IMAGE_SIZING.ASPECT_RATIO,
    aspectRatios: NANO_BANANA_ASPECT_RATIOS,
    resolutions: Object.freeze(['1K', '2K', '4K']),
    seed: true,
    outputFormat: 'png',
    // "4K outputs will be charged at double the standard rate"; 1K and 2K
    // cost the same.
    pricing: Object.freeze({ unit: 'image', usd: 0.15, resolutionMultipliers: Object.freeze({ '4K': 2 }) }),
  }),
  Object.freeze({
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    textEndpoint: 'fal-ai/nano-banana-2',
    editEndpoint: 'fal-ai/nano-banana-2/edit',
    maxInputImages: 14,
    sizing: FAL_IMAGE_SIZING.ASPECT_RATIO,
    // The extreme 4:1 / 1:4 / 8:1 / 1:8 ratios this model also accepts are
    // deliberately left out: nearest-ratio mapping of an ordinary PortOS canvas
    // never wants them, and a banner-shaped surprise is worse than 21:9.
    aspectRatios: NANO_BANANA_ASPECT_RATIOS,
    resolutions: Object.freeze(['0.5K', '1K', '2K', '4K']),
    seed: true,
    outputFormat: 'png',
    // "2K and 4K outputs will be charged at 1.5 times and 2 times the
    // standard rate … 0.5K (512px) … 0.75 times".
    pricing: Object.freeze({ unit: 'image', usd: 0.08, resolutionMultipliers: Object.freeze({ '0.5K': 0.75, '2K': 1.5, '4K': 2 }) }),
  }),
  Object.freeze({
    id: 'seedream-v5-lite',
    label: 'Seedream 5.0 Lite',
    textEndpoint: 'fal-ai/bytedance/seedream/v5/lite/text-to-image',
    editEndpoint: 'fal-ai/bytedance/seedream/v5/lite/edit',
    maxInputImages: 10,
    // "Total pixels must be between 2560x1440 and 4096x4096" — fal.ai rescales
    // anything outside that band itself, so the requested geometry is sent
    // as-is and only its aspect ratio is guaranteed.
    sizing: FAL_IMAGE_SIZING.PIXELS,
    seed: false,
    outputFormat: null,
    pricing: Object.freeze({ unit: 'image', usd: 0.035 }),
  }),
  Object.freeze({
    id: 'flux-2-pro',
    label: 'FLUX.2 [pro]',
    textEndpoint: 'fal-ai/flux-2-pro',
    editEndpoint: 'fal-ai/flux-2-pro/edit',
    maxInputImages: 9,
    sizing: FAL_IMAGE_SIZING.PIXELS,
    // FLUX latents are 16-px aligned; send an aligned size so fal.ai never
    // has to round a dimension the caller chose.
    alignTo: 16,
    seed: true,
    // Defaults to jpeg; ask for png so the gallery gets lossless bytes.
    outputFormat: 'png',
    // "$0.03 for the first megapixel of output, plus $0.015 per extra
    // megapixel of input and output, rounded up to the nearest megapixel."
    pricing: Object.freeze({ unit: 'megapixel', firstMegapixelUsd: 0.03, extraMegapixelUsd: 0.015 }),
  }),
]);

/** What a fal render uses when neither the request nor Settings names a model. */
export const FAL_IMAGE_DEFAULT_MODEL = FAL_IMAGE_FAMILIES[0].textEndpoint;

/** Every endpoint id a `cloudModel` / `imageGen.fal.model` may name. */
export const FAL_IMAGE_MODEL_IDS = Object.freeze(
  FAL_IMAGE_FAMILIES.flatMap((f) => [f.textEndpoint, f.editEndpoint]),
);

/**
 * The smallest reference cap across the catalog — the mode-level
 * `maxInputImages` for a caller that does not know which fal model will
 * render, so it never offers a slot some fal model would drop.
 */
export const FAL_IMAGE_MIN_INPUT_IMAGES = Math.min(...FAL_IMAGE_FAMILIES.map((f) => f.maxInputImages));

/** The family an endpoint id belongs to (text or edit id), or null. */
export const falImageFamily = (modelId) => (typeof modelId === 'string'
  ? FAL_IMAGE_FAMILIES.find((f) => f.textEndpoint === modelId.trim() || f.editEndpoint === modelId.trim()) || null
  : null);

export const isFalImageModel = (modelId) => falImageFamily(modelId) !== null;

/** Human price tag for a picker row: "$0.15/image", "~$0.03/MP". */
export const falImagePriceLabel = (family) => (family.pricing.unit === 'megapixel'
  ? `~$${family.pricing.firstMegapixelUsd}/MP`
  : `$${family.pricing.usd}/image`);

// Nominal long side of each resolution tier. Gemini's tiers name the SHORT
// side of a square — a 1K 16:9 frame is ~1376 px wide — so a requested long
// side up to 1.4× the nominal still lands on that tier rather than paying for
// the next one.
const RESOLUTION_LONG_SIDE = Object.freeze({ '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 4096 });
const RESOLUTION_SLACK = 1.4;

const validDims = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
};

function nearestRatio(w, h, ratios) {
  const target = w / h;
  let best = null;
  let bestDelta = Infinity;
  for (const ratio of ratios) {
    const [rw, rh] = ratio.split(':').map(Number);
    const delta = Math.abs((rw / rh) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = ratio;
    }
  }
  return best;
}

function resolutionTier(w, h, tiers) {
  const longSide = Math.max(w, h);
  return tiers.find((tier) => RESOLUTION_LONG_SIDE[tier] * RESOLUTION_SLACK >= longSide) || tiers[tiers.length - 1];
}

const align = (n, step) => Math.max(step, Math.round(n / step) * step);

// fal.ai's megapixel is binary — its own worked example bills a 1024×1024
// output as exactly one megapixel and a 1920×1080 one as two.
export const FAL_MEGAPIXEL = 1024 * 1024;

/**
 * Estimated USD for one render. An ESTIMATE — recorded in the sidecar so a
 * gallery image can say roughly what it cost, not a billing record.
 * `inputMegapixels` is the total size of the input images in FAL_MEGAPIXEL
 * units (FLUX.2 bills them);
 * `outputPixels` is `{ w, h }` when known.
 */
function estimateFalImageCostUsd(family, { resolution = null, outputPixels = null, inputMegapixels = 0 } = {}) {
  const { pricing } = family;
  if (pricing.unit === 'megapixel') {
    // FLUX.2's defaults when no size was sent: t2i renders landscape_4_3
    // (1024×768), and edit `auto` follows the input — call it one megapixel.
    const outMp = outputPixels ? (outputPixels.w * outputPixels.h) / FAL_MEGAPIXEL : 1;
    const billedMp = Math.max(1, Math.ceil(outMp)) + Math.ceil(inputMegapixels);
    return Math.round((pricing.firstMegapixelUsd + (billedMp - 1) * pricing.extraMegapixelUsd) * 10000) / 10000;
  }
  const multiplier = (resolution && pricing.resolutionMultipliers?.[resolution]) || 1;
  return Math.round(pricing.usd * multiplier * 10000) / 10000;
}

/**
 * Build the fal.ai request for one render.
 *
 * @param {object} opts
 * @param {string} opts.modelId      - any catalog endpoint id (text or edit)
 * @param {string} opts.prompt
 * @param {string} [opts.negativePrompt]
 * @param {number} [opts.width]      - requested canvas; absent → the model's default geometry
 * @param {number} [opts.height]
 * @param {string[]} [opts.imageUrls] - input images (URLs or data URIs), init image first
 * @param {number} [opts.inputMegapixels] - their combined size, for the cost estimate
 * @param {number} [opts.seed]
 * @returns {{ family, endpointId, body, resolution, estimatedCostUsd }|null}
 *   null when `modelId` is not in the catalog.
 */
export function buildFalImageRequest({
  modelId, prompt = '', negativePrompt = '', width, height, imageUrls = [], inputMegapixels = 0, seed,
}) {
  const family = falImageFamily(modelId);
  if (!family) return null;
  const refs = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean).slice(0, family.maxInputImages);
  const endpointId = refs.length ? family.editEndpoint : family.textEndpoint;
  const avoid = typeof negativePrompt === 'string' && negativePrompt.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  // `num_images` is left at every endpoint's default of 1 (FLUX.2 [pro] has
  // no such field at all) — one PortOS render is one image.
  const body = { prompt: `${String(prompt).trim()}${avoid}` };
  if (refs.length) body.image_urls = refs;
  if (family.outputFormat) body.output_format = family.outputFormat;
  // A negative seed is PortOS's "random" sentinel — let fal.ai pick one.
  const seedNum = typeof seed === 'number' ? seed : (typeof seed === 'string' && seed.trim() ? Number(seed) : NaN);
  if (family.seed && Number.isInteger(seedNum) && seedNum >= 0) body.seed = seedNum;

  const dims = validDims(width, height);
  let resolution = null;
  let outputPixels = null;
  if (dims && family.sizing === FAL_IMAGE_SIZING.ASPECT_RATIO) {
    body.aspect_ratio = nearestRatio(dims.w, dims.h, family.aspectRatios);
    resolution = resolutionTier(dims.w, dims.h, family.resolutions);
    body.resolution = resolution;
  } else if (dims) {
    outputPixels = family.alignTo ? { w: align(dims.w, family.alignTo), h: align(dims.h, family.alignTo) } : dims;
    body.image_size = { width: outputPixels.w, height: outputPixels.h };
  }
  return {
    family,
    endpointId,
    body,
    resolution,
    estimatedCostUsd: estimateFalImageCostUsd(family, { resolution, outputPixels, inputMegapixels: refs.length ? inputMegapixels : 0 }),
  };
}
