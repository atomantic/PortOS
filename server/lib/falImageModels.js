/**
 * fal.ai image model catalog — the curated set of fal.ai endpoints the
 * `fal` image backend (services/imageGen/fal.js) may call, with one request
 * builder and one cost estimator per model family.
 *
 * Curated fal.ai image model catalog, a dependency-free leaf the client imports: `FAL_IMAGE_FAMILIES`
 * (text + `/edit` endpoint per family, per-model reference cap, sizing alphabet, pricing),
 * `FAL_IMAGE_DEFAULT_MODEL`, `FAL_IMAGE_MODEL_IDS` (the only ids a fal `cloudModel` may name),
 * `falImageFamily`/`isFalImageModel`, `falImagePriceLabel`, `buildFalImageRequest` (routes to `/edit`
 * when input images are present; maps width/height to aspect-ratio + resolution tier or pixel
 * `image_size`) and `estimateFalImageCostUsd` (with `FAL_MEGAPIXEL`, fal.ai's binary megapixel).
 *
 * A dependency-free leaf (like `imageGenCapabilities.js`, which reads the
 * per-model reference caps from here) so the Settings model picker and the
 * Image Gen page share one description of every curated family. Curated ids
 * are the ones PortOS prices exactly. A listed text-to-image or
 * image-to-image endpoint fal.ai currently offers is also submittable: its
 * body comes from that endpoint's OpenAPI (`buildListedFalImageRequest`) and
 * its price is unknown until fal.ai bills it. An implausible id is refused
 * before a paid call.
 *
 * Every curated family is a text-to-image endpoint plus its `/edit` sibling.
 * Both ids stay selectable. When the chosen id is one of those families, the
 * provider still routes a render that carries any input image to the edit
 * sibling, so a mood board pinned to the text endpoint keeps conditioning.
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
    id: 'seedream-v4.5',
    label: 'Seedream 4.5',
    textEndpoint: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    editEndpoint: 'fal-ai/bytedance/seedream/v4.5/edit',
    maxInputImages: 10,
    // Width and height must be between 1920 and 4096, or the total pixels
    // between 2560×1440 and 4096×4096. fal.ai rescales anything outside that
    // band, so the requested geometry is sent as-is and only its aspect ratio
    // is guaranteed. Same rule as Seedream 5.0 Lite.
    sizing: FAL_IMAGE_SIZING.PIXELS,
    seed: true,
    outputFormat: null,
    pricing: Object.freeze({ unit: 'image', usd: 0.04 }),
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

/** Every curated endpoint id (text and edit). Listed models outside this set are still submittable. */
export const FAL_IMAGE_MODEL_IDS = Object.freeze(
  FAL_IMAGE_FAMILIES.flatMap((f) => [f.textEndpoint, f.editEndpoint]),
);

/**
 * Endpoints the picker leads with, in this order, even when the live list
 * omits them. Order is independent of `FAL_IMAGE_FAMILIES` so Nano Banana Pro
 * can stay the shipped default (`FAL_IMAGE_FAMILIES[0]`) without leading the menu.
 */
export const FAL_FEATURED_IMAGE_MODEL_IDS = Object.freeze([
  'fal-ai/bytedance/seedream/v4.5/text-to-image',
  'fal-ai/nano-banana-pro',
  'fal-ai/nano-banana-pro/edit',
  'fal-ai/bytedance/seedream/v4.5/edit',
]);

/**
 * The featured edit endpoints, in the order an edit or refine should offer them.
 * A fresh render keeps the full featured order; these lead only while that
 * action is open, or while Image Gen already has a source or reference image.
 */
export const FAL_FEATURED_EDIT_MODEL_IDS = Object.freeze([
  'fal-ai/nano-banana-pro/edit',
  'fal-ai/bytedance/seedream/v4.5/edit',
]);

// At least one slash, so a bare vendor id (`gpt-5.6-luna`) is not a fal endpoint.
const FAL_ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]{0,80}(?:\/[a-z0-9][a-z0-9._-]{0,80}){1,8}$/;

/** True for an id that could be a fal.ai endpoint. Not proof the account can run it. */
export function isPlausibleFalEndpointId(modelId) {
  if (typeof modelId !== 'string') return false;
  const id = modelId.trim();
  return id.length > 0 && id.length <= 200 && FAL_ENDPOINT_ID.test(id);
}

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

/** Fold a negative prompt into the text fal.ai receives. None of these models have a negative field. */
export function appendFalAvoid(prompt, negativePrompt) {
  const text = String(prompt ?? '').trim();
  const avoid = typeof negativePrompt === 'string' && negativePrompt.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  return `${text}${avoid}`;
}

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
  // `num_images` is left at every endpoint's default of 1 (FLUX.2 [pro] has
  // no such field at all) — one PortOS render is one image.
  const body = { prompt: appendFalAvoid(prompt, negativePrompt) };
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

