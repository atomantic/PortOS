/**
 * Canonical Arc + Season shapes for the Pipeline Story Arc Planning feature.
 *
 * Sibling to `storyBible.js` — same role, different scope. Story bibles describe
 * the *characters, settings, and objects* that recur across an arc; this module
 * describes the *temporal spine*: the multi-season story arc and its season
 * breakdown. Both live on the series record.
 *
 * Shapes:
 *   series.arc       (optional) overall multi-season story spine
 *   series.seasons[] ordered list of seasons/volumes
 *   issue.seasonId   (optional pointer back to a season)
 *   issue.arcPosition (optional ordinal within the season — drives auto-sort)
 *
 * Used by `services/pipeline/series.js` (sanitize on load/save) and
 * `services/pipeline/seasons.js` (CRUD + child-issue reassignment on delete).
 */

import { randomUUID } from 'crypto';
import { isStr, trimTo } from './storyBible.js';
import { sanitizeCoverLike } from './renderSlot.js';

export const ARC_LIMITS = Object.freeze({
  LOGLINE_MAX: 500,
  SUMMARY_MAX: 8000,
  PROTAGONIST_ARC_MAX: 4000,
  THEME_MAX: 100,
  THEMES_PER_ARC_MAX: 20,
  // Season
  SEASON_TITLE_MAX: 200,
  SEASON_LOGLINE_MAX: 500,
  SEASON_SYNOPSIS_MAX: 4000,
  SEASON_ENDING_HOOK_MAX: 1000,
  SEASON_NUMBER_MAX: 99,
  SEASON_EPISODE_COUNT_MAX: 999,
  SEASONS_PER_SERIES_MAX: 50,
});

export const ARC_STATUSES = Object.freeze(['draft', 'verified']);
export const SEASON_STATUSES = Object.freeze(['draft', 'verified', 'in-production', 'complete']);

// Per-episode arc roles produced by the season-episodes generator and
// persisted on the issue so downstream stages (idea-expansion in particular)
// know whether they're writing a pilot vs. midpoint vs. finale episode.
export const ARC_ROLES = Object.freeze(['pilot', 'complication', 'midpoint', 'b-plot', 'all-is-lost', 'finale']);

