/**
 * Deterministic, bounded Digital Twin music-taste recipes (#4347).
 *
 * This module is pure. The scheduler owns the machine-local reads of the
 * stated taste profile and observed evidence, then hands those bounded source
 * projections here. No raw Spotify cache, activity event, or full Digital Twin
 * response is allowed into the recipe or the federated commission brief.
 */

import { createHash } from 'crypto';
import { canonicalStringify } from '../../lib/objects.js';
import {
  COMMISSION_MUSIC_TASTE_ANCHOR_MAX,
  COMMISSION_MUSIC_TASTE_PERCENT_MAX,
  CREATIVE_COMMISSION_MUSIC_TASTE_WINDOWS,
} from '../../lib/creativeCommissionValidation.js';
import { isStr, trimTo } from '../../lib/textUtils.js';

export const MUSIC_TASTE_RECIPE_VERSION = 1;
export const MUSIC_TASTE_RECIPE_MAX_CONTEXT = 500;
export const MUSIC_TASTE_RECIPE_MAX_SOURCE_VERSION = 240;
export const MUSIC_TASTE_RECIPE_MAX_CANDIDATES = 50;
export const MUSIC_TASTE_FEEDBACK_TAGS = Object.freeze([
  'more-familiar',
  'more-experimental',
  'keep-anchors',
  'change-anchors',
]);

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const clampInt = (value, min, max, fallback) => Number.isInteger(value)
  ? Math.min(max, Math.max(min, value)) : fallback;

export function normalizeMusicTasteConfig(raw) {
  if (!isObject(raw) || raw.source !== 'digital-twin') return null;
  const window = CREATIVE_COMMISSION_MUSIC_TASTE_WINDOWS.includes(raw.window) ? raw.window : 'month';
  const pickId = (value) => {
    if (!isStr(value) || !value.trim()) return null;
    return value.trim().slice(0, 64);
  };
  return {
    source: 'digital-twin',
    window,
    anchorCount: clampInt(raw.anchorCount, 1, COMMISSION_MUSIC_TASTE_ANCHOR_MAX, 3),
    explorationPercent: clampInt(raw.explorationPercent, 0, COMMISSION_MUSIC_TASTE_PERCENT_MAX, 20),
    musicEngineId: pickId(raw.musicEngineId),
    musicModelId: pickId(raw.musicModelId),
  };
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function anchorKey(anchor) {
  const artist = isStr(anchor?.artist) && anchor.artist ? `:${anchor.artist}` : '';
  return `${anchor?.kind || ''}:${anchor?.name || ''}${artist}`.toLowerCase();
}

function combinationKey(anchors) {
  return (anchors || []).map(anchorKey).sort().join('|');
}

function normalizeCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.min(999999, Math.floor(value)) : 1;
}

