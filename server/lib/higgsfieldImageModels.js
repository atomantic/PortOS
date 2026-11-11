/**
 * Higgsfield image model catalog — the curated endpoints the `higgsfield`
 * image backend (services/imageGen/higgsfield.js) may call, with one request
 * builder. Dependency-free so the Settings picker, the Image Gen page and the
 * server validate against the same ids; a `cloudModel` naming anything else is
 * refused because every endpoint is billed differently.
 *
 * Schemas were read from the per-workflow pages on docs.higgsfield.ai on
 * 2026-11-10. Higgsfield publishes no per-image list prices there, so the cost
 * stays unknown (never zero); the console bills the real amount.
 *
 * Model input is sent as written (root AGENTS.md): every prompt-rewriting knob
 * these endpoints expose (`enhance_prompt`, `prompt_extend`, `enable_thinking`)
 * is sent OFF, and a negative prompt the endpoint has no field for is folded in
 * as a visible "Avoid:" clause, the same fallback the fal.ai backend uses.
 */

const SOUL_RATIOS = Object.freeze(['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2']);
const ALIBABA_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '7:9', '9:7', '9:16', '16:9', '21:9']);
const IDEOGRAM_RATIOS = Object.freeze([
  '1:1', '1:2', '2:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9', '5:8', '8:5', '3:4', '4:3',
  '9:22', '22:9', '9:23', '23:9', '3:8', '8:3', '5:12', '12:5', '1:3', '3:1',
]);
// Long side each tier renders at (Qwen's 2k square is 1536 px); a request up to
// RESOLUTION_SLACK times that still lands on the cheaper tier.
const TIER_LONG_SIDE = Object.freeze({ '720p': 1280, '1080p': 1920, '1k': 1024, '2k': 2048 });
const RESOLUTION_SLACK = 1.25;
const SOUL_SEED = Object.freeze({ min: 1, max: 1_000_000 });
const ALIBABA_SEED = Object.freeze({ min: 0, max: 2_147_483_647 });

/**
 * Per family:
 *  - `textEndpoint` / `editEndpoint` — the endpoint ids (edit is null when the
 *     model takes no input image); either id names the family.
 *  - `maxInputImages` / `imageField` — the edit endpoint's cap and whether it
 *     reads `image_urls` (array) or `image_url` (single).
 *  - `aspectRatios`, `resolutions` (null when the endpoint has no tier field).
 *  - `seed` — `{ min, max }` or null; `promptMin` / `promptMax` (null = none stated).
 *  - `negativePrompt` — 'native' (sent as `negative_prompt`) or 'fold'.
 *  - `fixed` — fields always sent (the rewrite knobs, turned off).
 */
export const HIGGSFIELD_IMAGE_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'soul-2', label: 'Higgsfield Soul 2',
    textEndpoint: 'higgsfield-ai/soul/v2/standard', editEndpoint: null,
    maxInputImages: 0, imageField: null,
    aspectRatios: SOUL_RATIOS, resolutions: Object.freeze(['720p', '1080p']),
    seed: SOUL_SEED, promptMin: 1, promptMax: null, negativePrompt: 'fold',
    fixed: Object.freeze({ enhance_prompt: false }),
  }),
  Object.freeze({
    id: 'soul-cinema', label: 'Higgsfield Soul Cinema',
    textEndpoint: 'higgsfield-ai/soul/cinema', editEndpoint: null,
    maxInputImages: 0, imageField: null,
    aspectRatios: SOUL_RATIOS, resolutions: Object.freeze(['720p', '1080p']),
    seed: SOUL_SEED, promptMin: 1, promptMax: null, negativePrompt: 'fold',
    fixed: Object.freeze({ enhance_prompt: false }),
  }),
  Object.freeze({
    id: 'qwen-image-3', label: 'Qwen Image 3',
    textEndpoint: 'alibaba/qwen-image-3/text-to-image', editEndpoint: 'alibaba/qwen-image-3/edit',
    maxInputImages: 3, imageField: 'image_urls',
    aspectRatios: ALIBABA_RATIOS, resolutions: Object.freeze(['1k', '2k']),
    seed: ALIBABA_SEED, promptMin: 1, promptMax: null, negativePrompt: 'native',
    // Both default true; enable_thinking requires prompt_extend, so both go off together.
    fixed: Object.freeze({ prompt_extend: false, enable_thinking: false }),
  }),
  Object.freeze({
    id: 'ideogram-4', label: 'Ideogram 4.0',
    textEndpoint: 'ideogram/v4.0', editEndpoint: 'ideogram/v4.0',
    maxInputImages: 1, imageField: 'image_url',
    aspectRatios: IDEOGRAM_RATIOS, resolutions: null,
    seed: null, promptMin: 2, promptMax: 2048, negativePrompt: 'fold',
    fixed: Object.freeze({}),
  }),
  Object.freeze({
    id: 'z-image-turbo', label: 'Z-Image Turbo',
    textEndpoint: 'z-image/turbo', editEndpoint: null,
    maxInputImages: 0, imageField: null,
    aspectRatios: ALIBABA_RATIOS, resolutions: Object.freeze(['1k', '2k']),
    seed: ALIBABA_SEED, promptMin: 1, promptMax: 800, negativePrompt: 'fold',
    fixed: Object.freeze({ prompt_extend: false }),
  }),
]);

