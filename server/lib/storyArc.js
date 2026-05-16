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

// Kurt Vonnegut's eight story shapes. The server only validates the id; the
// client owns the display metadata (label, point series for the sparkline).
// Keep this list in sync with `client/src/components/pipeline/StoryShapes.jsx`.
export const ARC_SHAPE_IDS = Object.freeze([
  'rags-to-riches',
  'tragedy',
  'man-in-hole',
  'icarus',
  'cinderella',
  'oedipus',
  'boy-meets-girl',
  'creation-story',
]);

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
