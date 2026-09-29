/**
 * Curated fal.ai VIDEO model catalog (#8977 follow-up) — what PortOS knows
 * about each fal video endpoint it offers: the request-body shape (parameter
 * names and wire types differ per family), the duration / resolution / aspect
 * rules, which optional inputs it accepts, and its published price.
 *
 * Every entry was checked against fal's own queue OpenAPI schema
 * (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`) and the
 * model page's pricing text on FAL_VIDEO_PRICING_VERIFIED_AT. fal changes these;
 * when a render is rejected with a 422 or a bill disagrees with an estimate,
 * re-check the schema and pricing text for that endpoint and edit its row.
 *
 * A model id NOT in this catalog (the Video Gen page keeps a free-text model
 * box) still renders — `buildFalVideoRequest()` returns null and the provider
 * falls back to the legacy Hailuo-shaped body — but its cost is unknown (null),
 * so a USD spend cap refuses it rather than guessing.
 *
 * Pricing is deliberately the LIST price. Two MiniMax H3 image-to-video routes
 * were on a 50%-off launch promotion when this was written; an estimate that
 * assumed the promo would under-count spend the day it ends, and an estimate
 * feeds the Music Video autopilot's dollar cap. Over-estimating a cap is safe;
 * under-estimating it is not.
 *
 * Dependency-free so `client/src/lib/falVideoModels.js` can re-export it and the
 * board, the provider and the autopilot price a take identically.
 */

/** Date the schemas and prices below were last verified against fal.ai. */
export const FAL_VIDEO_PRICING_VERIFIED_AT = '2026-09-29';

/** What an entry renders from: text, a start frame, reference assets, or a frame + source audio. */
export const FAL_VIDEO_KINDS = Object.freeze(['t2v', 'i2v', 'ref2v', 'lipsync']);

export const FAL_DEFAULT_TEXT_VIDEO_MODEL = 'fal-ai/minimax/hailuo-02/standard/text-to-video';
export const FAL_DEFAULT_IMAGE_VIDEO_MODEL = 'fal-ai/minimax/hailuo-02/standard/image-to-video';
export const FAL_LIPSYNC_VIDEO_MODEL = 'minimax/h3-max/lip-sync/image-to-video';

const H3_RESOLUTIONS = Object.freeze(['480P', '768P', '1080P']);
const SEEDANCE_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p']);
const WIDE_ASPECTS = Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
// H3 Max list rates (the lip-sync and reference routes are billed at these; the
// image-to-video route was 50% off at launch — see the header on list prices).
const H3_MAX_RATES = Object.freeze({ '480P': 0.05, '768P': 0.08, '1080P': 0.16 });
// Seedance 2.5 bills video tokens: ≈ width × height × 24fps × seconds / 1024 at
// $0.0214 per 1,000 (480p/720p) or $0.0234 (1080p). fal publishes the resulting
// per-second price for a 16:9 output; those published figures are used (they
// run ~2% above the nominal-pixel formula, i.e. the provider pads the canvas).
const SEEDANCE_PER_SEC_16X9 = Object.freeze({ '480p': 0.2205, '720p': 0.473, '1080p': 1.164 });

const seedance = (id, kind, label, extra) => ({
  id, kind, label, family: 'seedance-2.5',
  prompt: kind === 'i2v' ? 'optional' : 'required',
  // 'auto' lets the model pick 4–30s from the prompt — an unbounded bill for a
  // cap to reason about, so PortOS always pins an explicit length.
  duration: { kind: 'range', min: 4, max: 30, wire: 'string', defaultSec: 5 },
  resolution: { param: 'resolution', options: SEEDANCE_RESOLUTIONS, default: '720p' },
  negativePrompt: 'fold',
  // Same price with or without audio; PortOS still asks for silence by
  // default because a Music Video's master song is its only soundtrack.
  audio: { param: 'generate_audio', providerDefault: true },
  pricing: { videoTokensPerSec16x9: SEEDANCE_PER_SEC_16X9 },
  ...extra,
});

