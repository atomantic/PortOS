/** Curated native Runway image schemas and list prices, verified 2026-10-22.
 * Sources: https://docs.dev.runwayml.com/api.md and guides/pricing.md;
 * https://github.com/runwayml/sdk-node/blob/main/src/resources/text-to-image.ts
 * Dependency-free: shared by the server and browser model pickers.
 */
import { RUNWAY_CATALOG_SNAPSHOT } from './runwayCatalogSnapshot.js';

export const RUNWAY_IMAGE_PRICING_VERIFIED_AT = '2026-10-22';
const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'RUNWAY_IMAGE_INPUT_INVALID' });
export const RUNWAY_IMAGE_DEFAULT_MODEL = 'gen4_image';
export const RUNWAY_IMAGE_DISCLOSURE = Object.freeze({
  execution: 'hosted', provider: 'Runway',
  summary: 'Prompts and reference images leave this machine and are sent to Runway.',
  termsUrl: 'https://runwayml.com/terms-of-use',
  billing: 'Each image is billed. Moderated tasks are not retried.',
});
const RATIOS = Object.freeze({
  '720p': Object.freeze(['1280:720', '720:1280', '720:720', '960:720', '720:960', '1680:720']),
  '1080p': Object.freeze(['1920:1080', '1080:1920', '1024:1024', '1080:1080', '1360:768', '1168:880', '1440:1080', '1080:1440', '1808:768', '2112:912']),
});
const LABELS = {
  gen4_image: 'Runway Gen-4 Image', gen4_image_turbo: 'Runway Gen-4 Image Turbo',
  gpt_image_2: 'GPT Image 2', gpt_image_2_5_flare: 'GPT Image 2.5 Flare', gpt_image_2_5_sunburst: 'GPT Image 2.5 Sunburst',
  'gemini_image3.1_flash': 'Nano Banana 2', 'gemini_image3.1_flash_lite': 'Nano Banana 2 Lite',
  gemini_image3_pro: 'Nano Banana Pro', 'gemini_2.5_flash': 'Nano Banana', 'nano_banana_2.1': 'Nano Banana 2.1',
  muse_image: 'Muse Image', seedream5_pro: 'Seedream 5.0 Pro', seedream5_lite: 'Seedream 5.0 Lite', seedream5_flash: 'Seedream 5.0 Flash',
  grok_imagine_image_2: 'Grok Imagine Image 2', bria_fibo_1_5: 'FIBO 1.5', bria_fibo_edit_1_5: 'FIBO Edit 1.5',
  ideogram_4_0: 'Ideogram 4.0', ideogram_4_5: 'Ideogram 4.5',
};
// Preserve the native Gen-4 tier settings on existing installs. Other vendors
// expose exact canvases: do not invent resolution tiers from their pixel area.
function imageRatios(row) {
  if (row.id.startsWith('gen4_')) return RATIOS;
  const canvases = row.ratios.filter((r) => /^\d+:\d+$/.test(r));
  return { auto: canvases, ...Object.fromEntries(canvases.map((r) => [r, [r]])) };
}
export const RUNWAY_IMAGE_MODELS = Object.freeze(RUNWAY_CATALOG_SNAPSHOT.text_to_image.map((row) => {
  const ratios = imageRatios(row);
  return Object.freeze({
    id: row.id, label: LABELS[row.id] || row.id, ratios, defaultResolution: Object.keys(ratios)[0],
    minReferences: row.id === 'bria_fibo_edit_1_5' ? 1 : row.minReferences,
    maxReferences: row.maxReferences, referenceTags: row.referenceTags,
    seedMax: row.seedMax,
    promptMinChars: row.promptMin, promptMaxChars: row.promptMax, seed: row.seed,
    // Unknown prices remain unknown, never zero. The API returns actual cost separately.
    credits: row.id === 'gen4_image' ? { '720p': 5, '1080p': 8 } : row.id === 'gen4_image_turbo' ? { '720p': 2, '1080p': 2 } : {},
  });
}));
export const RUNWAY_IMAGE_RESOLUTIONS = Object.freeze([...new Set(RUNWAY_IMAGE_MODELS.flatMap((m) => Object.keys(m.ratios)))]);
export const RUNWAY_IMAGE_MODEL_IDS = Object.freeze(RUNWAY_IMAGE_MODELS.map((row) => row.id));
export const getRunwayImageModel = (id) => RUNWAY_IMAGE_MODELS.find((row) => row.id === id) || null;

