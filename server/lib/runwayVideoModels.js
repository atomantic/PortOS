/** Runway text/image-to-video capabilities shared by forms, submissions and quotes.
 * Published OpenAPI snapshot: 2026-10-22. Video-editing and performance endpoints
 * need different input workflows and are reported separately by the catalog API.
 */
import { RUNWAY_CATALOG_SNAPSHOT } from './runwayCatalogSnapshot.js';

/** Date the schemas and prices below were last verified against Runway's docs. */
export const RUNWAY_VIDEO_PRICING_VERIFIED_AT = '2026-10-19';

/** Runway's own Gen-4.5: the default when a request names no model. */
export const RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL = 'gen4.5';

const PRICES = {
  'gen4.5': 0.12, gen4_turbo: 0.05, 'kling3.0_standard': 0.09, 'kling3.0_pro': 0.12,
  'kling2.5_turbo_pro': 0.12, h3_max: { '480p': 0.05, '768p': 0.08 },
  wan3: { '480p': 0.05, '720p': 0.10, '1080p': 0.20 },
};
const LABELS = {
  'gen4.5': 'Runway Gen-4.5', gen4_turbo: 'Runway Gen-4 Turbo',
  'veo3.1': 'Veo 3.1', 'veo3.1_fast': 'Veo 3.1 Fast',
  hailuo3: 'MiniMax H3', h3_max: 'MiniMax H3 Max', happyhorse_1_0: 'HappyHorse 1.0',
  wan3: 'WAN 3.0', wan3_prime: 'WAN 3.0 Prime',
  seedance2: 'Seedance 2.0', seedance2_fast: 'Seedance 2.0 Fast', seedance2_mini: 'Seedance 2.0 Mini', seedance2_5: 'Seedance 2.5',
  gemini_omni_flash: 'Gemini Omni Flash', 'gemini_omni_flash_1.1': 'Gemini Omni Flash 1.1',
  grok_imagine_1_5: 'Grok Imagine Video 1.5', grok_imagine_1_5_lite: 'Grok Imagine Video 1.5 Lite',
};
function sizeRule(row, textOnly) {
  if (row.resolutions.length) return {
    param: 'resolution', required: true, byResolution: Object.fromEntries(row.resolutions.map((r) => [r, null])),
    default: row.id === 'h3_max' ? '768p' : row.resolutions.includes('720p') ? '720p' : row.resolutions[0],
  };
  let ratios = row.ratios;
  if (row.id.startsWith('wan3')) ratios = ratios.filter((r) => textOnly ? !r.startsWith('auto_') : r.startsWith('auto_'));
  if (!ratios.length) return null;
  const byResolution = {};
  for (const ratio of ratios) {
    const [w, h] = ratio.split(':').map(Number);
    const pixels = w * h;
    const tier = ratio.startsWith('auto_') ? ratio.slice(5) : pixels > 5e6 ? '4k' : pixels > 1.1e6 ? '1080p' : pixels > 5e5 ? '720p' : pixels > 3e5 ? '480p' : '360p';
    (byResolution[tier] ||= []).push(ratio);
  }
  return { param: 'ratio', required: row.ratioRequired, byResolution, default: byResolution['720p'] ? '720p' : Object.keys(byResolution)[0] };
}
export const RUNWAY_VIDEO_MODELS = Object.freeze(RUNWAY_CATALOG_SNAPSHOT.image_to_video.map((row) => {
  const text = RUNWAY_CATALOG_SNAPSHOT.text_to_video.find((m) => m.id === row.id);
  const d = row.duration;
  const duration = d.enum ? { kind: 'enum', values: d.enum, defaultSec: d.enum.find((n) => n >= 5) || d.enum[0] }
    : { kind: 'range', min: d.minimum, max: d.maximum, defaultSec: Math.max(5, d.minimum) };
  return Object.freeze({
    id: row.id, label: LABELS[row.id] || row.id.replace('kling', 'Kling ').replaceAll('_', ' '), family: row.id,
    prompt: row.promptRequired ? 'required' : 'optional', promptMinChars: row.promptMin, promptMaxChars: row.promptMax,
    endImage: row.endImage, duration, size: sizeRule(row, false), audio: row.audio, seed: row.seed, negativePrompt: row.negativePromptMax > 0, negativePromptMaxChars: row.negativePromptMax,
    ...(text ? { textToVideo: { ratios: text.ratios.filter((r) => /^\d+:\d+$/.test(r)), size: sizeRule(text, true), promptRequired: text.promptRequired } } : {}),
    pricing: { perSecond: PRICES[row.id] ?? null },
  });
}));

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
  if ((model.prompt === 'required' || (!imageUri && model.textToVideo?.promptRequired)) && !text) throw refuse(`${model.label} needs a prompt`);
  // No native field: the negative prompt rides in the prompt as an "Avoid:"
  // clause, shown to the user as a labeled addition (same fallback as fal.ai).
  const sent = !model.negativePrompt && avoid ? `${text}\nAvoid: ${avoid}`.trim() : text;
  if (sent && sent.length < model.promptMinChars) throw refuse(`${model.label} needs at least ${model.promptMinChars} prompt characters`);
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
  const activeModel = textOnly ? { ...model, size: model.textToVideo.size } : model;
  const res = resolveRunwayVideoResolution(activeModel, resolution);
  const target = aspectOf({ aspectRatio, width, height });
  if (activeModel.size) {
    if (textOnly || resolution || activeModel.size.required || activeModel.size.param === 'resolution' || activeModel.size.byResolution[res]?.length === 1
      || (target != null && !endImageUri)) {
      body[activeModel.size.param] = pickSizeValue(activeModel, res, target);
    }
  }
  // These families take both a separate resolution and an aspect-ratio enum.
  if (textOnly && activeModel.size?.param === 'resolution' && model.textToVideo.ratios.length) {
    const want = target ?? 16 / 9;
    body.ratio = model.textToVideo.ratios.reduce((best, r) => Math.abs(ratioOf(r) - want) < Math.abs(ratioOf(best) - want) ? r : best);
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