const h3 = (id, label, rates, extra = {}) => ({
  id, kind: 'i2v', label, family: 'minimax-h3',
  prompt: 'required',
  image: { param: 'image_url', required: false },
  endImage: { param: 'end_image_url' },
  duration: { kind: 'range', min: 5, max: 15, wire: 'integer', defaultSec: 5 },
  resolution: { param: 'resolution', options: H3_RESOLUTIONS, default: '768P' },
  // The output canvas follows the start frame — there is no aspect parameter.
  aspectRatio: null,
  negativePrompt: 'fold',
  seed: 'seed',
  // Listed as required by the schema (with a default): send it explicitly.
  fixed: { prompt_expansion_mode: 'balanced' },
  pricing: { perSecond: rates },
  ...extra,
});

/** The curated catalog, one frozen row per fal endpoint. */
export const FAL_VIDEO_MODELS = Object.freeze([
  {
    id: FAL_DEFAULT_IMAGE_VIDEO_MODEL, kind: 'i2v', label: 'MiniMax Hailuo-02 Standard (image)', family: 'hailuo-02',
    prompt: 'required',
    image: { param: 'image_url', required: true },
    endImage: { param: 'end_image_url' },
    duration: { kind: 'enum', values: [6, 10], wire: 'string', defaultSec: 6 },
    resolution: { param: 'resolution', options: ['512P', '768P'], default: '768P' },
    aspectRatio: null,
    negativePrompt: 'fold',
    pricing: { perSecond: { '512P': 0.017, '768P': 0.045 } },
  },
  {
    id: FAL_DEFAULT_TEXT_VIDEO_MODEL, kind: 't2v', label: 'MiniMax Hailuo-02 Standard (text)', family: 'hailuo-02',
    prompt: 'required',
    duration: { kind: 'enum', values: [6, 10], wire: 'string', defaultSec: 6 },
    // Fixed 768P output; the text route takes neither resolution nor aspect ratio.
    resolution: null,
    aspectRatio: null,
    negativePrompt: 'fold',
    pricing: { perSecond: 0.045 },
  },
  h3('minimax/h3-max/image-to-video', 'MiniMax H3 Max (image)', H3_MAX_RATES),
  h3('minimax/h3-max-turbo/image-to-video', 'MiniMax H3 Max Turbo (image)', { '480P': 0.025, '768P': 0.04, '1080P': 0.08 }),
  {
    id: 'minimax/h3-max/reference-to-video', kind: 'ref2v', label: 'MiniMax H3 Max (reference)', family: 'minimax-h3',
    prompt: 'required',
    // Referenced in the prompt as "Image 1", "Audio 1", … in list order.
    referenceImages: { param: 'reference_image_urls', max: 9 },
    referenceAudio: { param: 'reference_audio_urls', max: 3, minSec: 2, maxSec: 15 },
    duration: { kind: 'range', min: 5, max: 15, wire: 'integer', defaultSec: 5 },
    resolution: { param: 'resolution', options: H3_RESOLUTIONS, default: '768P' },
    aspectRatio: { param: 'aspect_ratio', options: WIDE_ASPECTS, auto: 'adaptive' },
    negativePrompt: 'fold',
    seed: 'seed',
    fixed: { prompt_expansion_mode: 'balanced' },
    // Each request includes 4,096 reference tokens (four square images); beyond
    // that fal adds $0.02 per 1,000 tokens, which this estimate does not model.
    pricing: { perSecond: H3_MAX_RATES },
  },
  {
    id: FAL_LIPSYNC_VIDEO_MODEL, kind: 'lipsync', label: 'MiniMax H3 Max lip-sync', family: 'minimax-h3',
    // No prompt field at all: the frame and the audio are the whole request.
    prompt: 'none',
    image: { param: 'image_url', required: true },
    // fal accepts 5s to 15 minutes; the output length follows the audio.
    audioInput: { param: 'audio_url', minSec: 5, maxSec: 900 },
    duration: { kind: 'audio' },
    resolution: { param: 'resolution', options: [...H3_RESOLUTIONS, '2K'], default: '768P' },
    aspectRatio: null,
    negativePrompt: null,
    transcription: 'enable_transcription',
    seed: 'seed',
    // "A 1.2x multiplier is added to videos over 15 seconds" — the whole take.
    pricing: { perSecond: { ...H3_MAX_RATES, '2K': 0.32 }, longTake: { overSec: 15, factor: 1.2 } },
  },
  seedance('bytedance/seedance-2.5/image-to-video', 'i2v', 'Seedance 2.5 (image)', {
    image: { param: 'image_url', required: true },
    endImage: { param: 'end_image_url' },
    // "Always auto for image-to-video": the canvas follows the start frame.
    aspectRatio: null,
  }),
  seedance('bytedance/seedance-2.5/text-to-video', 't2v', 'Seedance 2.5 (text)', {
    aspectRatio: { param: 'aspect_ratio', options: WIDE_ASPECTS, auto: 'auto' },
  }),
  seedance('bytedance/seedance-2.5/reference-to-video', 'ref2v', 'Seedance 2.5 (reference)', {
    // Referenced in the prompt as @Image1 / @Audio1. Audio references let a
    // singer follow supplied audio, but each clip is capped at 30.2s.
    referenceImages: { param: 'image_urls', max: 30 },
    referenceAudio: { param: 'audio_urls', max: 10, minSec: 1.8, maxSec: 30.2 },
    aspectRatio: { param: 'aspect_ratio', options: WIDE_ASPECTS, auto: 'auto' },
    seed: 'seed',
  }),
  {
    id: 'fal-ai/kling-video/v3/pro/image-to-video', kind: 'i2v', label: 'Kling v3 Pro (image)', family: 'kling-v3',
    prompt: 'required',
    image: { param: 'start_image_url', required: true },
    endImage: { param: 'end_image_url' },
    duration: { kind: 'range', min: 3, max: 15, wire: 'string', defaultSec: 5 },
    resolution: null,
    aspectRatio: null,
    negativePrompt: 'native',
    audio: { param: 'generate_audio', providerDefault: true },
    pricing: { perSecond: 0.112, perSecondWithAudio: 0.168 },
  },
  {
    id: 'fal-ai/veo3.1/fast/image-to-video', kind: 'i2v', label: 'Veo 3.1 Fast (image)', family: 'veo-3.1',
    prompt: 'required',
    image: { param: 'image_url', required: true },
    duration: { kind: 'enum', values: [4, 6, 8], wire: 'seconds-suffix', defaultSec: 8 },
    resolution: { param: 'resolution', options: ['720p', '1080p', '4k'], default: '720p' },
    // Only 16:9 and 9:16; a start frame of another shape is cropped to fit.
    aspectRatio: { param: 'aspect_ratio', options: ['16:9', '9:16'], auto: 'auto' },
    negativePrompt: 'native',
    audio: { param: 'generate_audio', providerDefault: true },
    seed: 'seed',
    pricing: {
      perSecond: { '720p': 0.1, '1080p': 0.1, '4k': 0.3 },
      perSecondWithAudio: { '720p': 0.15, '1080p': 0.15, '4k': 0.35 },
    },
  },
].map((model) => Object.freeze(model)));