export const HIGGSFIELD_IMAGE_DEFAULT_MODEL = HIGGSFIELD_IMAGE_FAMILIES[0].textEndpoint;

/** Every id a `cloudModel` / `imageGen.higgsfield.model` may name. */
export const HIGGSFIELD_IMAGE_MODEL_IDS = Object.freeze([...new Set(
  HIGGSFIELD_IMAGE_FAMILIES.flatMap((f) => [f.textEndpoint, f.editEndpoint].filter(Boolean)),
)]);

/** The largest reference cap across the catalog, for a caller that does not know the model. */
export const HIGGSFIELD_IMAGE_MAX_INPUT_IMAGES = Math.max(...HIGGSFIELD_IMAGE_FAMILIES.map((f) => f.maxInputImages));

export const higgsfieldImageFamily = (modelId) => (typeof modelId === 'string'
  ? HIGGSFIELD_IMAGE_FAMILIES.find((f) => f.textEndpoint === modelId.trim() || f.editEndpoint === modelId.trim()) || null
  : null);

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'HIGGSFIELD_IMAGE_INPUT_INVALID' });

function nearestRatio(w, h, ratios) {
  const target = Math.log(w / h);
  const distance = (ratio) => { const [rw, rh] = ratio.split(':').map(Number); return Math.abs(Math.log(rw / rh) - target); };
  return ratios.reduce((best, ratio) => (distance(ratio) < distance(best) ? ratio : best));
}

/** The prompt text the model receives: the user's words plus a folded "Avoid:" clause where needed. */
function higgsfieldImagePromptText(family, prompt = '', negativePrompt = '') {
  const negative = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';
  const base = String(prompt ?? '').trim();
  return family.negativePrompt === 'fold' && negative ? `${base}\nAvoid: ${negative}` : base;
}

/**
 * Build the request for one render. Throws a 400-shaped error for an unknown
 * model, too many references, or a prompt outside the endpoint's limits —
 * PortOS refuses rather than truncating (root AGENTS.md).
 *
 * @returns {{ family, endpointId, body, resolution, estimatedCostUsd: null }}
 */
export function buildHiggsfieldImageRequest({
  modelId = HIGGSFIELD_IMAGE_DEFAULT_MODEL, prompt = '', negativePrompt = '', width, height, imageUrls = [], seed,
}) {
  const family = higgsfieldImageFamily(modelId);
  if (!family) throw refuse(`Unknown Higgsfield image model: ${modelId}`);
  const refs = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean);
  if (refs.length > family.maxInputImages) {
    throw refuse(family.maxInputImages
      ? `${family.label} takes at most ${family.maxInputImages} input image${family.maxInputImages === 1 ? '' : 's'} (received ${refs.length})`
      : `${family.label} is text-to-image only; remove the input images or pick a model that edits`);
  }
  if (!String(prompt ?? '').trim()) throw refuse('Prompt is required');
  const text = higgsfieldImagePromptText(family, prompt, negativePrompt);
  if (text.length < family.promptMin || (family.promptMax && text.length > family.promptMax)) {
    throw refuse(`${family.label} prompt must be ${family.promptMin}–${family.promptMax ?? '∞'} characters (sent text is ${text.length}). Nothing was submitted or truncated.`);
  }
  const body = { prompt: text, ...family.fixed };
  if (refs.length) body[family.imageField] = family.imageField === 'image_url' ? refs[0] : refs;
  if (family.negativePrompt === 'native' && typeof negativePrompt === 'string' && negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
  const seedNum = typeof seed === 'number' ? seed : (typeof seed === 'string' && seed.trim() ? Number(seed) : NaN);
  // A negative seed is PortOS's "random" sentinel; out-of-range seeds are left to the model too.
  if (family.seed && Number.isInteger(seedNum) && seedNum >= family.seed.min && seedNum <= family.seed.max) body.seed = seedNum;
  const w = Number(width);
  const h = Number(height);
  let resolution = null;
  if (w > 0 && h > 0) {
    body.aspect_ratio = nearestRatio(w, h, family.aspectRatios);
    if (family.resolutions) {
      const longSide = Math.max(w, h);
      resolution = family.resolutions.find((tier) => TIER_LONG_SIDE[tier] * RESOLUTION_SLACK >= longSide) || family.resolutions[family.resolutions.length - 1];
      body.resolution = resolution;
    }
  }
  const endpointId = refs.length && family.editEndpoint ? family.editEndpoint : family.textEndpoint;
  return { family, endpointId, body, resolution, estimatedCostUsd: null };
}
