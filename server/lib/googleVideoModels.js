/**
 * Google Cloud Agent Platform video model catalog — the curated Veo models the
 * `google` video backend (services/videoGen/google.js) may call, and the one
 * request builder. Dependency-free: the Video Gen picker re-exports it, so the
 * browser offers exactly the lengths, sizes and inputs the server sends.
 *
 * Every model takes `publishers/google/models/{id}:predictLongRunning` with one
 * instance (prompt, optional start frame `image`, end frame `lastFrame`, or
 * `referenceImages` of type "asset"), polled through `:fetchPredictOperation`.
 * Media travels inline as base64, so nothing is uploaded or left behind.
 *
 * Model input is sent as written (root AGENTS.md): Veo takes a native
 * `negativePrompt`, so nothing is folded into the prompt. `enhancePrompt` is not
 * sent because the Veo 3 models refuse it being turned off.
 *
 * `priceNote` is a hint from Google's list prices; the per-clip estimate
 * stays unknown (never zero) — the Cloud billing console has the real charge.
 */

const VEO_RATIOS = Object.freeze(['16:9', '9:16']);
const VEO_LENGTHS = Object.freeze([4, 6, 8]);
const VEO_TIERS = Object.freeze(['720p', '1080p']);
// Veo reads only the asset reference images at this length.
const REFERENCE_LENGTH = 8;

/**
 * Per model:
 *  - `lengths` / `defaultSec` — the whole-second lengths it accepts.
 *  - `resolutions` / `defaultResolution`.
 *  - `endFrame` — whether a start frame may be paired with a last frame.
 *  - `maxReferenceImages` — asset reference images (0 = none), never with a start frame.
 */
export const GOOGLE_VIDEO_MODELS = Object.freeze([
  Object.freeze({
    id: 'veo-3.1-generate-001', label: 'Veo 3.1', priceNote: '~$0.40/s with audio',
    lengths: VEO_LENGTHS, defaultSec: 8, resolutions: VEO_TIERS, defaultResolution: '720p',
    aspectRatios: VEO_RATIOS, endFrame: true, maxReferenceImages: 3,
  }),
  Object.freeze({
    id: 'veo-3.1-fast-generate-001', label: 'Veo 3.1 Fast', priceNote: '~$0.15/s with audio',
    lengths: VEO_LENGTHS, defaultSec: 8, resolutions: VEO_TIERS, defaultResolution: '720p',
    aspectRatios: VEO_RATIOS, endFrame: true, maxReferenceImages: 0,
  }),
  Object.freeze({
    id: 'veo-3.0-generate-001', label: 'Veo 3', priceNote: '~$0.40/s with audio',
    lengths: VEO_LENGTHS, defaultSec: 8, resolutions: VEO_TIERS, defaultResolution: '720p',
    aspectRatios: VEO_RATIOS, endFrame: false, maxReferenceImages: 0,
  }),
  Object.freeze({
    id: 'veo-3.0-fast-generate-001', label: 'Veo 3 Fast', priceNote: '~$0.15/s with audio',
    lengths: VEO_LENGTHS, defaultSec: 8, resolutions: VEO_TIERS, defaultResolution: '720p',
    aspectRatios: VEO_RATIOS, endFrame: false, maxReferenceImages: 0,
  }),
]);

export const GOOGLE_DEFAULT_VIDEO_MODEL = GOOGLE_VIDEO_MODELS[0].id;
export const GOOGLE_VIDEO_MODEL_IDS = Object.freeze(GOOGLE_VIDEO_MODELS.map((m) => m.id));
export const getGoogleVideoModel = (id) => GOOGLE_VIDEO_MODELS.find((m) => m.id === id) || null;

/**
 * The clip length (seconds) `model` will render for a request of `seconds`: the
 * shortest supported length that still COVERS it, else the longest — a Music
 * Video shot must not be under-covered and nothing loops or stretches footage.
 * An absent or invalid request gets the model's default.
 */
export function coerceGoogleVideoSeconds(model, seconds) {
  const lengths = Array.isArray(model?.lengths) ? model.lengths : VEO_LENGTHS;
  const n = Number(seconds);
  if (seconds == null || seconds === '' || !Number.isFinite(n) || n <= 0) return model?.defaultSec ?? 8;
  return lengths.find((v) => v >= n - 1e-6) ?? lengths[lengths.length - 1];
}

export const googleVideoLengths = (model) => (Array.isArray(model?.lengths) ? [...model.lengths] : [...VEO_LENGTHS]);

