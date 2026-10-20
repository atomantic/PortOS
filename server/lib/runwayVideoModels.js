/**
 * Curated Runway VIDEO model catalog — what PortOS knows about each model it
 * offers through Runway's developer API (`POST /v1/image_to_video`, and
 * `POST /v1/text_to_video` for a row with a `textToVideo` rule): the
 * request fields each model takes (the body is one shape per `model`), its
 * duration and output-size rules, whether it ends on a last frame, and its
 * published price.
 *
 * Every row was checked against Runway's API reference and pricing guide
 * (docs.dev.runwayml.com: api.md, guides/pricing.md, assets/inputs.md) on
 * RUNWAY_VIDEO_PRICING_VERIFIED_AT. Runway changes these; when a render is
 * refused with a 400 or a bill disagrees with an estimate, re-check that
 * model's section and edit its row.
 *
 * Veo is deliberately not offered (a project choice), though
 * Runway serves it; the native `negativePrompt` row field stays for a model
 * that takes one.
 *
 * Every row animates a start frame, and the rows marked `endImage` also end on
 * a last frame. Only Gen-4.5 also renders from text alone; its `textToVideo`
 * rule lists the ratios `/v1/text_to_video` takes (the duration, prompt cap,
 * seed and price are the row's own). The other curated rows stay image-only
 * until a text-to-video need for them is checked against the API reference. Provider audio is always requested off
 * (`audio: false`) where a model has the field, since a PortOS clip is silent
 * unless the caller asks (a Music Video's master song is its only soundtrack),
 * and the silent rate is what is priced.
 *
 * Runway bills credits at $0.01 each; prices below are credits per second ÷ 100.
 *
 * Dependency-free so `client/src/lib/runwayVideoModels.js` can re-export it and
 * the board, the provider and the autopilot price a take identically.
 */

/** Date the schemas and prices below were last verified against Runway's docs. */
export const RUNWAY_VIDEO_PRICING_VERIFIED_AT = '2026-10-19';

/** Runway's own Gen-4.5: the default when a request names no model. */
export const RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL = 'gen4.5';

const GEN4_RATIOS = Object.freeze(['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672']);

