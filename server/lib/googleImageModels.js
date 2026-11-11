/**
 * Google Cloud Agent Platform image model catalog — the curated publisher models the
 * `google` image backend (services/imageGen/google.js) may call, with one
 * request builder. Dependency-free so the Settings picker, the Image Gen page
 * and the server validate against the same ids; a `cloudModel` naming anything
 * else is refused because every model is billed differently.
 *
 * Two request shapes:
 *  - `gemini` — the Gemini image models (generateContent): the prompt plus up to
 *    `maxInputImages` inline images in one user turn, IMAGE response modality,
 *    `imageConfig.aspectRatio` / `imageSize`. Served from the `global` location.
 *  - `imagen` — Imagen 4 (predict): text-to-image only, `parameters.aspectRatio`
 *    / `sampleImageSize`, served from the configured region.
 *
 * Model input is sent as written (root AGENTS.md): Imagen's `enhancePrompt`
 * rewrite knob is sent OFF, and since neither shape takes a negative prompt for
 * these models, one rides as a visible "Avoid:" clause (listed as a chip in the
 * sent-prompt view), the same fallback the fal.ai and Higgsfield backends use.
 *
 * `usdPerImage` is Google's list price per output image where it is stable
 * enough to estimate (null = unknown, never zero); the Cloud billing console has
 * the real charge.
 */

const GEMINI_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const IMAGEN_RATIOS = Object.freeze(['1:1', '3:4', '4:3', '9:16', '16:9']);
// Long side each size tier renders at; a request up to SIZE_SLACK times that still lands on the cheaper tier.
const TIER_LONG_SIDE = Object.freeze({ '1K': 1024, '2K': 2048, '4K': 4096 });
const SIZE_SLACK = 1.25;

/**
 * Per family:
 *  - `id` — the Google publisher model id (`publishers/google/models/{id}`).
 *  - `kind` — 'gemini' (generateContent) or 'imagen' (predict).
 *  - `location` — 'global' to always use the global endpoint, or null for the configured region.
 *  - `expressMode` — on Google's express-mode model list (an API key with no project).
 *  - `maxInputImages` — inline image cap (0 = text-to-image only).
 *  - `aspectRatios`, `imageSizes` (null when the model has one fixed size).
 *  - `usdPerImage` — `{ [size]: usd }` or a flat number, null when unknown.
 */
export const GOOGLE_IMAGE_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'gemini-3-pro-image', label: 'Nano Banana Pro (Gemini 3 Pro Image)', kind: 'gemini', location: 'global', expressMode: true,
    maxInputImages: 14, aspectRatios: GEMINI_RATIOS, imageSizes: Object.freeze(['1K', '2K', '4K']),
    usdPerImage: Object.freeze({ '1K': 0.134, '2K': 0.134, '4K': 0.24 }),
  }),
  Object.freeze({
    id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)', kind: 'gemini', location: 'global', expressMode: true,
    maxInputImages: 14, aspectRatios: GEMINI_RATIOS, imageSizes: Object.freeze(['1K', '2K', '4K']),
    usdPerImage: null,
  }),
  Object.freeze({
    id: 'gemini-2.5-flash-image', label: 'Nano Banana (Gemini 2.5 Flash Image)', kind: 'gemini', location: 'global', expressMode: true,
    maxInputImages: 3, aspectRatios: GEMINI_RATIOS, imageSizes: null,
    usdPerImage: 0.039,
  }),
  Object.freeze({
    id: 'imagen-4.0-ultra-generate-001', label: 'Imagen 4 Ultra', kind: 'imagen', location: null, expressMode: false,
    maxInputImages: 0, aspectRatios: IMAGEN_RATIOS, imageSizes: Object.freeze(['1K', '2K']),
    usdPerImage: 0.06,
  }),
  Object.freeze({
    id: 'imagen-4.0-generate-001', label: 'Imagen 4', kind: 'imagen', location: null, expressMode: false,
    maxInputImages: 0, aspectRatios: IMAGEN_RATIOS, imageSizes: Object.freeze(['1K', '2K']),
    usdPerImage: 0.04,
  }),
  Object.freeze({
    id: 'imagen-4.0-fast-generate-001', label: 'Imagen 4 Fast', kind: 'imagen', location: null, expressMode: false,
    maxInputImages: 0, aspectRatios: IMAGEN_RATIOS, imageSizes: null,
    usdPerImage: 0.02,
  }),
]);

export const GOOGLE_IMAGE_DEFAULT_MODEL = GOOGLE_IMAGE_FAMILIES[0].id;

