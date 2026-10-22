/** Curated native Runway image schemas and list prices, verified 2026-10-22.
 * Sources: https://docs.dev.runwayml.com/api.md and guides/pricing.md;
 * https://github.com/runwayml/sdk-node/blob/main/src/resources/text-to-image.ts
 * Dependency-free: shared by the server and browser model pickers.
 */
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
export const RUNWAY_IMAGE_MODELS = Object.freeze([
  { id: 'gen4_image', label: 'Runway Gen-4 Image', minReferences: 0, credits: Object.freeze({ '720p': 5, '1080p': 8 }) },
  { id: 'gen4_image_turbo', label: 'Runway Gen-4 Image Turbo', minReferences: 1, credits: Object.freeze({ '720p': 2, '1080p': 2 }) },
].map((row) => Object.freeze({ ...row, ratios: RATIOS, maxReferences: 3, promptMaxChars: 1000, seed: true })));
export const RUNWAY_IMAGE_MODEL_IDS = Object.freeze(RUNWAY_IMAGE_MODELS.map((row) => row.id));
export const getRunwayImageModel = (id) => RUNWAY_IMAGE_MODELS.find((row) => row.id === id) || null;

/** Preserve caller framing using the closest supported canvas at the chosen tier. */
export function runwayImageRatio(model, { width, height, resolution = '720p', ratio } = {}) {
  const ratios = model.ratios[resolution];
  if (!ratios) throw refuse(`Runway image resolution must be 720p or 1080p`);
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
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > model.promptMaxChars) {
    throw refuse(`Runway ${modelId} prompt must contain 1–${model.promptMaxChars} characters (received ${prompt?.length ?? 0})`);
  }
  if (referenceImages.length < model.minReferences || referenceImages.length > model.maxReferences) {
    throw refuse(`Runway ${modelId} requires ${model.minReferences}–${model.maxReferences} reference images`);
  }
  const tags = referenceImages.map((ref) => ref.tag);
  if (referenceImages.some((ref) => typeof ref.uri !== 'string' || !ref.uri || !/^[a-z][a-z0-9_]{2,15}$/i.test(ref.tag)) || new Set(tags).size !== tags.length) {
    throw refuse('Runway reference images require a URI and unique 3–16 character tags');
  }
  if (seed != null && seed !== -1 && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 4294967295)) throw refuse('Runway seed must be an unsigned 32-bit integer');
  const ratio = runwayImageRatio(model, size);
  const resolution = size.resolution || '720p';
  return {
    body: { model: model.id, promptText: prompt, ratio, ...(referenceImages.length ? { referenceImages } : {}), ...(seed != null && seed !== -1 ? { seed: Number(seed) } : {}) },
    resolution, estimatedCredits: model.credits[resolution], estimatedCostUsd: model.credits[resolution] / 100,
  };
}