/** The curated catalog, one frozen row per Runway model. */
export const RUNWAY_VIDEO_MODELS = Object.freeze([
  {
    id: 'gen4.5', label: 'Runway Gen-4.5', family: 'runway-gen4',
    prompt: 'required', promptMaxChars: 1000,
    endImage: false,
    duration: { kind: 'range', min: 2, max: 10, defaultSec: 5 },
    // `ratio` is required and names the output canvas.
    size: { param: 'ratio', required: true, byResolution: { '720p': GEN4_RATIOS }, default: '720p' },
    audio: false, seed: true, negativePrompt: false,
    // `ratio` is required on /v1/text_to_video and offers only these two.
    textToVideo: { ratios: Object.freeze(['1280:720', '720:1280']) },
    pricing: { perSecond: 0.12 },
  },
  {
    id: 'gen4_turbo', label: 'Runway Gen-4 Turbo', family: 'runway-gen4',
    prompt: 'optional', promptMaxChars: 1000,
    endImage: false,
    duration: { kind: 'range', min: 2, max: 10, defaultSec: 5 },
    size: { param: 'ratio', required: true, byResolution: { '720p': GEN4_RATIOS }, default: '720p' },
    audio: false, seed: true, negativePrompt: false,
    pricing: { perSecond: 0.05 },
  },
  {
    id: 'kling3.0_standard', label: 'Kling 3.0 Standard', family: 'kling-3.0',
    prompt: 'optional', promptMaxChars: 2500,
    endImage: true,
    duration: { kind: 'range', min: 3, max: 15, defaultSec: 5 },
    // Optional; with a last frame the canvas follows the first frame.
    size: { param: 'ratio', required: false, byResolution: { '720p': ['1280:720', '720:1280', '960:960'] }, default: '720p' },
    // 13 credits/s with audio (Runway's default), 9 with audio off.
    audio: true, seed: false, negativePrompt: false,
    pricing: { perSecond: 0.09 },
  },
  {
    id: 'kling3.0_pro', label: 'Kling 3.0 Pro', family: 'kling-3.0',
    prompt: 'optional', promptMaxChars: 2500,
    endImage: true,
    duration: { kind: 'range', min: 3, max: 15, defaultSec: 5 },
    size: { param: 'ratio', required: false, byResolution: { '1080p': ['1920:1080', '1080:1920', '1440:1440'] }, default: '1080p' },
    // 17 credits/s with audio, 12 with audio off.
    audio: true, seed: false, negativePrompt: false,
    pricing: { perSecond: 0.12 },
  },
  {
    id: 'kling2.5_turbo_pro', label: 'Kling 2.5 Turbo Pro', family: 'kling-2.5',
    prompt: 'optional', promptMaxChars: 2500,
    endImage: true,
    duration: { kind: 'enum', values: [5, 10], defaultSec: 5 },
    // No ratio field: the canvas follows the start frame.
    size: null,
    audio: false, seed: false, negativePrompt: false,
    pricing: { perSecond: 0.12 },
  },
  {
    id: 'h3_max', label: 'MiniMax H3 Max', family: 'minimax-h3',
    prompt: 'required', promptMaxChars: 6000,
    endImage: true,
    duration: { kind: 'range', min: 5, max: 15, defaultSec: 5 },
    // A resolution, not a ratio: the canvas follows the start frame.
    size: { param: 'resolution', required: false, byResolution: { '480p': null, '768p': null }, default: '768p' },
    audio: false, seed: true, negativePrompt: false,
    pricing: { perSecond: { '480p': 0.05, '768p': 0.08 } },
  },
  {
    id: 'wan3', label: 'WAN 3.0', family: 'wan-3',
    prompt: 'required', promptMaxChars: 20000,
    endImage: true,
    duration: { kind: 'range', min: 2, max: 30, defaultSec: 5 },
    // A keyframe render must use an `auto_*` ratio: the canvas follows the first frame.
    size: { param: 'ratio', required: false, byResolution: { '480p': ['auto_480p'], '720p': ['auto_720p'], '1080p': ['auto_1080p'] }, default: '720p' },
    audio: true, seed: false, negativePrompt: false,
    pricing: { perSecond: { '480p': 0.05, '720p': 0.10, '1080p': 0.20 } },
  },
].map((model) => Object.freeze(model)));

const BY_ID = new Map(RUNWAY_VIDEO_MODELS.map((m) => [m.id, m]));

/** The catalog row for `modelId`, or null for a model PortOS has not curated. */
export const getRunwayVideoModel = (modelId) => (typeof modelId === 'string' ? BY_ID.get(modelId.trim()) || null : null);

/** True when `model` renders from a prompt alone (`/v1/text_to_video`). */
export const runwayModelTakesText = (model) => !!model?.textToVideo;

/** Output sizes a model offers (empty when it has no size parameter). */
export const runwayVideoResolutions = (model) => (model?.size ? Object.keys(model.size.byResolution) : []);

/** The model's spelling of `requested` (case-insensitive), else its default; null without a size parameter. */
export function resolveRunwayVideoResolution(model, requested) {
  if (!model?.size) return null;
  const want = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  return runwayVideoResolutions(model).find((r) => r.toLowerCase() === want) || model.size.default;
}

/**
 * The clip length `model` renders for a request of `seconds`: the shortest
 * length that still COVERS it, else the longest (a Music Video shot must not
 * be under-covered, and nothing loops or stretches footage). An absent or
 * invalid request gets the model's default.
 */
