/**
 * Higgsfield video model catalog — the curated families the `higgsfield` video backend
 * (services/videoGen/higgsfield.js) may call, and the one request builder.
 *
 * Curated Higgsfield video families (dependency-free, shared with the client):
 * `HIGGSFIELD_VIDEO_MODELS`, `getHiggsfieldVideoModel`, `higgsfieldCapabilityHint` (picker hint: refs,
 * end frame, audio), `higgsfieldVideoLengths` and `buildHiggsfieldVideoRequest` (routes text /
 * start-frame / reference endpoints from the inputs).
 *
 * Dependency-free: the Video Gen picker re-exports it, so the browser offers exactly the lengths,
 * sizes and inputs the server sends.
 *
 * The user picks a FAMILY; the builder routes to its text-to-video,
 * image-to-video or reference-to-video endpoint from the inputs the render
 * carries. Schemas were read from docs.higgsfield.ai workflow pages on
 * 2026-11-10. `rates` are the per-second list prices by route and resolution that
 * open.higgsfield.ai/pricing published on HIGGSFIELD_VIDEO_PRICING_VERIFIED_AT;
 * `higgsfieldVideoClipQuote` prices one clip from them, so Music Video spend
 * counts Higgsfield renders (#16506). They are estimates: the account balance
 * is the final word, and a tier with no listed rate prices as unknown.
 *
 * Model input is sent as written (root AGENTS.md): no endpoint here takes a
 * negative prompt, so one rides as a visible "Avoid:" clause, and Wan's
 * `enable_thinking` rewrite knob is sent off.
 */
import { nearestRatio } from './aspectRatios.js';

import { durationLengths } from './hostedVideoClipRules.js';

const SEEDANCE_RATIOS = Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);
const WAN_RATIOS = Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16']);
const KLING_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
const KLING4_TEXT_RATIOS = Object.freeze(['21:9', '16:9', '9:16', '1:1']);
const KLING4_REFERENCE_RATIOS = Object.freeze([...KLING4_TEXT_RATIOS, 'adaptive']);

// Kling 4 families share every field but length, resolution tiers and end-frame support.
const klingV4 = ({ id, resolutions, maxSec, endFrameField, rates, ...label }) => Object.freeze({
  id, ...label, rates: freezeRates(rates),
  endpoints: Object.freeze({ text: `${id}/text-to-video`, image: `${id}/image-to-video`, reference: `${id}/reference-to-video` }),
  duration: Object.freeze({ min: 3, max: maxSec, defaultSec: 5 }),
  resolutions: Object.freeze(resolutions), defaultResolution: resolutions.at(-1),
  textRatios: KLING4_TEXT_RATIOS, referenceRatios: KLING4_REFERENCE_RATIOS,
  endFrameField, maxReferenceImages: 10,
  audio: null, seed: null, promptMax: null, fixed: Object.freeze({}),
});
const TIERS = Object.freeze(['480p', '720p', '1080p']);

