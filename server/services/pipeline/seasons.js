/**
 * Pipeline — Seasons Service
 *
 * Seasons live inside the series record (`series.seasons[]`) — they are not a
 * separate file. This module is a thin facade over `series.js` that provides
 * the CRUD vocabulary the route layer expects (list / create / update /
 * delete) and handles the cross-record concern that delete entails:
 * re-pointing every child issue's `seasonId` so a deleted season doesn't
 * leave orphan references.
 *
 * Phase 2 of the Story Arc Planning initiative. See PLAN.md for the full spec.
 */

import { ARC_LIMITS, buildSeason, sanitizeSeason } from '../../lib/storyArc.js';
import { isStr } from '../../lib/storyBible.js';
import * as seriesSvc from './series.js';
import * as issuesSvc from './issues.js';

export const ERR_NOT_FOUND = 'PIPELINE_SEASON_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_SEASON_VALIDATION';
export const ERR_REASSIGN_TARGET = 'PIPELINE_SEASON_REASSIGN_TARGET_INVALID';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export async function listSeasons(seriesId) {
  const series = await seriesSvc.getSeries(seriesId);
  return series.seasons || [];
}

export async function getSeason(seriesId, seasonId) {
  const seasons = await listSeasons(seriesId);
  const found = seasons.find((s) => s.id === seasonId);
  if (!found) throw makeErr(`Season not found: ${seasonId}`, ERR_NOT_FOUND);
  return found;
}

export async function createSeason(seriesId, input = {}) {
  const next = buildSeason(input);
  if (!next) {
    throw makeErr('Season requires a title or a number > 0', ERR_VALIDATION);
  }
  const series = await seriesSvc.getSeries(seriesId);
  const existing = series.seasons || [];
  if (existing.length >= ARC_LIMITS.SEASONS_PER_SERIES_MAX) {
    throw makeErr(`Series already has ${ARC_LIMITS.SEASONS_PER_SERIES_MAX} seasons (max)`, ERR_VALIDATION);
  }
  // If the user didn't pick a number, default to last + 1 so the canonical
  // ordering reads naturally. Falls back to 1 for the first season.
  if (!next.number) {
    const peakNumber = existing.reduce((m, s) => Math.max(m, s.number || 0), 0);
    next.number = peakNumber + 1;
  }
  const merged = [...existing, next];
  const updated = await seriesSvc.updateSeries(seriesId, { seasons: merged });
  // Return the season we built so the caller doesn't have to re-find it; the
  // sort/dedup in `sanitizeSeasonList` may have re-ordered the list, but the
  // id stays stable.
  return updated.seasons.find((s) => s.id === next.id);
}

export async function updateSeason(seriesId, seasonId, patch = {}) {
  const series = await seriesSvc.getSeries(seriesId);
  const seasons = series.seasons || [];
  const cur = seasons.find((s) => s.id === seasonId);
  if (!cur) throw makeErr(`Season not found: ${seasonId}`, ERR_NOT_FOUND);
  // Preserve `createdAt` and force a fresh `updatedAt` by overwriting them
  // directly in the sanitizer input — the default `preserveTimestamps: true`
  // path then just reads them through cleanly.
  const next = sanitizeSeason({
    ...cur,
    ...patch,
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: new Date().toISOString(),
  });
  if (!next) throw makeErr('Season requires a title or a number > 0', ERR_VALIDATION);
  // Re-write the whole seasons array — the series sanitizer re-sorts by
  // `number` ascending so a number change moves the season automatically.
  const merged = seasons.map((s) => (s.id === seasonId ? next : s));
  const updated = await seriesSvc.updateSeries(seriesId, { seasons: merged });
  return updated.seasons.find((s) => s.id === seasonId);
}

/**
 * Delete a season. Every issue whose `seasonId` matched the deleted season
 * gets reassigned to `reassignTo` (a sibling season id or `null` for
 * un-grouped). Passing `reassignTo` for a season that doesn't exist on the
 * series rejects with `ERR_REASSIGN_TARGET` before mutating anything.
 */
export async function deleteSeason(seriesId, seasonId, { reassignTo = null } = {}) {
  const series = await seriesSvc.getSeries(seriesId);
  const seasons = series.seasons || [];
  const cur = seasons.find((s) => s.id === seasonId);
  if (!cur) throw makeErr(`Season not found: ${seasonId}`, ERR_NOT_FOUND);
  // Validate the reassign target up front. Passing a non-existent sibling id
  // here is a user-side bug (stale state, copy-paste error) — surfacing it
  // before any disk writes means the caller can retry cleanly.
  if (reassignTo != null) {
    if (!isStr(reassignTo)) {
      throw makeErr('reassignTo must be a season id or null', ERR_REASSIGN_TARGET);
    }
    if (reassignTo === seasonId) {
      throw makeErr('reassignTo cannot be the season being deleted', ERR_REASSIGN_TARGET);
    }
    const target = seasons.find((s) => s.id === reassignTo);
    if (!target) {
      throw makeErr(`reassignTo season not found: ${reassignTo}`, ERR_REASSIGN_TARGET);
    }
  }
  // Re-point child issues first so a mid-write crash doesn't leave them
  // dangling against a deleted season id. `updateIssue` is per-issue (and
  // each call writes the file), so we batch-iterate; the data set is small
  // (issues per series ~< 100) so the cost is bounded.
  const childIssues = await issuesSvc.listIssues({ seriesId });
  const reassignList = childIssues.filter((iss) => iss.seasonId === seasonId);
  for (const iss of reassignList) {
    await issuesSvc.updateIssue(iss.id, { seasonId: reassignTo });
  }
  const merged = seasons.filter((s) => s.id !== seasonId);
  await seriesSvc.updateSeries(seriesId, { seasons: merged });
  return { id: seasonId, reassignedIssueCount: reassignList.length, reassignedTo: reassignTo };
}