export function coerceRunwayVideoSeconds(model, seconds) {
  const rule = model?.duration;
  if (!rule) return null;
  const n = Number(seconds);
  if (seconds == null || seconds === '' || !Number.isFinite(n) || n <= 0) return rule.defaultSec;
  if (rule.kind === 'enum') return rule.values.find((v) => v >= n - 1e-6) ?? rule.values[rule.values.length - 1];
  return Math.min(rule.max, Math.max(rule.min, Math.ceil(n - 1e-6)));
}

/** Clip lengths a model renders, for a length picker. */
export function runwayVideoLengths(model) {
  const rule = model?.duration;
  if (rule?.kind === 'enum') return [...rule.values];
  if (rule?.kind === 'range') return Array.from({ length: rule.max - rule.min + 1 }, (_, i) => rule.min + i);
  return [];
}

const ratioOf = (r) => { const [w, h] = String(r).split(':').map(Number); return w / h; };
const aspectOf = ({ aspectRatio, width, height }) => {
  const w = Number(width);
  const h = Number(height);
  if (w > 0 && h > 0) return w / h;
  return /^\d+:\d+$/.test(aspectRatio || '') ? ratioOf(aspectRatio) : null;
};

/** The size value sent for `resolution`: the closest listed ratio to the target aspect, or the resolution itself. */
function pickSizeValue(model, resolution, target) {
  const options = model.size.byResolution[resolution];
  if (options == null) return resolution;
  if (options.length === 1) return options[0];
  // No target: a landscape canvas, Runway's own documented example.
  const want = target ?? 16 / 9;
  return options.reduce((best, option) => (Math.abs(ratioOf(option) - want) < Math.abs(ratioOf(best) - want) ? option : best));
}

const perSecondRate = (model, resolution) => {
  const { perSecond } = model.pricing;
  return typeof perSecond === 'number' ? perSecond : perSecond?.[resolution] ?? null;
};

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * What one Runway render costs and why, or null for an uncurated model:
 * `{ modelId, label, requestedSec, billedSec, minBilledSec, resolution, perSec,
 * costUsd }`. `billedSec` is the length Runway renders and bills, coerced
 * exactly as the request body will be.
 */
export function runwayVideoClipQuote({ modelId, seconds, resolution } = {}) {
  const model = getRunwayVideoModel(modelId);
  if (!model) return null;
  const billedSec = coerceRunwayVideoSeconds(model, seconds);
  const res = resolveRunwayVideoResolution(model, resolution);
  const perSec = perSecondRate(model, res);
  if (perSec == null) return null;
  const requested = Number(seconds);
  const rule = model.duration;
  return {
    modelId: model.id,
    label: model.label,
    requestedSec: Number.isFinite(requested) && requested > 0 ? requested : null,
    billedSec,
    minBilledSec: rule.kind === 'enum' ? rule.values[0] : rule.min,
    resolution: res,
    perSec: round4(perSec),
    costUsd: round4(perSec * billedSec),
  };
}

/** Estimated USD for one Runway render, or null when it cannot be priced. */
export const estimateRunwayVideoCostUsd = (options = {}) => runwayVideoClipQuote(options)?.costUsd ?? null;

/** A one-line human rate, e.g. "$0.12/s · bills 2s min" or "$0.08/s at 768p · bills 5s min". */
export function describeRunwayVideoRate(modelId, resolution) {
  const model = getRunwayVideoModel(modelId);
  if (!model) return null;
  const res = resolveRunwayVideoResolution(model, resolution);
  const perSec = perSecondRate(model, res);
  if (perSec == null) return null;
  const multiRate = typeof model.pricing.perSecond !== 'number';
  const rule = model.duration;
  return `$${perSec}/s${multiRate && res ? ` at ${res}` : ''} · bills ${rule.kind === 'enum' ? rule.values[0] : rule.min}s min`;
}

/**
 * Build the Runway request for a curated model: `/v1/image_to_video` with a
 * start frame, `/v1/text_to_video` without one (a model with a `textToVideo`
 * rule). Returns `{ endpoint, body, model, seconds, resolution,
 * estimatedCostUsd }`. A missing required input, an
 * input the model cannot take, an uncurated model, or an over-cap prompt throws
 * an Error with `code = 'RUNWAY_MODEL_INPUT'` so the caller refuses before
 * anything is paid for. A prompt is never shortened (AGENTS.md, #11317).
 */