const SCHEMA_DEPTH = 8;
const KNOWN_RESOLUTION_TIERS = Object.freeze(['0.5K', '1K', '2K', '4K']);

function resolveNode(spec, node, depth) {
  if (!node || typeof node !== 'object' || depth > SCHEMA_DEPTH) return null;
  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop();
    const target = spec?.components?.schemas?.[name];
    return target ? resolveNode(spec, target, depth + 1) : null;
  }
  if (Array.isArray(node.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of node.allOf) {
      const resolved = resolveNode(spec, part, depth + 1);
      if (!resolved) continue;
      if (resolved.properties) Object.assign(merged.properties, resolved.properties);
      if (Array.isArray(resolved.required)) merged.required.push(...resolved.required);
      if (Array.isArray(resolved.enum)) merged.enum = [...(merged.enum || []), ...resolved.enum];
      if (resolved.type) merged.type = resolved.type;
    }
    return merged;
  }
  return node;
}

function branchesOf(spec, node, depth) {
  const resolved = resolveNode(spec, node, depth);
  if (!resolved) return [];
  const list = resolved.anyOf || resolved.oneOf;
  if (Array.isArray(list)) return list.flatMap((branch) => branchesOf(spec, branch, depth + 1));
  return [resolved];
}

function findRequestSchema(spec) {
  for (const item of Object.values(spec?.paths || {})) {
    const schema = item?.post?.requestBody?.content?.['application/json']?.schema;
    if (schema) return schema;
  }
  return null;
}

/**
 * The fields PortOS knows how to fill, read from a fal queue OpenAPI document.
 * A pixel `image_size` counts only when a resolved object branch declares both
 * `width` and `height` — a bare `$ref` or a named enum (`square_hd`) is not
 * enough, and this does not guess one. Returns null when the document has no
 * prompt, which is the signal to refuse before a paid call.
 */
export function falInputSchemaFromOpenApi(spec) {
  const input = resolveNode(spec, findRequestSchema(spec), 0);
  const properties = input?.properties;
  if (!properties?.prompt) return null;
  const required = new Set(Array.isArray(input.required) ? input.required : []);
  const imageKey = ['image_urls', 'image_url', 'image'].find((key) => properties[key]);
  let images = null;
  if (imageKey) {
    const branches = branchesOf(spec, properties[imageKey], 0);
    const arrayBranch = branches.find((branch) => branch?.type === 'array' || branch?.items);
    const multiple = imageKey === 'image_urls' || Boolean(arrayBranch);
    const declared = Number.isInteger(arrayBranch?.maxItems) ? arrayBranch.maxItems : null;
    images = {
      field: imageKey,
      multiple,
      maxItems: multiple ? (declared ?? 14) : 1,
      required: required.has(imageKey),
    };
  }
  const sizeBranches = properties.image_size ? branchesOf(spec, properties.image_size, 0) : [];
  const imageSize = sizeBranches.some((branch) => branch?.properties?.width && branch?.properties?.height)
    ? { kind: 'pixels' }
    : null;
  const ratioEnums = properties.aspect_ratio
    ? branchesOf(spec, properties.aspect_ratio, 0).flatMap((branch) => branch?.enum || [])
    : [];
  const ratios = [...new Set(ratioEnums.filter((value) => typeof value === 'string' && /^\d+:\d+$/.test(value)))];
  const aspectRatio = ratios.length ? { ratios } : null;
  const tierEnums = properties.resolution
    ? branchesOf(spec, properties.resolution, 0).flatMap((branch) => branch?.enum || [])
    : [];
  const tiers = KNOWN_RESOLUTION_TIERS.filter((tier) => tierEnums.includes(tier));
  const resolution = tiers.length ? { tiers } : null;
  const seed = properties.seed
    ? branchesOf(spec, properties.seed, 0).some((branch) => branch?.type === 'integer' || branch?.type === 'number')
    : false;
  const formatEnums = properties.output_format
    ? branchesOf(spec, properties.output_format, 0).flatMap((branch) => branch?.enum || [])
    : [];
  return {
    prompt: true,
    images,
    imageSize,
    aspectRatio,
    resolution,
    seed,
    outputFormat: formatEnums.includes('png') ? 'png' : null,
  };
}

const aspectReady = (schema) => Array.isArray(schema.aspectRatio?.ratios) && schema.aspectRatio.ratios.length > 0;

/**
 * Request body for a listed model PortOS does not price. `estimatedCostUsd`
 * stays null — the gallery says the price is unknown rather than inventing one.
 * Returns null when the id is implausible or the schema has no prompt.
 */