/** Every id a `cloudModel` / `imageGen.google.model` may name. */
export const GOOGLE_IMAGE_MODEL_IDS = Object.freeze(GOOGLE_IMAGE_FAMILIES.map((f) => f.id));

/** The largest reference cap across the catalog, for a caller that does not know the model. */
export const GOOGLE_IMAGE_MAX_INPUT_IMAGES = Math.max(...GOOGLE_IMAGE_FAMILIES.map((f) => f.maxInputImages));

export const googleImageFamily = (modelId) => (typeof modelId === 'string'
  ? GOOGLE_IMAGE_FAMILIES.find((f) => f.id === modelId.trim()) || null
  : null);

/** "~$0.04/image" style hint for a picker, or '' when the price is unknown. */
export function googleImagePriceLabel(family) {
  const price = family?.usdPerImage;
  if (price == null) return '';
  const values = typeof price === 'number' ? [price] : Object.values(price);
  const low = Math.min(...values);
  return `${values.length > 1 && Math.max(...values) !== low ? 'from ' : ''}~$${low}/image`;
}

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'GOOGLE_IMAGE_INPUT_INVALID' });

function nearestRatio(w, h, ratios) {
  const target = Math.log(w / h);
  const distance = (ratio) => { const [rw, rh] = ratio.split(':').map(Number); return Math.abs(Math.log(rw / rh) - target); };
  return ratios.reduce((best, ratio) => (distance(ratio) < distance(best) ? ratio : best));
}

/** The prompt text the model receives: the user's words plus a folded "Avoid:" clause. */
function googleImagePromptText(prompt = '', negativePrompt = '') {
  const negative = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';
  const base = String(prompt ?? '').trim();
  return negative ? `${base}\nAvoid: ${negative}` : base;
}

/**
 * Build the request for one render. `images` are `{ mimeType, data }` with
 * base64 data (placeholders for a dry run). Throws a 400-shaped error for an
 * unknown model, too many input images or an empty prompt.
 *
 * @returns {{ family, method, body, location, imageSize, aspectRatio, estimatedCostUsd }}
 */
export function buildGoogleImageRequest({
  modelId = GOOGLE_IMAGE_DEFAULT_MODEL, prompt = '', negativePrompt = '', width, height, images = [], seed,
}) {
  const family = googleImageFamily(modelId);
  if (!family) throw refuse(`Unknown Google image model: ${modelId}`);
  const inputs = (Array.isArray(images) ? images : []).filter(Boolean);
  if (inputs.length > family.maxInputImages) {
    throw refuse(family.maxInputImages
      ? `${family.label} takes at most ${family.maxInputImages} input image${family.maxInputImages === 1 ? '' : 's'} (received ${inputs.length})`
      : `${family.label} is text-to-image only; remove the input images or pick a Gemini image model`);
  }
  if (!String(prompt ?? '').trim()) throw refuse('Prompt is required');
  const text = googleImagePromptText(prompt, negativePrompt);
  const w = Number(width);
  const h = Number(height);
  const aspectRatio = w > 0 && h > 0 ? nearestRatio(w, h, family.aspectRatios) : null;
  const imageSize = family.imageSizes && w > 0 && h > 0
    ? family.imageSizes.find((tier) => TIER_LONG_SIDE[tier] * SIZE_SLACK >= Math.max(w, h)) || family.imageSizes[family.imageSizes.length - 1]
    : null;
  const seedNum = typeof seed === 'number' ? seed : (typeof seed === 'string' && seed.trim() ? Number(seed) : NaN);
  // A negative seed is PortOS's "random" sentinel.
  const validSeed = Number.isInteger(seedNum) && seedNum >= 0 && seedNum <= 2_147_483_647 ? seedNum : null;

  let method;
  let body;
  if (family.kind === 'gemini') {
    method = 'generateContent';
    const imageConfig = {
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(imageSize ? { imageSize } : {}),
    };
    body = {
      contents: [{
        role: 'user',
        parts: [{ text }, ...inputs.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))],
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
        ...(validSeed != null ? { seed: validSeed } : {}),
      },
    };
  } else {
    method = 'predict';
    // Imagen ignores a seed unless its watermark is turned off, so none is sent.
    body = {
      instances: [{ prompt: text }],
      parameters: {
        sampleCount: 1,
        enhancePrompt: false,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(imageSize ? { sampleImageSize: imageSize } : {}),
      },
    };
  }
  const price = family.usdPerImage;
  const estimatedCostUsd = price == null ? null
    : typeof price === 'number' ? price
      : price[imageSize || family.imageSizes?.[0]] ?? null;
  return {
    family, method, body, location: family.location, imageSize, aspectRatio,
    seed: family.kind === 'gemini' ? validSeed : null, estimatedCostUsd,
  };
}