// Kurt Vonnegut's eight story shapes. The client owns the sparkline rendering
// but the points + descriptions live here too so prompt contexts have a
// consistent, deterministic story of what each shape *means* in terms of the
// protagonist's emotional fortune across the arc.
//
// Keep `points` arrays in sync with `client/src/components/pipeline/StoryShapes.jsx`
// — the unit test `storyArc.test.js` asserts they remain identical.
export const ARC_SHAPES = Object.freeze([
  {
    id: 'rags-to-riches',
    label: 'Rags to Riches',
    description: 'Steady monotonic rise from misfortune to triumph.',
    points: [-1, -0.7, -0.4, -0.1, 0.3, 0.7, 1],
    guidance: 'The protagonist\'s fortune climbs monotonically across the arc. Every volume must end better than it began. Setbacks happen but never reverse the overall climb. Open in a low/constrained state; finale lands in unambiguous triumph.',
  },
  {
    id: 'tragedy',
    label: 'Tragedy',
    description: 'Steady fall from good fortune to ruin.',
    points: [1, 0.7, 0.4, 0.1, -0.3, -0.7, -1],
    guidance: 'The protagonist\'s fortune falls monotonically across the arc. Open in a high/privileged state; each volume erodes it further. Brief upticks are allowed but never recover the loss. Finale lands in unambiguous ruin or loss.',
  },
  {
    id: 'man-in-hole',
    label: 'Man in Hole',
    description: 'Falls into trouble, climbs out better than before.',
    points: [0.4, 0, -0.6, -1, -0.5, 0.3, 0.9],
    guidance: 'Open near baseline-good. Plunge to the arc\'s nadir around the midpoint (Volume 2 of 3, midseason of a 1-volume run). Climb out steadily; finale lands higher than the opening. The protagonist is changed by what they survived.',
  },
  {
    id: 'icarus',
    label: 'Icarus',
    description: 'Soars high, then crashes.',
    points: [-0.4, 0.2, 0.7, 1, 0.5, -0.2, -1],
    guidance: 'Rise sharply through the first half of the arc to a peak near the midpoint, then fall just as sharply. Finale lands lower than the opening. The crash should feel earned by the over-reach, not arbitrary.',
  },
  {
    id: 'cinderella',
    label: 'Cinderella',
    description: 'Rises, suffers a setback, soars to the highest peak.',
    points: [-0.7, -0.3, 0.2, 0.5, -0.3, 0.4, 1],
    guidance: 'Open low. Rise through the first half to a modest high, then suffer a sharp reversal around two-thirds in (the "all is lost" beat). Recovery in the final stretch reaches a higher peak than the first rise. Finale is unambiguous triumph.',
  },
  {
    id: 'oedipus',
    label: 'Oedipus',
    description: 'Falls, briefly recovers, falls again to the worst.',
    points: [0.3, -0.2, -0.7, 0.2, 0.5, 0, -1],
    guidance: 'Open near baseline. Fall to a first low in the first third, recover apparently in the middle, then fall further to the arc\'s nadir at the finale. The second fall must reframe the apparent recovery as illusion or trap.',
  },
  {
    id: 'boy-meets-girl',
    label: 'Boy Meets Girl',
    description: 'Gets the thing, loses it, gets it back for good.',
    points: [0, 0.6, 0.9, 0.2, -0.5, 0.3, 0.9],
    guidance: 'Open at baseline. Get the thing (relationship, goal, identity) early; lose it around two-thirds in; reclaim it permanently by the finale. Three-act emotional rhythm: gain, loss, restored gain. Finale is unambiguous reunion or restoration.',
  },
  {
    id: 'creation-story',
    label: 'Creation Story',
    description: 'Stepped ascent — each plateau is a new world.',
    points: [-1, -1, -0.4, -0.4, 0.3, 0.3, 1],
    guidance: 'Stepped monotonic ascent. Each volume ends at a *new plateau* — qualitatively different from the previous, not just incrementally better. Plateaus matter as much as the climbs; finale is the highest plateau.',
  },
]);

export const ARC_SHAPE_IDS = Object.freeze(ARC_SHAPES.map((s) => s.id));

const ARC_SHAPES_BY_ID = new Map(ARC_SHAPES.map((s) => [s.id, s]));

export function getArcShape(id) {
  return ARC_SHAPES_BY_ID.get(id) || null;
}

/**
 * Convert the 7-point fortune curve to a human label at a given normalized
 * position (0..1). The LLM gets words it can reason about — "low", "rising",
 * "peak" — instead of a raw float that doesn't translate into beats.
 */
function describeFortuneLevel(v) {
  if (v >= 0.75) return 'peak / triumphant';
  if (v >= 0.35) return 'high / favorable';
  if (v >= -0.15) return 'near baseline';
  if (v >= -0.55) return 'low / strained';
  return 'nadir / ruinous';
}

function describeFortuneMovement(prev, curr) {
  const delta = curr - prev;
  if (delta >= 0.4) return 'sharp climb';
  if (delta >= 0.12) return 'steady climb';
  if (delta <= -0.4) return 'sharp fall';
  if (delta <= -0.12) return 'steady fall';
  return 'plateau';
}

// Sample the 7-point series at a normalized index (0..n-1, fractional allowed)
// with linear interpolation. Returns 0 when the shape is unknown so callers
// get a defined number even off the happy path.
function sampleShapePoints(points, idx) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const clamped = Math.max(0, Math.min(points.length - 1, idx));
  const lo = Math.floor(clamped);
  const hi = Math.min(points.length - 1, lo + 1);
  const t = clamped - lo;
  return points[lo] * (1 - t) + points[hi] * t;
}

/**
 * Describe one season's expected emotional position within an arc shape.
 * Returns null when shape is unknown or totals are invalid — the prompt
 * builder then renders a "no shape selected" fallback.
 *
 * `seasonNumber` and `totalSeasons` are 1-based; `seasonNumber=1, totalSeasons=3`
 * maps to ~point[1] in a 7-point series, etc.
 */
