// Music Video draft and final clip renders (#16136).
//
// A hosted model that offers resolution tiers renders a shot's clip at the project's draft tier
// (cheap) or its final tier (high). `videoSettings.draftResolution` / `finalResolution` are ceilings:
// a tier renders at the highest resolution the shot's model offers at or under it, and at the model's
// lowest when none is that low. Unset, draft is the model's lowest tier and final its highest. A model
// with fewer than two tiers, and every local or untiered lane, has no tier choice. Dependency-free
// like the catalogs it reads, so the client imports it too.

import { getFalVideoModel, falVideoResolutions } from '../falVideoModels.js';
import { getRunwayVideoModel, runwayVideoResolutions } from '../runwayVideoModels.js';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, getHiggsfieldVideoModel } from '../higgsfieldVideoModels.js';
import { GOOGLE_DEFAULT_VIDEO_MODEL, getGoogleVideoModel } from '../googleVideoModels.js';
import { falSceneTake, meteredSceneTake, runwaySceneTake } from './musicVideoShotTiming.js';

export const MUSIC_VIDEO_RENDER_TIERS = Object.freeze(['draft', 'final']);
// How an approved draft shot is upgraded (#16136); lives here so validation imports no shot-prompt closure.
export const MUSIC_VIDEO_UPGRADE_METHODS = Object.freeze(['upscale', 'rerender']);
export const isMusicVideoRenderTier = (tier) => MUSIC_VIDEO_RENDER_TIERS.includes(tier);
export const musicVideoRenderTierLabel = (tier) => (tier === 'draft' ? 'Draft' : tier === 'final' ? 'Final' : null);

/** A resolution label's height in lines ('720p', '768P', '2K', '4k'), or null when it is not one. */
function renderResolutionRank(resolution) {
  const text = String(resolution ?? '').trim().toLowerCase();
  const k = /^(\d+(?:\.\d+)?)k$/.exec(text);
  if (k) return Number(k[1]) === 2 ? 1440 : Number(k[1]) * 540;
  const p = /^(\d+)p$/.exec(text);
  return p ? Number(p[1]) : null;
}

/** A model's tiers, lowest first; null when it offers fewer than two rankable ones. */
function orderedTiers(options) {
  const ranked = (options || []).filter((option) => renderResolutionRank(option) != null);
  if (new Set(ranked.map(renderResolutionRank)).size < 2) return null;
  return [...ranked].sort((a, b) => renderResolutionRank(a) - renderResolutionRank(b));
}

/**
 * The resolution a tier renders at among `options` (lowest first). `ceiling`
 * is the project's draft or final resolution; unset, draft is the lowest
 * option and final the highest.
 */
function pickRenderTierResolution(options, tier, ceiling = null) {
  if (!options?.length || !isMusicVideoRenderTier(tier)) return null;
  const cap = renderResolutionRank(ceiling);
  if (cap == null) return tier === 'draft' ? options[0] : options.at(-1);
  const under = options.filter((option) => renderResolutionRank(option) <= cap);
  return under.length ? under.at(-1) : options[0];
}

const performanceFalField = (take) => (take.music ? 'falMusicResolution' : 'falLipSyncResolution');

/**
 * Where a shot's tier lands on `backend`: `{ settingsField, requestField,
 * modelId, options }`, or null when that lane or model has no tiers.
 * `settingsField` is the video-settings key the shot timing helpers read;
 * `requestField` is the `/api/video-gen` field the render sends.
 */
function sceneRenderTierTarget(backend, { scene = null, scenes = null, videoSettings = {} } = {}) {
  const settings = videoSettings || {};
  if (backend === 'fal') {
    const take = falSceneTake({ scene, scenes, videoSettings: settings });
    const options = orderedTiers(falVideoResolutions(getFalVideoModel(take.modelId)));
    return options ? {
      settingsField: take.performance ? performanceFalField(take) : 'falResolution',
      requestField: 'falResolution', modelId: take.modelId, options,
    } : null;
  }
  if (backend === 'runway') {
    const take = runwaySceneTake({ scene, scenes, videoSettings: settings });
    const options = take.performance ? null : orderedTiers(runwayVideoResolutions(getRunwayVideoModel(take.modelId)));
    return options ? { settingsField: 'runwayResolution', requestField: 'runwayResolution', modelId: take.modelId, options } : null;
  }
  if (backend === 'higgsfield') {
    const modelId = settings.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL;
    const options = orderedTiers(getHiggsfieldVideoModel(modelId)?.resolutions);
    return options ? { settingsField: 'higgsfieldResolution', requestField: 'higgsfieldResolution', modelId, options } : null;
  }
  if (backend === 'google') {
    const modelId = settings.googleModelId || GOOGLE_DEFAULT_VIDEO_MODEL;
    const options = orderedTiers(getGoogleVideoModel(modelId)?.resolutions);
    return options ? { settingsField: 'googleResolution', requestField: 'googleResolution', modelId, options } : null;
  }
  return null;
}

/**
 * The shot's draft and final resolutions on `backend`:
 * `{ settingsField, requestField, modelId, options, draft, final }`, or null when it has no tiers.
 */
export function sceneRenderTierPlan(backend, context = {}) {
  const target = sceneRenderTierTarget(backend, context);
  if (!target) return null;
  const settings = context.videoSettings || {};
  return {
    ...target,
    draft: pickRenderTierResolution(target.options, 'draft', settings.draftResolution),
    final: pickRenderTierResolution(target.options, 'final', settings.finalResolution),
  };
}

/**
 * Video settings for one render of a shot at `tier`: the project settings with
 * `override` (a card's render pick, an API caller's target) laid over them,
 * and the tier's resolution on the field the shot's model reads. A resolution
 * the override names explicitly wins; no tier, or a lane without tiers, leaves
 * the merged settings unchanged.
 */
export function renderTierVideoSettings(backend, { scene = null, scenes = null, videoSettings = {}, override = null, tier = null } = {}) {
  const merged = { ...(videoSettings || {}), ...(override || {}) };
  if (!isMusicVideoRenderTier(tier)) return merged;
  const plan = sceneRenderTierPlan(backend, { scene, scenes, videoSettings: merged });
  if (!plan || override?.[plan.settingsField] != null) return merged;
  return { ...merged, [plan.settingsField]: plan[tier] };
}

/**
 * The shot card's two clip actions on `backend`: `[{ tier, resolution,
 * costUsd }]` for draft then final, each priced the way the board prices a
 * take (`costUsd` null on a lane PortOS cannot price), or null when the lane
 * or model has no tiers, which keeps the card's single Render.
 */
export function sceneRenderTierChoices(backend, { scene = null, scenes = null, videoSettings = {}, override = null, songDurationSec = null, lineCues = null } = {}) {
  const merged = { ...(videoSettings || {}), ...(override || {}) };
  const plan = sceneRenderTierPlan(backend, { scene, scenes, videoSettings: merged });
  if (!plan) return null;
  return MUSIC_VIDEO_RENDER_TIERS.map((tier) => {
    const settings = renderTierVideoSettings(backend, { scene, scenes, videoSettings, override, tier });
    const take = meteredSceneTake(backend, { scene, scenes, videoSettings: settings, songDurationSec, lineCues });
    return { tier, resolution: settings[plan.settingsField] ?? plan[tier], costUsd: take?.costUsd ?? null };
  });
}