const BY_ID = new Map(FAL_VIDEO_MODELS.map((m) => [m.id, m]));

/** The catalog row for `modelId`, or null for a model PortOS has not curated. */
export const getFalVideoModel = (modelId) => (typeof modelId === 'string' ? BY_ID.get(modelId.trim()) || null : null);

/**
 * Models that animate a start frame (the Music Video cutaway lane's choices).
 * Reference-to-video models are left out: they take the frame as a loose
 * reference the prompt must name ("Image 1" / @Image1), which a scene's shot
 * prompt does not do.
 */
export const FAL_IMAGE_VIDEO_MODELS = Object.freeze(FAL_VIDEO_MODELS.filter((m) => m.kind === 'i2v'));

/** Resolution choices a model offers (empty when it has no resolution parameter). */
export const falVideoResolutions = (model) => (model?.resolution?.options ? [...model.resolution.options] : []);

/**
 * The model's spelling of `requested` (matched case-insensitively — fal writes
 * '1080P' for MiniMax and '1080p' for Seedance/Veo), else its default. Null when
 * the model has no resolution parameter.
 */
export function resolveFalVideoResolution(model, requested) {
  if (!model?.resolution) return null;
  const want = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  return model.resolution.options.find((o) => o.toLowerCase() === want) || model.resolution.default;
}

/**
 * The clip length (seconds) `model` will render for a request of `seconds`: the
 * shortest supported length that still COVERS it, else the longest — a Music
 * Video shot must not be under-covered (the renderer refuses a clip more than a
 * frame short) and nothing loops or stretches footage. An absent / invalid
 * request gets the model's default. Null for a lip-sync model, whose length
 * follows its audio.
 */