/** Shot settings shared by the board and server card endpoint. */
export function googleShotRequestFields(settings, spanSec = null) {
  const model = getGoogleVideoModel(settings?.googleModelId || GOOGLE_DEFAULT_VIDEO_MODEL);
  const duration = settings?.googleDuration ?? (spanSec != null ? coerceGoogleVideoSeconds(model, spanSec) : (model?.defaultSec ?? 8));
  return {
    googleModelId: settings?.googleModelId || GOOGLE_DEFAULT_VIDEO_MODEL,
    ...(settings?.googleResolution ? { googleResolution: settings.googleResolution } : {}),
    googleDuration: duration,
  };
}

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'GOOGLE_VIDEO_INPUT_INVALID' });

function nearestRatio(width, height, ratios) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0)) return null;
  const target = Math.log(w / h);
  const distance = (ratio) => { const [rw, rh] = ratio.split(':').map(Number); return Math.abs(Math.log(rw / rh) - target); };
  return ratios.reduce((best, ratio) => (distance(ratio) < distance(best) ? ratio : best));
}

/** The nearest length the model accepts, or null when none was asked for. */
function nearestLength(model, seconds) {
  const requested = Number(seconds);
  if (!(Number.isFinite(requested) && requested > 0)) return null;
  return model.lengths.reduce((best, len) => (Math.abs(len - requested) < Math.abs(best - requested) ? len : best));
}

const inlineImage = (img) => ({ bytesBase64Encoded: img.data, mimeType: img.mimeType });

/**
 * Build one request. `image` / `lastImage` / `referenceImages` are
 * `{ mimeType, data }` with base64 data (placeholders for a dry run); the route
 * is chosen from which are present. Throws a 400-shaped error rather than
 * dropping an input.
 *
 * @returns {{ model, route, body, seconds, resolution, aspectRatio, generateAudio, seed, estimatedCostUsd: null }}
 */
export function buildGoogleVideoRequest({
  modelId = GOOGLE_DEFAULT_VIDEO_MODEL, prompt = '', negativePrompt = '', seconds, resolution, width, height,
  aspectRatio, image = null, lastImage = null, referenceImages = [], generateAudio = false, seed,
}) {
  const model = getGoogleVideoModel(modelId);
  if (!model) throw refuse(`"${modelId}" is not a Google video model PortOS offers`);
  const refs = (Array.isArray(referenceImages) ? referenceImages : []).filter(Boolean);
  if (refs.length && image) throw refuse(`${model.label} takes either a start frame or reference images, not both`);
  if (refs.length && !model.maxReferenceImages) throw refuse(`${model.label} takes no reference images; use a start frame or Veo 3.1`);
  if (refs.length > model.maxReferenceImages) throw refuse(`${model.label} takes at most ${model.maxReferenceImages} reference images (received ${refs.length})`);
  if (lastImage && !image) throw refuse('An end frame needs a start frame');
  if (lastImage && !model.endFrame) throw refuse(`${model.label} takes no end frame; use Veo 3.1`);
  const route = refs.length ? 'reference' : image ? 'image' : 'text';
  const text = String(prompt ?? '').trim();
  // The image route is the one where the start frame can carry the whole instruction.
  if (!text && route !== 'image') throw refuse('Prompt is required');
  let sec = nearestLength(model, seconds);
  if (route === 'reference') {
    if (sec != null && sec !== REFERENCE_LENGTH) throw refuse(`${model.label} renders reference images only as ${REFERENCE_LENGTH}-second clips`);
    sec = REFERENCE_LENGTH;
  }
  sec ??= model.defaultSec;
  const tier = model.resolutions.includes(resolution) ? resolution : model.defaultResolution;
  const ratio = model.aspectRatios.includes(aspectRatio) ? aspectRatio : nearestRatio(width, height, model.aspectRatios);
  const audio = generateAudio === true;
  const seedNum = typeof seed === 'number' ? seed : (typeof seed === 'string' && seed.trim() ? Number(seed) : NaN);
  const validSeed = Number.isInteger(seedNum) && seedNum >= 0 && seedNum <= 4_294_967_295 ? seedNum : null;
  const negative = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';

  const instance = {
    ...(text ? { prompt: text } : {}),
    ...(route === 'image' ? { image: inlineImage(image) } : {}),
    ...(route === 'image' && lastImage ? { lastFrame: inlineImage(lastImage) } : {}),
    ...(route === 'reference' ? { referenceImages: refs.map((img) => ({ image: inlineImage(img), referenceType: 'asset' })) } : {}),
  };
  const parameters = {
    sampleCount: 1,
    durationSeconds: sec,
    resolution: tier,
    generateAudio: audio,
    ...(ratio ? { aspectRatio: ratio } : {}),
    ...(negative ? { negativePrompt: negative } : {}),
    ...(validSeed != null ? { seed: validSeed } : {}),
  };
  return {
    model, route, body: { instances: [instance], parameters },
    seconds: sec, resolution: tier, aspectRatio: ratio, generateAudio: audio, seed: validSeed, estimatedCostUsd: null,
  };
}