export const HIGGSFIELD_VIDEO_PRICING_VERIFIED_AT = '2026-11-16';
// A family with no resolution tier keys its one rate by NO_TIER.
const NO_TIER = 'default';
function freezeRates(rates) {
  return Object.freeze(Object.fromEntries(Object.entries(rates).map(([route, byTier]) => [route, Object.freeze({ ...byTier })])));
}

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
 *  - `rates` — `{ text, image, reference }`, each USD per second by resolution
 *     (`default` for a family with no tier); a missing route or tier is unpriced.
 *  - `soundRateMultiplier` — the rate factor with native audio on, when listed.
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
    // The reference route's 720p rate is the one its other reference-input routes list (video edit, extend).
    rates: freezeRates({
      text: { '480p': 0.1177, '720p': 0.2647, '1080p': 0.6518 },
      image: { '480p': 0.1177, '720p': 0.2647, '1080p': 0.6518 },
      reference: { '480p': 0.1387, '720p': 0.3264, '1080p': 0.7858 },
    }),
  }),
  // Kling 4: schemas read from console.higgsfield.ai model pages on 2026-11-13. It has no
  // audio toggle, and the image route takes no aspect ratio. Reference video_urls and
  // Kling element ids are not offered. Flash's endpoints reject unknown fields.
  klingV4({
    id: 'kling-video/v4.0', label: 'Kling 4.0', priceNote: 'from ~$0.126/s', maxSec: 30, resolutions: ['720p', '1080p'], endFrameField: 'end_image_url',
    rates: { text: { '720p': 0.1257, '1080p': 0.1879 }, image: { '720p': 0.1257, '1080p': 0.1879 }, reference: { '720p': 0.1544, '1080p': 0.1879 } },
  }),
  klingV4({
    id: 'kling-video/v4.0-flash', label: 'Kling 4.0 Flash', priceNote: '~$0.094/s', maxSec: 20, resolutions: ['720p'], endFrameField: null,
    // Higgsfield lists no reference-route rate for Flash, so a reference take prices as unknown.
    rates: { text: { '720p': 0.094 }, image: { '720p': 0.094 } },
  }),
  Object.freeze({
    id: 'kling-video/v3.0/pro', label: 'Kling 3.0 Pro', priceNote: '~$0.096/s',
    endpoints: Object.freeze({
      text: 'kling-video/v3.0/pro/text-to-video', image: 'kling-video/v3.0/pro/image-to-video', reference: null,
    }),
    duration: Object.freeze({ min: 3, max: 15, defaultSec: 5 }),
    resolutions: null, defaultResolution: null,
    textRatios: KLING_RATIOS, referenceRatios: null,
    endFrameField: 'last_image_url', maxReferenceImages: 0,
    // Kling truncates a longer prompt silently, so PortOS refuses past it instead.
    audio: 'sound', seed: null, promptMax: 2500, fixed: Object.freeze({}),
    // Higgsfield lists $0.0962–$0.1443/s; the top of the range is the 1.5x Kling charges with sound on.
    rates: freezeRates({ text: { [NO_TIER]: 0.0962 }, image: { [NO_TIER]: 0.0962 } }), soundRateMultiplier: 1.5,
  }),
  Object.freeze({
    id: 'kling-video/v3.0/std', label: 'Kling 3.0 Standard', priceNote: '~$0.071/s',
    endpoints: Object.freeze({
      text: 'kling-video/v3.0/std/text-to-video', image: 'kling-video/v3.0/std/image-to-video', reference: null,
    }),
    duration: Object.freeze({ min: 3, max: 15, defaultSec: 5 }),
    resolutions: null, defaultResolution: null,
    textRatios: KLING_RATIOS, referenceRatios: null,
    endFrameField: 'last_image_url', maxReferenceImages: 0,
    audio: 'sound', seed: null, promptMax: 2500, fixed: Object.freeze({}),
    rates: freezeRates({ text: { [NO_TIER]: 0.0714 }, image: { [NO_TIER]: 0.0714 } }), soundRateMultiplier: 1.5,
  }),
  Object.freeze({
    id: 'alibaba/wan-3.0', label: 'Wan 3.0', priceNote: 'from ~$0.0375/s',
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
    // The reference route lists 480p and 1080p at the other routes' rates; 720p follows them too.
    rates: freezeRates({
      text: { '480p': 0.0375, '720p': 0.075, '1080p': 0.15 },
      image: { '480p': 0.0375, '720p': 0.075, '1080p': 0.15 },
      reference: { '480p': 0.0375, '720p': 0.075, '1080p': 0.15 },
    }),
  }),
]);

export const HIGGSFIELD_DEFAULT_VIDEO_MODEL = HIGGSFIELD_VIDEO_MODELS[0].id;
/** Every endpoint id the curated families call. */
export const HIGGSFIELD_VIDEO_ENDPOINT_IDS = Object.freeze(HIGGSFIELD_VIDEO_MODELS.flatMap((m) => Object.values(m.endpoints).filter(Boolean)));
export const HIGGSFIELD_VIDEO_MODEL_IDS = Object.freeze(HIGGSFIELD_VIDEO_MODELS.map((m) => m.id));
export const getHiggsfieldVideoModel = (id) => HIGGSFIELD_VIDEO_MODELS.find((m) => m.id === id) || null;

/** Every whole-second length the family accepts, for a picker. */
export const higgsfieldVideoLengths = (model) => durationLengths(model?.duration);

/** Picker hint for which inputs a family takes beyond text, e.g. "refs ≤30 · end frame · audio refs". */
export function higgsfieldCapabilityHint(model) {
  if (!model) return '';
  return [
    model.endpoints.reference ? `refs ≤${model.maxReferenceImages}` : 'no refs',
    model.endFrameField ? 'end frame' : null,
    model.maxReferenceAudio ? 'audio refs' : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The list price of one clip: `{ costUsd, ratePerSec }`, or null when the family,
 * route or tier has no listed rate. `seconds` is the billed length the request sends.
 */
export function higgsfieldVideoClipQuote({ modelId, route, seconds, resolution = null, generateAudio = false } = {}) {
  const model = getHiggsfieldVideoModel(modelId);
  const base = model?.rates?.[route]?.[model.resolutions ? resolution : NO_TIER];
  const sec = Number(seconds);
  if (!Number.isFinite(base) || !(sec > 0)) return null;
  const ratePerSec = generateAudio === true && model.soundRateMultiplier ? base * model.soundRateMultiplier : base;
  return { costUsd: Math.round(ratePerSec * sec * 1e4) / 1e4, ratePerSec };
}

/**
 * The line PortOS adds when a shot's start frame rides as the first reference image, so the
 * reference endpoint (which has no first-frame field) still opens on it. Shown as a chip.
 */
export const HIGGSFIELD_FRAME_ROLE_LINE = 'The first reference image is the opening frame of the shot: begin exactly from it and keep its place, light, framing and people.';

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'HIGGSFIELD_VIDEO_INPUT_INVALID' });