export function buildRunwayVideoRequest({
  modelId, prompt = '', negativePrompt = '', seconds, aspectRatio, width, height, resolution,
  imageUri = null, endImageUri = null, seed,
} = {}) {
  const refuse = (message) => Object.assign(new Error(message), { code: 'RUNWAY_MODEL_INPUT' });
  const model = getRunwayVideoModel(modelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL);
  if (!model) throw refuse(`"${modelId}" is not a Runway model PortOS offers`);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const avoid = typeof negativePrompt === 'string' ? negativePrompt.trim() : '';
  if (model.prompt === 'required' && !text) throw refuse(`${model.label} needs a prompt`);
  // No native field: the negative prompt rides in the prompt as an "Avoid:"
  // clause, shown to the user as a labeled addition (same fallback as fal.ai).
  const sent = !model.negativePrompt && avoid ? `${text}\nAvoid: ${avoid}`.trim() : text;
  if (sent.length > model.promptMaxChars) {
    throw refuse(`The prompt is ${sent.length.toLocaleString('en-US')} characters${sent === text ? '' : ' with its "Avoid:" clause'}; ${model.label} takes ${model.promptMaxChars.toLocaleString('en-US')}. Shorten it to render.`);
  }
  if (model.negativePrompt && avoid.length > model.negativePromptMaxChars) {
    throw refuse(`The negative prompt is ${avoid.length.toLocaleString('en-US')} characters; ${model.label} takes ${model.negativePromptMaxChars.toLocaleString('en-US')}. Shorten it to render.`);
  }
  const textOnly = !imageUri;
  if (textOnly && !runwayModelTakesText(model)) throw refuse(`${model.label} renders from a start frame. Supply a source image.`);
  if (textOnly && endImageUri) throw refuse('An end frame needs a start frame. Supply a source image.');
  if (endImageUri && !model.endImage) throw refuse(`${model.label} takes no end frame; choose a model that does`);

  const body = { model: model.id };
  if (!textOnly) {
    body.promptImage = endImageUri
      ? [{ uri: imageUri, position: 'first' }, { uri: endImageUri, position: 'last' }]
      : imageUri;
  }
  if (sent) body.promptText = sent;
  if (model.negativePrompt && avoid) body.negativePrompt = avoid;
  const coercedSec = coerceRunwayVideoSeconds(model, seconds);
  body.duration = coercedSec;
  const res = resolveRunwayVideoResolution(model, resolution);
  if (textOnly) {
    // No frame to follow, so the canvas is always named: the offered ratio closest to the target.
    const want = aspectOf({ aspectRatio, width, height }) ?? 16 / 9;
    body.ratio = model.textToVideo.ratios.reduce((best, r) => (Math.abs(ratioOf(r) - want) < Math.abs(ratioOf(best) - want) ? r : best));
  } else if (model.size) {
    const target = aspectOf({ aspectRatio, width, height });
    // An optional ratio is sent only when there is a target to match and no
    // last frame (a keyframe render's canvas follows its first frame);
    // otherwise Runway sizes from the frame.
    if (model.size.required || model.size.param === 'resolution' || model.size.byResolution[res]?.length === 1
      || (target != null && !endImageUri)) {
      body[model.size.param] = pickSizeValue(model, res, target);
    }
  }
  if (model.audio) body.audio = false;
  if (model.seed && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295) body.seed = seed;

  return {
    endpoint: textOnly ? 'text_to_video' : 'image_to_video',
    body,
    model,
    seconds: coercedSec,
    resolution: res,
    estimatedCostUsd: estimateRunwayVideoCostUsd({ modelId: model.id, seconds: coercedSec, resolution: res }),
  };
}