export function describeArcShapePositionForSeason(shapeId, seasonNumber, totalSeasons) {
  const shape = getArcShape(shapeId);
  if (!shape) return null;
  if (!Number.isFinite(totalSeasons) || !Number.isFinite(seasonNumber)) return null;
  const n = Math.floor(totalSeasons);
  const k = Math.floor(seasonNumber);
  if (n < 1 || k < 1 || k > n) return null;
  const pts = shape.points;
  // Map season index → point index. Season 1 of 1 hits the midpoint; season 1
  // of N hits the start, season N of N hits the end.
  const normalized = n === 1 ? (pts.length - 1) / 2 : ((k - 1) / (n - 1)) * (pts.length - 1);
  const curr = sampleShapePoints(pts, normalized);
  const prev = k > 1 ? sampleShapePoints(pts, ((k - 2) / (n - 1)) * (pts.length - 1)) : null;
  const level = describeFortuneLevel(curr);
  const movement = prev == null ? 'opening position' : describeFortuneMovement(prev, curr);
  return {
    level,
    movement,
    fortune: Number(curr.toFixed(2)),
    summary: `Volume ${k} of ${n} in a "${shape.label}" arc — emotional fortune should sit at ${level} (${movement}).`,
  };
}

/**
 * Block of arc-level shape guidance for prompt contexts. Returns a multi-line
 * string when the series has a picked shape, or null when it doesn't — the
 * prompt template treats null as "no shape selected; propose one if helpful."
 */
export function renderArcShapeGuidance(shapeId) {
  const shape = getArcShape(shapeId);
  if (!shape) return null;
  return `Picked story shape: **${shape.label}** (${shape.id}). ${shape.description}\n\nShape guidance: ${shape.guidance}`;
}

// Convenience for prompt contexts that only need the one-line position summary
// (not the full {level, movement, fortune} object). Returns null when shape /
// season / totals are missing, so callers can OR-fallback to a context-
// specific "no shape" string while keeping that fallback text at the call site.
export function renderArcShapePositionSummary(shapeId, seasonNumber, totalSeasons) {
  const position = describeArcShapePositionForSeason(shapeId, seasonNumber, totalSeasons);
  return position ? position.summary : null;
}

const SEASON_ID_PREFIX = 'sea-';
// `id` of an existing season as written by us. Used by `sanitizeSeason` so
// callers (route patch handlers, season service) accept either an id we
// generated or an opaque id from an imported series file.
const SEASON_ID_RE = /^sea-[a-zA-Z0-9-]+$/;

const nowIso = () => new Date().toISOString();

function ensureSeasonId(raw) {
  if (isStr(raw) && SEASON_ID_RE.test(raw)) return raw;
  return `${SEASON_ID_PREFIX}${randomUUID()}`;
}

function cleanThemes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const s = trimTo(v, ARC_LIMITS.THEME_MAX);
    if (s) out.push(s);
    if (out.length >= ARC_LIMITS.THEMES_PER_ARC_MAX) break;
  }
  return out;
}

/**
 * Sanitize the optional `series.arc` field. Returns `null` if the input is
 * empty (no identifying fields) — callers store `null` to mean "no arc yet."
 * Anything else round-trips through the canonical shape with explicit
 * type-safe defaults so a partial-shape payload from the LLM (or an old
 * series.json) never crashes downstream readers.
 */