// Non-numeric ratios ('adaptive') are only ever an explicit pick, never the nearest match.
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
 * @returns {{ model, route, endpointId, body, seconds, resolution, generateAudio, estimatedCostUsd, frameAsReference, silentNotice }}
 *   `estimatedCostUsd` is the list price (`higgsfieldVideoClipQuote`), or null when unlisted.
 */
export function buildHiggsfieldVideoRequest({
  modelId = HIGGSFIELD_DEFAULT_VIDEO_MODEL, prompt = '', negativePrompt = '', seconds, resolution, width, height,
  aspectRatio, imageUrl = null, endImageUrl = null, referenceImageUrls = [], audioUrls = [], generateAudio = false, seed,
}) {
  const model = getHiggsfieldVideoModel(modelId);
  if (!model) throw refuse(`"${modelId}" is not a Higgsfield video model PortOS offers`);
  let refs = (Array.isArray(referenceImageUrls) ? referenceImageUrls : []).filter(Boolean);
  // The reference endpoints have no first-frame field: a start frame plus references goes as
  // the first reference image, and the prompt says it is the opening frame.
  const frameAsReference = Boolean(refs.length && imageUrl && model.endpoints.reference);
  if (refs.length && imageUrl && !frameAsReference) throw refuse(`${model.label} takes either a start frame or reference images, not both`);
  if (frameAsReference && endImageUrl) throw refuse(`${model.label} cannot combine an end frame with reference images; remove the end frame or the references`);
  if (frameAsReference) { refs = [imageUrl, ...refs]; imageUrl = null; }
  if (refs.length && !model.endpoints.reference) throw refuse(`${model.label} takes no reference images; use a start frame instead`);
  if (refs.length > model.maxReferenceImages) throw refuse(`${model.label} takes at most ${model.maxReferenceImages} reference images (received ${refs.length})`);
  if (endImageUrl && !imageUrl) throw refuse('An end frame needs a start frame');
  if (endImageUrl && !model.endFrameField) throw refuse(`${model.label} takes no end frame`);
  if (audioUrls.length > (model.maxReferenceAudio || 0)) throw refuse(`${model.label} takes at most ${model.maxReferenceAudio || 0} audio references (received ${audioUrls.length})`);
  // Anchored frames cannot ride with reference audio: the take renders silent (a cutaway's
  // song is its soundtrack anyway) and says so instead of refusing the shot.
  const frameAnchored = Boolean(imageUrl) || (frameAsReference && audioUrls.length > 0);
  const silentNotice = frameAnchored && audioUrls.length
    ? `Rendered without song audio: ${model.label} cannot combine a start frame with reference audio.` : null;
  if (silentNotice) audioUrls = [];
  const route = refs.length || audioUrls.length ? 'reference' : imageUrl ? 'image' : 'text';
  const text = higgsfieldVideoPromptText(prompt, negativePrompt) + (frameAsReference ? `\n${HIGGSFIELD_FRAME_ROLE_LINE}` : '');
  // The image route is the one where the start frame can carry the whole instruction.
  if (!String(prompt ?? '').trim() && !String(negativePrompt ?? '').trim() && route !== 'image') throw refuse('Prompt is required');
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
  const estimatedCostUsd = higgsfieldVideoClipQuote({ modelId: model.id, route, seconds: sec, resolution: tier, generateAudio: audio })?.costUsd ?? null;
  return {
    model, route, endpointId: model.endpoints[route], body, seconds: sec, resolution: tier, generateAudio: audio, estimatedCostUsd, frameAsReference, silentNotice,
  };
}

/** Shot settings shared by the board and server card endpoint. */
export function higgsfieldShotRequestFields(settings, spanSec = null) {
  const model = getHiggsfieldVideoModel(settings.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL);
  const duration = settings.higgsfieldDuration ?? Math.max(model?.duration.min || 1, spanSec != null ? Math.ceil(spanSec) : model?.duration.defaultSec || 5);
  if (model && duration > model.duration.max) throw refuse(`${model.label} takes at most ${model.duration.max} seconds; shorten the shot or choose another model`);
  return {
    higgsfieldModelId: settings.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL,
    ...(settings.higgsfieldResolution ? { higgsfieldResolution: settings.higgsfieldResolution } : {}),
    higgsfieldDuration: duration,
  };
}
