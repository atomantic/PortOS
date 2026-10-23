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
// Seedream canvases are fixed pairs, not Gen-4's 720p/1080p tiers. `auto_*` lets Runway pick and is never
// chosen by aspect matching. The shared 720p/1080p render setting maps onto a tier via `resolutionMap`.
const SEEDREAM_PRO_RATIOS = Object.freeze({
  '1k': Object.freeze(['1024:1024', '1184:896', '896:1184', '1376:768', '768:1376', '1296:864', '864:1296', 'auto_1k']),
  '2k': Object.freeze(['2048:2048', '2304:1728', '1728:2304', '2720:1530', '1530:2720', '2496:1664', '1664:2496', 'auto_2k']),
});
const SEEDREAM_LITE_RATIOS = Object.freeze({
  standard: Object.freeze(['2048:2048', '2304:1728', '1728:2304', '2848:1600', '1600:2848', '2496:1664', '1664:2496', '3136:1344', '3072:3072', '3456:2592', '2592:3456', '4096:2304', '2304:4096', '3744:2496', '2496:3744', '4704:2016']),
});
const GEN4 = { ratios: RATIOS, maxReferences: 3, promptMaxChars: 1000, seed: true, referenceMode: 'tagged', defaultResolution: '720p', resolutionMap: Object.freeze({}) };
// Seedream is text-to-image with order-significant, untagged `referenceImages: [{ uri }]` (no documented count; 6 is a
// conservative ceiling) and no seed field. Credits per Runway's pricing guide.
const SEEDREAM = { maxReferences: 6, promptMaxChars: 4000, seed: false, referenceMode: 'ordered', minReferences: 0 };
export const RUNWAY_IMAGE_MODELS = Object.freeze([
  { ...GEN4, id: 'gen4_image', label: 'Runway Gen-4 Image', minReferences: 0, credits: Object.freeze({ '720p': 5, '1080p': 8 }) },
  { ...GEN4, id: 'gen4_image_turbo', label: 'Runway Gen-4 Image Turbo', minReferences: 1, credits: Object.freeze({ '720p': 2, '1080p': 2 }) },
  { ...SEEDREAM, id: 'seedream5_pro', label: 'Runway Seedream 5 Pro', ratios: SEEDREAM_PRO_RATIOS, defaultResolution: '1k', resolutionMap: Object.freeze({ '720p': '1k', '1080p': '2k' }), credits: Object.freeze({ '1k': 5, '2k': 9 }) },
  { ...SEEDREAM, id: 'seedream5_lite', label: 'Runway Seedream 5 Lite', ratios: SEEDREAM_LITE_RATIOS, defaultResolution: 'standard', resolutionMap: Object.freeze({ '720p': 'standard', '1080p': 'standard' }), credits: Object.freeze({ standard: 4 }) },
].map((row) => Object.freeze(row)));
export const RUNWAY_IMAGE_MODEL_IDS = Object.freeze(RUNWAY_IMAGE_MODELS.map((row) => row.id));
export const getRunwayImageModel = (id) => RUNWAY_IMAGE_MODELS.find((row) => row.id === id) || null;

/** Preserve caller framing using the closest supported canvas at the chosen tier. */
function runwayImageRatio(model, { width, height, resolution, ratio } = {}) {
  const tier = resolution ? (model.ratios[resolution] ? resolution : model.resolutionMap[resolution]) : model.defaultResolution;
  const ratios = model.ratios[tier];
  if (!ratios) throw refuse(`Runway ${model.id} does not support resolution ${resolution}`);
  if (ratio) {
    if (!ratios.includes(ratio)) throw refuse(`Runway ${model.id} does not support ratio ${ratio} at ${tier}`);
    return { ratio, resolution: tier };
  }
  const aspect = Number(width) > 0 && Number(height) > 0 ? Number(width) / Number(height) : 1;
  const distance = (value) => { const [w, h] = value.split(':').map(Number); return Math.abs(Math.log(w / h / aspect)); };
  const sized = ratios.filter((value) => !value.startsWith('auto_'));
  return { ratio: sized.reduce((best, value) => distance(value) < distance(best) ? value : best), resolution: tier };
}

/** Wire shape of one reference: Gen-4 addresses images by @tag; Seedream takes an ordered, untagged list. */
export const runwayReferencePayload = (model, { uri, tag }) => (model.referenceMode === 'tagged' ? { uri, tag } : { uri });

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
  const tagged = model.referenceMode === 'tagged';
  const tags = referenceImages.map((ref) => ref.tag);
  if (referenceImages.some((ref) => typeof ref.uri !== 'string' || !ref.uri || (tagged && !/^[a-z][a-z0-9_]{2,15}$/i.test(ref.tag))) || (tagged && new Set(tags).size !== tags.length)) {
    throw refuse(tagged ? 'Runway reference images require a URI and unique 3–16 character tags' : 'Runway reference images require a URI');
  }
  const sendSeed = model.seed && seed != null && seed !== -1;
  if (sendSeed && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 4294967295)) throw refuse('Runway seed must be an unsigned 32-bit integer');
  const { ratio, resolution } = runwayImageRatio(model, size);
  return {
    body: { model: model.id, promptText: prompt, ratio, ...(referenceImages.length ? { referenceImages: referenceImages.map((ref) => runwayReferencePayload(model, ref)) } : {}), ...(sendSeed ? { seed: Number(seed) } : {}) },
    resolution, referenceMode: model.referenceMode, estimatedCredits: model.credits[resolution], estimatedCostUsd: model.credits[resolution] / 100,
  };
}