export function sanitizeArc(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') return null;
  const logline = trimTo(raw.logline, ARC_LIMITS.LOGLINE_MAX);
  const summary = trimTo(raw.summary, ARC_LIMITS.SUMMARY_MAX);
  const protagonistArc = trimTo(raw.protagonistArc, ARC_LIMITS.PROTAGONIST_ARC_MAX);
  const themes = cleanThemes(raw.themes);
  // An arc with zero identifying content is indistinguishable from "no arc"
  // — store null so the UI can render the empty state instead of a blank
  // expanded panel. This also keeps the JSON tighter on disk. A picked
  // `shape` counts as identifying content: it's an explicit narrative
  // decision the user made at create time and shouldn't silently vanish.
  const shape = isStr(raw.shape) && ARC_SHAPE_IDS.includes(raw.shape) ? raw.shape : null;
  if (!logline && !summary && !protagonistArc && themes.length === 0 && !shape) return null;
  const status = ARC_STATUSES.includes(raw.status) ? raw.status : 'draft';
  return { logline, summary, protagonistArc, themes, shape, status };
}

/**
 * Sanitize one season. Returns `null` if the season has no identifying content
 * (no title and no number > 0) — `sanitizeSeasonList` then drops it on the
 * floor. `preserveTimestamps: false` forces a fresh `updatedAt` (used when a
 * patch lands on an existing season).
 */
export function sanitizeSeason(raw, { preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const title = trimTo(raw.title, ARC_LIMITS.SEASON_TITLE_MAX);
  const number = Number.isFinite(raw.number)
    ? Math.max(0, Math.min(ARC_LIMITS.SEASON_NUMBER_MAX, Math.floor(raw.number)))
    : 0;
  // A season with neither a title nor a positive number is unaddressable —
  // there's nothing for the UI to render and nothing for an issue's
  // `seasonId` pointer to match against meaningfully.
  if (!title && number <= 0) return null;
  const episodeCountTarget = Number.isFinite(raw.episodeCountTarget)
    ? Math.max(0, Math.min(ARC_LIMITS.SEASON_EPISODE_COUNT_MAX, Math.floor(raw.episodeCountTarget)))
    : 0;
  const status = SEASON_STATUSES.includes(raw.status) ? raw.status : 'draft';
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  const updated = preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso();
  return {
    id: ensureSeasonId(raw.id),
    number,
    title,
    logline: trimTo(raw.logline, ARC_LIMITS.SEASON_LOGLINE_MAX),
    synopsis: trimTo(raw.synopsis, ARC_LIMITS.SEASON_SYNOPSIS_MAX),
    episodeCountTarget,
    themes: cleanThemes(raw.themes),
    endingHook: trimTo(raw.endingHook, ARC_LIMITS.SEASON_ENDING_HOOK_MAX),
    // Volume (season) cover + back cover. Same script + proof + final
    // slot shape as an issue cover; rendered by enqueueVolumeCover and
    // assembled into the volume PDF as the trade-paperback bookends.
    // Both default to null; the season-cover render route writes them.
    cover: sanitizeCoverLike(raw.cover),
    backCover: sanitizeCoverLike(raw.backCover),
    status,
    createdAt: created,
    updatedAt: updated,
  };
}

/**
 * Sanitize the `series.seasons[]` field. Drops rejected entries, caps at
 * SEASONS_PER_SERIES_MAX, deduplicates ids (last-write-wins on collision),
 * and sorts by `number` ascending so consumers can render straight from the
 * array.
 */
export function sanitizeSeasonList(rawList, opts = {}) {
  if (!Array.isArray(rawList)) return [];
  const byId = new Map();
  for (const raw of rawList) {
    const s = sanitizeSeason(raw, opts);
    if (!s) continue;
    byId.set(s.id, s);
    if (byId.size >= ARC_LIMITS.SEASONS_PER_SERIES_MAX) break;
  }
  return [...byId.values()].sort((a, b) => (a.number || 0) - (b.number || 0));
}

/**
 * Build a fresh season from a create payload. The route layer enforces a
 * minimum shape (title + number) via zod; this function fills in id,
 * timestamps, and the canonical defaults.
 */
export function buildSeason(input = {}) {
  return sanitizeSeason({
    id: `${SEASON_ID_PREFIX}${randomUUID()}`,
    number: input.number,
    title: input.title,
    logline: input.logline,
    synopsis: input.synopsis,
    episodeCountTarget: input.episodeCountTarget,
    themes: input.themes,
    endingHook: input.endingHook,
    status: input.status,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}