export function buildListedFalImageRequest({
  modelId, schema, prompt = '', negativePrompt = '', width, height, imageUrls = [], seed,
}) {
  if (!isPlausibleFalEndpointId(modelId) || !schema?.prompt) return null;
  const refs = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean);
  const acceptsImages = Boolean(schema.images);
  const requiresImages = Boolean(schema.images?.required);
  const cap = schema.images ? Math.max(1, schema.images.maxItems || (schema.images.multiple ? 14 : 1)) : 0;
  const capped = acceptsImages ? refs.slice(0, schema.images.multiple ? cap : 1) : [];
  const body = { prompt: appendFalAvoid(prompt, negativePrompt) };
  if (capped.length) {
    body[schema.images.field] = schema.images.multiple ? capped : capped[0];
  }
  if (schema.outputFormat) body.output_format = schema.outputFormat;
  const seedNum = typeof seed === 'number' ? seed : (typeof seed === 'string' && seed.trim() ? Number(seed) : NaN);
  if (schema.seed && Number.isInteger(seedNum) && seedNum >= 0) body.seed = seedNum;

  const dims = validDims(width, height);
  let resolution = null;
  if (dims && aspectReady(schema)) {
    body.aspect_ratio = nearestRatio(dims.w, dims.h, schema.aspectRatio.ratios);
    if (schema.resolution) {
      resolution = resolutionTier(dims.w, dims.h, schema.resolution.tiers);
      body.resolution = resolution;
    }
  } else if (dims && schema.imageSize?.kind === 'pixels') {
    body.image_size = { width: dims.w, height: dims.h };
  }
  return {
    family: null,
    endpointId: modelId.trim(),
    body,
    resolution,
    estimatedCostUsd: null,
    acceptsImages,
    requiresImages,
  };
}

function falEndpointChoice(endpointId) {
  const family = falImageFamily(endpointId);
  const edit = family.editEndpoint === endpointId;
  return Object.freeze({
    id: endpointId,
    label: `${family.label}${edit ? ' · edit' : ' · text to image'} (${falImagePriceLabel(family)}${edit ? `, up to ${family.maxInputImages} refs` : ''})`,
    featured: FAL_FEATURED_IMAGE_MODEL_IDS.includes(endpointId),
    known: true,
    category: edit ? 'image-to-image' : 'text-to-image',
  });
}

function orderFalChoices(rows) {
  const featured = FAL_FEATURED_IMAGE_MODEL_IDS.map((id) => rows.find((row) => row.id === id)).filter(Boolean);
  return [...featured, ...rows.filter((row) => !FAL_FEATURED_IMAGE_MODEL_IDS.includes(row.id))];
}

/**
 * Optgroups for a fal picker. `editing` lifts the featured edit endpoints into
 * their own leading group so an edit or refine does not bury them under the
 * text-to-image rows. The same id is never listed twice.
 */
export function falImageModelGroups(choices, { editing = false } = {}) {
  const rows = (Array.isArray(choices) ? choices : []).filter((row) => row && typeof row.id === 'string');
  const editIds = editing ? new Set(FAL_FEATURED_EDIT_MODEL_IDS) : new Set();
  const edit = editing
    ? FAL_FEATURED_EDIT_MODEL_IDS.map((id) => rows.find((row) => row.id === id)).filter(Boolean)
    : [];
  const featured = rows.filter((row) => row.featured && !editIds.has(row.id));
  const rest = rows.filter((row) => !row.featured && !editIds.has(row.id));
  const labeled = featured.length > 0 || edit.length > 0;
  return [
    edit.length ? { label: 'Edit / refine', models: edit } : null,
    featured.length ? { label: 'Featured', models: featured } : null,
    rest.length ? { label: labeled ? 'All image models' : null, models: rest } : null,
  ].filter(Boolean);
}

/**
 * Picker rows. Curated endpoints (with their prices) always win over a live
 * display name for the same id. Live-only plausible ids are appended.
 * Featured endpoints lead, in `FAL_FEATURED_IMAGE_MODEL_IDS` order.
 */
export function falImageModelChoices(live = []) {
  const byId = new Map();
  for (const family of FAL_IMAGE_FAMILIES) {
    for (const endpointId of [family.textEndpoint, family.editEndpoint]) {
      byId.set(endpointId, falEndpointChoice(endpointId));
    }
  }
  for (const row of Array.isArray(live) ? live : []) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!isPlausibleFalEndpointId(id) || byId.has(id)) continue;
    const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : id;
    byId.set(id, Object.freeze({
      id,
      label,
      featured: false,
      known: false,
      category: row.category === 'image-to-image' ? 'image-to-image' : 'text-to-image',
    }));
  }
  return Object.freeze(orderFalChoices([...byId.values()]));
}

/** Curated rows in picker order, featured first. Cold start uses this before the live list loads. */
export const FAL_IMAGE_MODEL_OPTIONS = Object.freeze(falImageModelChoices());