/** FIBO Edit with a single reference keeps the source framing. */
export const runwayImagePreservesSourceFrame = (modelId, referenceCount) => modelId === 'bria_fibo_edit_1_5' && referenceCount === 1;

/** Preserve caller framing using the closest supported canvas at the chosen tier. */
function runwayImageRatio(model, { width, height, resolution, ratio } = {}) {
  const ratios = model.ratios[resolution || model.defaultResolution];
  if (!ratios) throw refuse(`Runway ${model.id} resolution must be ${Object.keys(model.ratios).join(" or ")}`);
  if (ratio) {
    if (!ratios.includes(ratio)) throw refuse(`Runway ${model.id} does not support ratio ${ratio} at ${resolution}`);
    return ratio;
  }
  const aspect = Number(width) > 0 && Number(height) > 0 ? Number(width) / Number(height) : 1;
  const distance = (value) => { const [w, h] = value.split(':').map(Number); return Math.abs(Math.log(w / h / aspect)); };
  return ratios.reduce((best, value) => distance(value) < distance(best) ? value : best);
}

/** Tags identify bindings across renders; supplemental images get distinct suffixes. */
export function runwayReferenceTags(references = []) {
  const used = new Set();
  return references.map((ref, index) => {
    const identity = String(ref.bindingId || `reference_${index + 1}`);
    let hash = 2166136261;
    for (let i = 0; i < identity.length; i += 1) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619) >>> 0;
    const prefix = ref.role?.startsWith('character') ? 'char' : ref.role === 'environment' ? 'place' : 'ref';
    const base = `${prefix}_${hash.toString(36)}`;
    let tag = base;
    for (let suffix = 2; used.has(tag); suffix += 1) tag = `${base}_${suffix}`;
    used.add(tag);
    return { ...ref, tag };
  });
}

export function buildRunwayImageRequest({ modelId = RUNWAY_IMAGE_DEFAULT_MODEL, prompt, referenceImages = [], seed, ...size }) {
  const model = getRunwayImageModel(modelId);
  if (!model) throw refuse(`Unknown Runway image model: ${modelId}`);
  if (typeof prompt !== 'string' || prompt.trim().length < model.promptMinChars || prompt.length > model.promptMaxChars) {
    throw refuse(`Runway ${modelId} prompt must contain 1–${model.promptMaxChars} characters (received ${prompt?.length ?? 0})`);
  }
  if (referenceImages.length < model.minReferences || referenceImages.length > model.maxReferences) {
    throw refuse(`Runway ${modelId} requires ${model.minReferences}–${model.maxReferences} reference images`);
  }
  const tags = referenceImages.map((ref) => ref.tag);
  if (referenceImages.some((ref) => typeof ref.uri !== 'string' || !ref.uri || (model.referenceTags && !/^[a-z][a-z0-9_]{2,15}$/.test(ref.tag))) || (model.referenceTags && new Set(tags).size !== tags.length)) {
    throw refuse('Runway reference images require a URI and unique 3–16 character tags');
  }
  if (model.seed && seed != null && seed !== -1 && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > model.seedMax)) throw refuse(`Runway seed must be a nonnegative 32-bit integer no greater than ${model.seedMax}`);
  const preservesSourceFrame = runwayImagePreservesSourceFrame(modelId, referenceImages.length);
  if (preservesSourceFrame && (size.ratio || (size.resolution && size.resolution !== 'auto'))) throw refuse('FIBO Edit needs at least two references to choose a canvas; one reference keeps its source framing');
  const ratio = preservesSourceFrame ? null : runwayImageRatio(model, size);
  const resolution = size.resolution || model.defaultResolution;
  const wireReferences = referenceImages.map(({ uri, tag }) => ({ uri, ...(model.referenceTags ? { tag } : {}) }));
  return {
    body: { model: model.id, promptText: prompt, ...(ratio ? { ratio } : {}), ...(referenceImages.length ? { referenceImages: wireReferences } : {}), ...(model.seed && seed != null && seed !== -1 ? { seed: Number(seed) } : {}) },
    resolution, estimatedCredits: model.credits[resolution] ?? null, estimatedCostUsd: model.credits[resolution] == null ? null : model.credits[resolution] / 100,
  };
}
