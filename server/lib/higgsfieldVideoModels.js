/**
 * Higgsfield video model catalog — the curated families the `higgsfield` video
 * backend (services/videoGen/higgsfield.js) may call, and the one request
 * builder. Dependency-free: the Video Gen picker re-exports it, so the browser
 * offers exactly the lengths, sizes and inputs the server sends.
 *
 * The user picks a FAMILY; the builder routes to its text-to-video,
 * image-to-video or reference-to-video endpoint from the inputs the render
 * carries. Schemas were read from docs.higgsfield.ai workflow pages on
 * 2026-11-10. Prices there are "from" rates only (open.higgsfield.ai/pricing),
 * so `priceNote` is shown as a hint and the per-clip estimate stays unknown.
 *
 * Model input is sent as written (root AGENTS.md): no endpoint here takes a
 * negative prompt, so one rides as a visible "Avoid:" clause, and Wan's
 * `enable_thinking` rewrite knob is sent off.
 */

const SEEDANCE_RATIOS = Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
const WAN_RATIOS = Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16']);
const KLING_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
const TIERS = Object.freeze(['480p', '720p', '1080p']);

/**
 * Per family:
 *  - `endpoints` — `{ text, image, reference }` endpoint ids (null when absent).
 *  - `duration` — `{ min, max, defaultSec }` in whole seconds.
 *  - `resolutions` / `defaultResolution` — null when the endpoint has no tier.
 *  - `textRatios` / `referenceRatios` — the aspect_ratio enum per route (the
 *     image route follows its start frame and takes none).
 *  - `endFrameField` — the image route's last-frame field, or null.
 *  - `maxReferenceImages` — the reference route's `image_urls` cap (0 = none).
 *  - `audio` — how native audio is toggled: 'generate_audio' | 'sound' | null.
 *  - `seed` — `{ min, max }` or null; `promptMax` — characters, or null.
 */
export const HIGGSFIELD_VIDEO_MODELS = Object.freeze([
  Object.freeze({
    id: 'bytedance/seedance-2.5', label: 'Seedance 2.5', priceNote: 'from ~$0.21/s',
    endpoints: Object.freeze({
      text: 'bytedance/seedance-2.5/text-to-video',
      image: 'bytedance/seedance-2.5/image-to-video',
      reference: 'bytedance/seedance-2.5/reference-to-video',
    }),
    duration: Object.freeze({ min: 4, max: 30, defaultSec: 5 }),
    resolutions: TIERS, defaultResolution: '720p',
    textRatios: SEEDANCE_RATIOS, referenceRatios: SEEDANCE_RATIOS,
    endFrameField: 'end_image_url', maxReferenceImages: 30, maxReferenceAudio: 10,
    audio: 'generate_audio', seed: null, promptMax: null, fixed: Object.freeze({}),
  }),
  Object.freeze({
    id: 'kling-video/v3.0/pro', label: 'Kling 3.0 Pro', priceNote: '~$0.084/s',
    endpoints: Object.freeze({
      text: 'kling-video/v3.0/pro/text-to-video', image: 'kling-video/v3.0/pro/image-to-video', reference: null,
    }),
    duration: Object.freeze({ min: 3, max: 15, defaultSec: 5 }),
    resolutions: null, defaultResolution: null,
    textRatios: KLING_RATIOS, referenceRatios: null,
    endFrameField: 'last_image_url', maxReferenceImages: 0,
    // Kling truncates a longer prompt silently, so PortOS refuses past it instead.
    audio: 'sound', seed: null, promptMax: 2500, fixed: Object.freeze({}),
  }),
  Object.freeze({
    id: 'kling-video/v3.0/std', label: 'Kling 3.0 Standard', priceNote: '~$0.063/s',
    endpoints: Object.freeze({
      text: 'kling-video/v3.0/std/text-to-video', image: 'kling-video/v3.0/std/image-to-video', reference: null,
    }),
    duration: Object.freeze({ min: 3, max: 15, defaultSec: 5 }),
    resolutions: null, defaultResolution: null,
    textRatios: KLING_RATIOS, referenceRatios: null,
    endFrameField: 'last_image_url', maxReferenceImages: 0,
    audio: 'sound', seed: null, promptMax: 2500, fixed: Object.freeze({}),
  }),
  Object.freeze({
    id: 'alibaba/wan-3.0', label: 'Wan 3.0', priceNote: 'from ~$0.05/s',
    endpoints: Object.freeze({
      text: 'alibaba/wan-3.0/text-to-video',
      image: 'alibaba/wan-3.0/image-to-video',
      reference: 'alibaba/wan-3.0/reference-to-video',
    }),
    duration: Object.freeze({ min: 2, max: 30, defaultSec: 5 }),
    resolutions: TIERS, defaultResolution: '1080p',
    textRatios: WAN_RATIOS, referenceRatios: WAN_RATIOS,
    endFrameField: 'end_image_url', maxReferenceImages: 10,
    audio: 'generate_audio', seed: Object.freeze({ min: 1, max: 2_147_483_647 }), promptMax: null,
    fixed: Object.freeze({ enable_thinking: false }),
  }),
]);

export const HIGGSFIELD_DEFAULT_VIDEO_MODEL = HIGGSFIELD_VIDEO_MODELS[0].id;
export const HIGGSFIELD_VIDEO_MODEL_IDS = Object.freeze(HIGGSFIELD_VIDEO_MODELS.map((m) => m.id));
export const getHiggsfieldVideoModel = (id) => HIGGSFIELD_VIDEO_MODELS.find((m) => m.id === id) || null;