function normalizeCandidates(observedWindow) {
  const candidates = [];
  const seen = new Set();
  const add = (kind, raw) => {
    if (!isObject(raw) || !isStr(raw.name) || !raw.name.trim()) return;
    const name = raw.name.trim().slice(0, 120);
    const artist = kind === 'track' && isStr(raw.artist) && raw.artist.trim()
      ? raw.artist.trim().slice(0, 120) : null;
    const key = `${kind}:${name.toLowerCase()}:${artist?.toLowerCase() || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, name, ...(artist ? { artist } : {}), count: normalizeCount(raw.count), source: 'observed' });
  };
  const topArtists = Array.isArray(observedWindow?.listen?.topArtists)
    ? observedWindow.listen.topArtists.slice(0, MUSIC_TASTE_RECIPE_MAX_CANDIDATES) : [];
  const topTracks = Array.isArray(observedWindow?.listen?.topTracks)
    ? observedWindow.listen.topTracks.slice(0, MUSIC_TASTE_RECIPE_MAX_CANDIDATES) : [];
  for (const artist of topArtists) add('artist', artist);
  for (const track of topTracks) add('track', track);
  return candidates.slice(0, MUSIC_TASTE_RECIPE_MAX_CANDIDATES);
}

function orderedPool(candidates, seed, direction) {
  return [...candidates].sort((a, b) => {
    const countDelta = direction === 'familiar' ? b.count - a.count : a.count - b.count;
    return countDelta || (hashNumber(`${seed}:${anchorKey(a)}`) - hashNumber(`${seed}:${anchorKey(b)}`));
  });
}

function pickFromPool(pool, count, seed, attempt, used) {
  if (count <= 0 || pool.length === 0) return [];
  const picked = [];
  const start = (hashNumber(`${seed}:${attempt}`) + attempt) % pool.length;
  for (let i = 0; i < pool.length && picked.length < count; i += 1) {
    const candidate = pool[(start + i) % pool.length];
    const key = anchorKey(candidate);
    if (used.has(key)) continue;
    used.add(key);
    picked.push(candidate);
  }
  return picked;
}

function selectAnchors(candidates, config, seed, recentRecipes, explorationPercent, keepRecipe = null) {
  if (candidates.length === 0) return [];
  const anchorCount = Math.min(config.anchorCount, candidates.length);
  const explorationCount = Math.min(anchorCount, Math.round(anchorCount * explorationPercent / 100));
  const familiarCount = anchorCount - explorationCount;
  const familiar = orderedPool(candidates, `${seed}:familiar`, 'familiar');
  const exploratory = orderedPool(candidates, `${seed}:explore`, 'explore');
  const all = orderedPool(candidates, `${seed}:all`, 'familiar');
  const recent = new Set((recentRecipes || []).map((recipe) => combinationKey(recipe?.anchors)).filter(Boolean));

  // `keep-anchors` is a literal steering command, not merely a request to lower
  // exploration. Reuse every still-available anchor from the rated run, then
  // deterministically fill any gaps if the observed window has changed.
  if (keepRecipe?.anchors?.length) {
    const candidatesByKey = new Map(candidates.map((candidate) => [anchorKey(candidate), candidate]));
    const retained = [];
    const used = new Set();
    for (const anchor of keepRecipe.anchors) {
      const candidate = candidatesByKey.get(anchorKey(anchor));
      const key = candidate && anchorKey(candidate);
      if (!candidate || used.has(key)) continue;
      used.add(key);
      retained.push(candidate);
      if (retained.length === anchorCount) return retained;
    }
    if (retained.length > 0) {
      return [
        ...retained,
        ...pickFromPool(all, anchorCount - retained.length, `${seed}:keep`, 0, used),
      ];
    }
  }

  let selected = [];
  for (let attempt = 0; attempt <= candidates.length; attempt += 1) {
    const used = new Set();
    const next = [
      ...pickFromPool(familiar, familiarCount, `${seed}:familiar`, attempt, used),
      ...pickFromPool(exploratory, explorationCount, `${seed}:explore`, attempt, used),
      ...pickFromPool(all, anchorCount, `${seed}:all`, attempt, used),
    ].slice(0, anchorCount);
    selected = next;
    if (!recent.has(combinationKey(next)) || attempt === candidates.length) break;
  }
  return selected;
}

function anchorFeedbackPreference(feedback, recentRuns) {
  const reactions = Array.isArray(feedback) ? feedback.slice(-5) : [];
  const runs = Array.isArray(recentRuns) ? recentRuns : [];
  for (let index = reactions.length - 1; index >= 0; index -= 1) {
    const reaction = reactions[index];
    const tags = Array.isArray(reaction?.tags) ? reaction.tags : [];
    const keep = tags.includes('keep-anchors');
    const change = tags.includes('change-anchors');
    if (keep === change) continue; // neither, or a contradictory legacy record
    if (change) return { mode: 'change', recipe: null };
    const ratedRun = runs.find((run) => run?.id === reaction?.runId);
    const fallbackRun = runs.length ? runs[runs.length - 1] : null;
    return { mode: 'keep', recipe: ratedRun?.tasteRecipe || fallbackRun?.tasteRecipe || null };
  }
  return { mode: null, recipe: null };
}

function feedbackAdjustment(feedback) {
  const recent = Array.isArray(feedback) ? feedback.slice(-5) : [];
  let adjustment = 0;
  for (const item of recent) {
    const rating = item?.rating;
    if (rating === 'down' || (typeof rating === 'number' && rating < 0)) adjustment += 10;
    if (rating === 'up' || (typeof rating === 'number' && rating > 0)) adjustment -= 5;
    for (const tag of item?.tags || []) {
      if (tag === 'more-experimental' || tag === 'change-anchors') adjustment += 15;
      if (tag === 'more-familiar' || tag === 'keep-anchors') adjustment -= 15;
    }
  }
  return adjustment;
}

function explorationDirection(base, effective) {
  if (effective >= base + 10) return 'more-experimental';
  if (effective <= base - 10) return 'more-familiar';
  return 'balanced';
}

export function sanitizeMusicTasteRecipe(raw) {
  if (!isObject(raw) || raw.version !== MUSIC_TASTE_RECIPE_VERSION || raw.source !== 'digital-twin') return null;
  const anchors = Array.isArray(raw.anchors)
    ? raw.anchors.slice(0, COMMISSION_MUSIC_TASTE_ANCHOR_MAX).map((anchor) => {
      if (!isObject(anchor) || !['artist', 'track'].includes(anchor.kind) || !isStr(anchor.name)) return null;
      const name = anchor.name.trim().slice(0, 120);
      if (!name) return null;
      const artist = anchor.kind === 'track' && isStr(anchor.artist) && anchor.artist.trim()
        ? anchor.artist.trim().slice(0, 120) : null;
      return {
        kind: anchor.kind,
        name,
        ...(artist ? { artist } : {}),
        count: normalizeCount(anchor.count),
        source: 'observed',
      };
    }).filter(Boolean).slice(0, COMMISSION_MUSIC_TASTE_ANCHOR_MAX)
    : [];
  if (anchors.length === 0) return null;
  return {
    version: MUSIC_TASTE_RECIPE_VERSION,
    source: 'digital-twin',
    window: CREATIVE_COMMISSION_MUSIC_TASTE_WINDOWS.includes(raw.window) ? raw.window : 'month',
    anchorCount: clampInt(raw.anchorCount, 1, COMMISSION_MUSIC_TASTE_ANCHOR_MAX, anchors.length),
    explorationPercent: clampInt(raw.explorationPercent, 0, COMMISSION_MUSIC_TASTE_PERCENT_MAX, 20),
    explorationCount: clampInt(raw.explorationCount, 0, COMMISSION_MUSIC_TASTE_ANCHOR_MAX, 0),
    explorationDirection: ['more-familiar', 'more-experimental', 'balanced'].includes(raw.explorationDirection)
      ? raw.explorationDirection : 'balanced',
    anchors,
    statedContext: trimTo(raw.statedContext, MUSIC_TASTE_RECIPE_MAX_CONTEXT) || null,
    sourceVersion: trimTo(raw.sourceVersion, MUSIC_TASTE_RECIPE_MAX_SOURCE_VERSION) || 'unknown',
    sourceHash: isStr(raw.sourceHash) ? raw.sourceHash.trim().slice(0, 64) : 'unknown',
  };
}

/**
 * Build one recipe from bounded source projections. `status: unavailable` is
 * explicit so the scheduler never silently falls back to a generic track when
 * taste mode was enabled but no usable Digital Twin signal exists.
 */
export function buildMusicTasteRecipe({ commissionId, config: rawConfig, stated, observed, feedback, recentRuns, seed } = {}) {
  const config = normalizeMusicTasteConfig(rawConfig);
  if (!config) return { status: 'unavailable', reason: 'taste-source-unavailable' };
  const observedWindow = observed?.windows?.[config.window] || null;
  const statedContext = trimTo(stated?.summary, MUSIC_TASTE_RECIPE_MAX_CONTEXT);
  const candidates = normalizeCandidates(observedWindow);
  // A free-text stated summary is useful prompt context, but it is not a
  // deterministic artist/track anchor. Taste mode therefore requires at least
  // one bounded observed music anchor rather than quietly generating from prose.
  if (candidates.length === 0) return { status: 'unavailable', reason: 'taste-source-unavailable' };

  const effectiveExplorationPercent = clampInt(
    config.explorationPercent + feedbackAdjustment(feedback),
    0,
    COMMISSION_MUSIC_TASTE_PERCENT_MAX,
    config.explorationPercent,
  );
  const sourceProjection = {
    window: config.window,
    statedContext,
    statedAt: stated?.updatedAt || stated?.lastSessionAt || null,
    observedDerivedAt: observed?.derivedAt || null,
    candidates,
  };
  const sourceHash = createHash('sha256').update(canonicalStringify(sourceProjection)).digest('hex').slice(0, 32);
  const sourceVersion = `music-taste-v${MUSIC_TASTE_RECIPE_VERSION}:${stated?.updatedAt || stated?.lastSessionAt || 'none'}:${observed?.derivedAt || 'none'}`
    .slice(0, MUSIC_TASTE_RECIPE_MAX_SOURCE_VERSION);
  const stableSeed = seed || `${commissionId || 'commission'}:${sourceHash}:${(recentRuns || []).map((run) => run?.id || '').join(',')}`;
  const recentRecipes = (recentRuns || []).map((run) => run?.tasteRecipe).filter(Boolean);
  const anchorPreference = anchorFeedbackPreference(feedback, recentRuns);
  const anchors = selectAnchors(
    candidates,
    config,
    stableSeed,
    recentRecipes,
    effectiveExplorationPercent,
    anchorPreference.mode === 'keep' ? anchorPreference.recipe : null,
  );
  return {
    status: 'ready',
    recipe: sanitizeMusicTasteRecipe({
      version: MUSIC_TASTE_RECIPE_VERSION,
      source: 'digital-twin',
      window: config.window,
      anchorCount: config.anchorCount,
      explorationPercent: effectiveExplorationPercent,
      explorationCount: Math.min(anchors.length, Math.round(anchors.length * effectiveExplorationPercent / 100)),
      explorationDirection: explorationDirection(config.explorationPercent, effectiveExplorationPercent),
      anchors,
      statedContext,
      sourceVersion,
      sourceHash,
    }),
  };
}

export function renderMusicTasteRecipePrompt(recipe) {
  const safe = sanitizeMusicTasteRecipe(recipe);
  if (!safe) return '';
  const anchors = safe.anchors.map((anchor) => anchor.kind === 'track'
    ? `${anchor.name}${anchor.artist ? ` by ${anchor.artist}` : ''}`
    : anchor.name).join(', ');
  const context = safe.statedContext ? ` Stated music preference signal: ${safe.statedContext}` : '';
  return `Digital Twin music recipe (source ${safe.sourceVersion}, hash ${safe.sourceHash}): use these liked listening anchors as high-level inspiration only: ${anchors || 'none'}. Exploration level: ${safe.explorationPercent}% (${safe.explorationDirection}).${context} Create an original work; do not reproduce source tracks, lyrics, melodies, or impersonate named artists.`;
}