export function coerceFalVideoSeconds(model, seconds) {
  const rule = model?.duration;
  if (!rule || rule.kind === 'audio') return null;
  const n = Number(seconds);
  if (seconds == null || seconds === '' || !Number.isFinite(n) || n <= 0) return rule.defaultSec;
  if (rule.kind === 'enum') {
    return rule.values.find((v) => v >= n - 1e-6) ?? rule.values[rule.values.length - 1];
  }
  return Math.min(rule.max, Math.max(rule.min, Math.ceil(n - 1e-6)));
}

const wireDuration = (rule, sec) => (
  rule.wire === 'integer' ? sec : rule.wire === 'seconds-suffix' ? `${sec}s` : String(sec)
);

const ratioOf = (r) => { const [w, h] = String(r).split(':').map(Number); return w / h; };

function pickAspectRatio(rule, { aspectRatio, width, height }) {
  if (!rule) return null;
  if (rule.options.includes(aspectRatio)) return aspectRatio;
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0)) return null; // the provider's own auto/adaptive default
  const target = w / h;
  let best = null;
  for (const option of rule.options) {
    if (!best || Math.abs(ratioOf(option) - target) < Math.abs(ratioOf(best) - target)) best = option;
  }
  return best;
}

function perSecondRate(model, resolution, withAudio) {
  const { pricing } = model;
  const table = withAudio && pricing.perSecondWithAudio != null ? pricing.perSecondWithAudio : pricing.perSecond;
  if (typeof table === 'number') return table;
  return table?.[resolution] ?? null;
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Estimated USD for one fal render, or null when the model is not curated or
 * the inputs cannot be priced. `seconds` is what the caller asks for; it is
 * coerced exactly as the request body will be (a lip-sync take is billed on
 * its audio length). `width`/`height` only matter for token-priced models
 * (Seedance), where a canvas wider than 16:9 costs proportionally more; a
 * narrower one is still priced at the 16:9 figure so the estimate never
 * undershoots. `generateAudio` selects the audio-on rate where one exists.
 */
export function estimateFalVideoCostUsd({ modelId, seconds, resolution, width, height, generateAudio = false } = {}) {
  const model = getFalVideoModel(modelId);
  if (!model) return null;
  let billedSec;
  if (model.duration.kind === 'audio') {
    billedSec = Number(seconds);
    if (!Number.isFinite(billedSec) || billedSec <= 0) return null;
    billedSec = Math.max(billedSec, model.audioInput.minSec);
  } else {
    billedSec = coerceFalVideoSeconds(model, seconds);
  }
  const res = resolveFalVideoResolution(model, resolution);
  let perSec;
  if (model.pricing.videoTokensPerSec16x9) {
    perSec = model.pricing.videoTokensPerSec16x9[res] ?? null;
    const w = Number(width);
    const h = Number(height);
    if (perSec != null && w > 0 && h > 0) perSec *= Math.max(1, (Math.max(w, h) / Math.min(w, h)) / (16 / 9));
  } else {
    perSec = perSecondRate(model, res, generateAudio === true && !!model.audio);
  }
  if (perSec == null) return null;
  const long = model.pricing.longTake;
  const factor = long && billedSec > long.overSec ? long.factor : 1;
  return round4(perSec * billedSec * factor);
}

/** A one-line human rate for `model` at `resolution`, e.g. "$0.16/s at 1080P (×1.2 over 15s)". */
export function describeFalVideoRate(modelId, resolution) {
  const model = getFalVideoModel(modelId);
  if (!model) return null;
  const res = resolveFalVideoResolution(model, resolution);
  if (model.pricing.videoTokensPerSec16x9) {
    const perSec = model.pricing.videoTokensPerSec16x9[res];
    return perSec == null ? null : `≈$${perSec.toFixed(4)}/s at ${res} (16:9)`;
  }
  const perSec = perSecondRate(model, res, false);
  if (perSec == null) return null;
  const long = model.pricing.longTake;
  return `$${perSec}/s${res ? ` at ${res}` : ''}${long ? ` (×${long.factor} over ${long.overSec}s)` : ''}`;
}

/**
 * Build the fal queue request body for a curated model, or return null for an
 * uncurated id (the caller keeps its legacy body). Returns `{ body, model,
 * seconds, resolution, generateAudio, estimatedCostUsd }` — `seconds` is the
 * coerced clip length (null for lip-sync, whose length is `audioSec`).
 *
 * Inputs a model cannot take are dropped rather than sent (fal ignores unknown
 * keys, which would bill a render that silently disregarded them); a missing
 * REQUIRED input throws an Error with `code = 'FAL_MODEL_INPUT'` so the caller
 * refuses before anything is paid for.
 *
 * `generateAudio` defaults to false: PortOS's video renders are cutaways for a
 * master soundtrack (Music Video) or silent-by-default clips; a caller asks for
 * provider audio explicitly.
 */
export function buildFalVideoRequest({
  modelId, prompt = '', negativePrompt = '', seconds, audioSec, aspectRatio, width, height, resolution,
  imageUrl = null, endImageUrl = null, referenceImageUrls = [], audioUrl = null, referenceAudioUrls = [],
  generateAudio = false, enableTranscription = false, seed,
} = {}) {
  const model = getFalVideoModel(modelId);
  if (!model) return null;
  const refuse = (message) => Object.assign(new Error(message), { code: 'FAL_MODEL_INPUT' });
  const body = {};
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const avoid = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';

  if (model.prompt !== 'none') {
    if (model.prompt === 'required' && !text) throw refuse(`${model.label} needs a prompt`);
    // No native field: fold the negative prompt into the prompt as an "Avoid:"
    // clause — the same fallback grok.js uses for a provider without one.
    const folded = model.negativePrompt === 'fold' && avoid ? `${text}\nAvoid: ${avoid}` : text;
    if (folded) body.prompt = folded;
    if (model.negativePrompt === 'native' && avoid) body.negative_prompt = avoid;
  }

  if (model.image) {
    if (imageUrl) body[model.image.param] = imageUrl;
    else if (model.image.required) throw refuse(`${model.label} renders from a start frame — supply a source image`);
  } else if (model.referenceImages) {
    // A PortOS start frame becomes the first reference ("Image 1" / @Image1).
    const refs = [imageUrl, ...(Array.isArray(referenceImageUrls) ? referenceImageUrls : [])].filter(Boolean);
    if (refs.length > model.referenceImages.max) throw refuse(`${model.label} takes at most ${model.referenceImages.max} reference images`);
    if (refs.length) body[model.referenceImages.param] = refs;
  } else if (imageUrl) {
    throw refuse(`${model.label} is text-to-video — it cannot use a source image`);
  }
  if (endImageUrl) {
    if (!model.endImage) throw refuse(`${model.label} takes no end frame`);
    body[model.endImage.param] = endImageUrl;
  }
  const audioRefs = (Array.isArray(referenceAudioUrls) ? referenceAudioUrls : []).filter(Boolean);
  if (audioRefs.length) {
    if (!model.referenceAudio) throw refuse(`${model.label} takes no reference audio`);
    if (audioRefs.length > model.referenceAudio.max) throw refuse(`${model.label} takes at most ${model.referenceAudio.max} reference audio clips`);
    body[model.referenceAudio.param] = audioRefs;
  }
  if (model.audioInput) {
    if (!audioUrl) throw refuse(`${model.label} needs the source audio to synchronize to`);
    body[model.audioInput.param] = audioUrl;
    if (model.transcription && enableTranscription) body[model.transcription] = true;
  } else if (audioUrl) {
    throw refuse(`${model.label} does not synchronize to source audio`);
  }

  const coercedSec = coerceFalVideoSeconds(model, seconds);
  if (coercedSec != null) body.duration = wireDuration(model.duration, coercedSec);
  const res = resolveFalVideoResolution(model, resolution);
  if (res) body[model.resolution.param] = res;
  const aspect = pickAspectRatio(model.aspectRatio, { aspectRatio, width, height });
  if (aspect) body[model.aspectRatio.param] = aspect;
  const wantsAudio = generateAudio === true && !!model.audio;
  if (model.audio) body[model.audio.param] = wantsAudio;
  if (model.seed && Number.isInteger(seed) && seed >= 0) body[model.seed] = seed;
  Object.assign(body, model.fixed || {});

  return {
    body,
    model,
    seconds: coercedSec,
    resolution: res,
    generateAudio: wantsAudio,
    estimatedCostUsd: estimateFalVideoCostUsd({
      modelId: model.id, seconds: coercedSec ?? audioSec, resolution: res, width, height, generateAudio: wantsAudio,
    }),
  };
}