/** Every whole-second length the family accepts, for a picker. */
export const higgsfieldVideoLengths = (model) => (model
  ? Array.from({ length: model.duration.max - model.duration.min + 1 }, (_, i) => model.duration.min + i)
  : []);

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'HIGGSFIELD_VIDEO_INPUT_INVALID' });

function nearestRatio(width, height, ratios) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0)) return null;
  const target = Math.log(w / h);
  const distance = (ratio) => { const [rw, rh] = ratio.split(':').map(Number); return Math.abs(Math.log(rw / rh) - target); };
  return ratios.reduce((best, ratio) => (distance(ratio) < distance(best) ? ratio : best));
}

/** The prompt text the model receives: the user's words plus a folded "Avoid:" clause. */
export const higgsfieldVideoPromptText = (prompt = '', negativePrompt = '') => {
  const negative = typeof negativePrompt === 'string' ? negativePrompt : '';
  const base = String(prompt ?? '');
  return negative ? `${base}\nAvoid: ${negative}` : base;
};

/**
 * Build one request. `imageUrl` / `endImageUrl` / `referenceImageUrls` may be
 * placeholders for a dry run; the route is chosen from which are present.
 * Throws a 400-shaped error rather than dropping or truncating an input.
 *
 * @returns {{ model, route, endpointId, body, seconds, resolution, generateAudio, estimatedCostUsd: null }}
 */
export function buildHiggsfieldVideoRequest({
  modelId = HIGGSFIELD_DEFAULT_VIDEO_MODEL, prompt = '', negativePrompt = '', seconds, resolution, width, height,
  aspectRatio, imageUrl = null, endImageUrl = null, referenceImageUrls = [], audioUrls = [], generateAudio = false, seed,
}) {
  const model = getHiggsfieldVideoModel(modelId);
  if (!model) throw refuse(`"${modelId}" is not a Higgsfield video model PortOS offers`);
  const refs = (Array.isArray(referenceImageUrls) ? referenceImageUrls : []).filter(Boolean);
  if (refs.length && imageUrl) throw refuse(`${model.label} takes either a start frame or reference images, not both`);
  if (refs.length && !model.endpoints.reference) throw refuse(`${model.label} takes no reference images; use a start frame instead`);
  if (refs.length > model.maxReferenceImages) throw refuse(`${model.label} takes at most ${model.maxReferenceImages} reference images (received ${refs.length})`);
  if (endImageUrl && !imageUrl) throw refuse('An end frame needs a start frame');
  if (endImageUrl && !model.endFrameField) throw refuse(`${model.label} takes no end frame`);
  if (audioUrls.length > (model.maxReferenceAudio || 0)) throw refuse(`${model.label} takes at most ${model.maxReferenceAudio || 0} audio references (received ${audioUrls.length})`);
  const route = refs.length || audioUrls.length ? 'reference' : imageUrl ? 'image' : 'text';
  const text = higgsfieldVideoPromptText(prompt, negativePrompt);
  // The image route is the one where the start frame can carry the whole instruction.
  if (!text && route !== 'image') throw refuse('Prompt is required');
  if (model.promptMax && text.length > model.promptMax) {
    throw refuse(`${model.label} prompt is ${text.length}/${model.promptMax} characters. Shorten it; nothing was submitted or truncated.`);
  }
  const requested = Number(seconds);
  const sec = Number.isFinite(requested) && requested > 0
    ? Math.min(model.duration.max, Math.max(model.duration.min, Math.round(requested)))
    : model.duration.defaultSec;
  const tier = model.resolutions ? (model.resolutions.includes(resolution) ? resolution : model.defaultResolution) : null;
  const body = { ...model.fixed, duration: sec };
  if (text) body.prompt = text;
  if (tier) body.resolution = tier;
  const ratios = route === 'text' ? model.textRatios : route === 'reference' ? model.referenceRatios : null;
  if (ratios) {
    const ratio = ratios.includes(aspectRatio) ? aspectRatio : nearestRatio(width, height, ratios);
    if (ratio) body.aspect_ratio = ratio;
  }
  if (route === 'image') {
    body.image_url = imageUrl;
    if (endImageUrl) body[model.endFrameField] = endImageUrl;
  }
  if (route === 'reference' && refs.length) body.image_urls = refs;
  if (audioUrls.length) body.audio_urls = audioUrls;
  const audio = generateAudio === true;
  if (model.audio === 'generate_audio') body.generate_audio = audio;
  if (model.audio === 'sound') body.sound = audio ? 'on' : 'off';
  const seedNum = typeof seed === 'number' ? seed : (typeof seed === 'string' && seed.trim() ? Number(seed) : NaN);
  if (model.seed && Number.isInteger(seedNum) && seedNum >= model.seed.min && seedNum <= model.seed.max) body.seed = seedNum;
  return {
    model, route, endpointId: model.endpoints[route], body, seconds: sec, resolution: tier, generateAudio: audio, estimatedCostUsd: null,
  };
}

/** Shot settings shared by the board and server card endpoint. */
export function higgsfieldShotRequestFields(settings, spanSec = null) {
  const model = getHiggsfieldVideoModel(settings.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL);
  const duration = settings.higgsfieldDuration ?? (spanSec != null ? Math.ceil(spanSec) : 5);
  if (model && duration > model.duration.max) throw refuse(`${model.label} takes at most ${model.duration.max} seconds; shorten the shot or choose another model`);
  return {
    higgsfieldModelId: settings.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL,
    ...(settings.higgsfieldResolution ? { higgsfieldResolution: settings.higgsfieldResolution } : {}),
    higgsfieldDuration: duration,
  };
}
