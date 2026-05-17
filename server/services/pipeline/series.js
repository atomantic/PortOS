/**
 * Pipeline — Series Service
 *
 * A Series is the long-lived parent record for a narrative arc (comic series,
 * TV show, or both). It carries premise + arc + style notes and links to a
 * Universe (`universeId`) where canon — characters, places, objects — lives;
 * those flow into every Issue's stage prompts so issues stay visually and
 * tonally consistent.
 *
 * Persisted to data/pipeline-series.json. Issues live in their own file
 * (server/services/pipeline/issues.js) and reference a series by id.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { sanitizeArc, sanitizeSeasonList } from '../../lib/storyArc.js';
import { sanitizeVisualStyleRef } from '../../lib/visualStyles.js';
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { emitRecordUpdated, emitRecordDeleted } from '../sharing/recordEvents.js';

// Lazy resolution — PATHS.data may not be available at module-load time
// (e.g. tests that swap it through a Proxy mock).
const statePath = () => join(PATHS.data, 'pipeline-series.json');

// File-level write lock. Required because multiple write paths can race on the single shared
// pipeline-series.json file: PATCH /series/:id (bible edits), PATCH
// /seasons/:seasonId (season metadata), the new volume cover-render route,
// the season-cover filename hook landing, and the bible-extract merge.
// All of those read-then-write the same JSON; without serialization a
// later writer's `readState` can land on a pre-image snapshot and clobber
// the earlier write. CLAUDE.md: "single tail per shared file."
const queueSeriesWrite = createFileWriteQueue();

export const ERR_NOT_FOUND = 'PIPELINE_SERIES_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_SERIES_VALIDATION';
export const ERR_DUPLICATE = 'PIPELINE_SERIES_DUPLICATE';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const SERIES_ID_RE = /^ser-[A-Za-z0-9-]+$/;

export const NAME_MAX = 200;
export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 8000;
export const STYLE_NOTES_MAX = 4000;
export const STYLE_PROMPT_OVERRIDE_MAX = 1000;
// Title/logo design concept — prose description injected into cover + TV
// title-screen prompts as the "logo design" cue. Generated from the universe's
// style notes on series creation; editable in the bible.
export const TITLE_LOGO_MAX = 2000;
export const AUTHOR_MAX = 120;
export const UNIVERSE_ID_MAX = 64;
export const WRITERS_ROOM_WORK_ID_MAX = 64;
export const TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);
export const ISSUE_COUNT_TARGET_MAX = 999;

export const LOCKABLE_STAGES = Object.freeze(['arc']);

const sanitizeSeriesLocked = (raw = {}) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of LOCKABLE_STAGES) {
    if (raw[key] === true) out[key] = true;
  }
  return out;
};

const DEFAULT_STATE = { series: [] };

const sanitizeSeries = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX);
  if (!name) return null;
  const targetFormat = TARGET_FORMATS.includes(raw.targetFormat) ? raw.targetFormat : 'comic+tv';
  const issueCountTarget = Number.isFinite(raw.issueCountTarget)
    ? Math.max(0, Math.min(ISSUE_COUNT_TARGET_MAX, Math.floor(raw.issueCountTarget)))
    : 0;
  const llm = raw.llm && typeof raw.llm === 'object'
    ? {
      provider: trimTo(raw.llm.provider, 80) || null,
      model: trimTo(raw.llm.model, 200) || null,
    }
    : { provider: null, model: null };
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    name,
    logline: trimTo(raw.logline, LOGLINE_MAX),
    premise: trimTo(raw.premise, PREMISE_MAX),
    universeId: trimTo(raw.universeId, UNIVERSE_ID_MAX) || null,
    // Bidirectional link to a Writers Room work (item 6 of the DRY
    // unification). Set by the "Promote to pipeline" flow; never auto-cleared.
    writersRoomWorkId: trimTo(raw.writersRoomWorkId, WRITERS_ROOM_WORK_ID_MAX) || null,
    // Phase 2 of Story Arc Planning: optional multi-season story spine + the
    // ordered season list. Both default to empty so existing series.json
    // files migrate forward without a writer pass — first save backfills.
    arc: sanitizeArc(raw.arc),
    seasons: sanitizeSeasonList(raw.seasons),
    locked: sanitizeSeriesLocked(raw.locked),
    styleNotes: trimTo(raw.styleNotes, STYLE_NOTES_MAX),
    titleLogo: trimTo(raw.titleLogo, TITLE_LOGO_MAX),
    author: trimTo(raw.author, AUTHOR_MAX),
    // Per-series override that prepends ahead of the linked universe's
    // stylePrompt during image-gen composition. Lets a single series in a
    // shared universe deviate slightly (e.g. a noir spin-off) without
    // forking the universe. Empty string = no override; fall through to
    // universe-only style.
    stylePromptOverride: trimTo(raw.stylePromptOverride, STYLE_PROMPT_OVERRIDE_MAX),
    // Series-level default visual style (catalog id + optional custom prompt).
    // `null` when the user hasn't picked one — stage-level fallbacks in
    // resolveVisualStyle() handle that case so legacy series keep rendering
    // without a writer pass.
    visualStyleDefault: sanitizeVisualStyleRef(raw.visualStyleDefault),
    targetFormat,
    issueCountTarget,
    llm,
    // Share-bucket provenance — present on imported records, absent on locally-authored ones.
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
  };
};

async function readState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(statePath(), DEFAULT_STATE, { logError: false });
  const series = Array.isArray(raw.series) ? raw.series.map(sanitizeSeries).filter(Boolean) : [];
  return { series };
}

async function writeState(state) {
  await atomicWrite(statePath(), state);
}

export async function listSeries() {
  const { series } = await readState();
  return [...series].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getSeries(id) {
  const { series } = await readState();
  const found = series.find((s) => s.id === id);
  if (!found) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  return found;
}

export async function createSeries(input = {}) {
  const name = trimTo(input.name, NAME_MAX);
  if (!name) throw makeErr(`Series name is required (1..${NAME_MAX} chars)`, ERR_VALIDATION);
  return queueSeriesWrite(async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const next = sanitizeSeries({
      id: `ser-${randomUUID()}`,
      name,
      logline: input.logline || '',
      premise: input.premise || '',
      universeId: input.universeId || null,
      writersRoomWorkId: input.writersRoomWorkId || null,
      arc: input.arc || null,
      seasons: input.seasons || [],
      locked: input.locked || {},
      styleNotes: input.styleNotes || '',
      titleLogo: input.titleLogo || '',
      author: input.author || '',
      stylePromptOverride: input.stylePromptOverride || '',
      targetFormat: input.targetFormat || 'comic+tv',
      issueCountTarget: input.issueCountTarget || 0,
      llm: input.llm || null,
      createdAt: now,
      updatedAt: now,
    });
    state.series.push(next);
    await writeState(state);
    return next;
  });
}

/**
 * Insert a series with a caller-supplied id (used by the share-bucket importer
 * so re-imports of the same series LWW-merge onto the same local row instead
 * of accumulating duplicates). Throws ERR_DUPLICATE if the id is already
 * present, ERR_VALIDATION if the id is malformed. Preserves createdAt /
 * updatedAt verbatim so LWW comparisons against subsequent re-shares work.
 */
export async function insertSeriesWithId(input = {}) {
  if (!isStr(input.id) || !SERIES_ID_RE.test(input.id)) {
    throw makeErr(`insertSeriesWithId: invalid id "${input.id}" (expected ser-<uuid>)`, ERR_VALIDATION);
  }
  const name = trimTo(input.name, NAME_MAX);
  if (!name) throw makeErr(`Series name is required (1..${NAME_MAX} chars)`, ERR_VALIDATION);
  return queueSeriesWrite(async () => {
    const state = await readState();
    if (state.series.some((s) => s.id === input.id)) {
      throw makeErr(`Series id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const next = sanitizeSeries({ ...input, name });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    state.series.push(next);
    await writeState(state);
    return next;
  });
}

export async function updateSeries(id, patch = {}) {
  return queueSeriesWrite(async () => {
    const state = await readState();
    const idx = state.series.findIndex((s) => s.id === id);
    if (idx < 0) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const cur = state.series[idx];
    // Per-field merge so `{ provider: 'codex' }` doesn't clobber an existing `model`.
    const mergedLlm = 'llm' in patch
      ? { ...(cur.llm || {}), ...(patch.llm || {}) }
      : cur.llm;
    const merged = sanitizeSeries({
      ...cur,
      ...('name' in patch ? { name: patch.name } : {}),
      ...('logline' in patch ? { logline: patch.logline } : {}),
      ...('premise' in patch ? { premise: patch.premise } : {}),
      ...('universeId' in patch ? { universeId: patch.universeId } : {}),
      ...('writersRoomWorkId' in patch ? { writersRoomWorkId: patch.writersRoomWorkId } : {}),
      ...('arc' in patch ? { arc: patch.arc } : {}),
      ...('seasons' in patch ? { seasons: patch.seasons } : {}),
      // Wholesale replace — `locked: {}` clears every lock; omission preserves.
      ...('locked' in patch ? { locked: patch.locked } : {}),
      ...('styleNotes' in patch ? { styleNotes: patch.styleNotes } : {}),
      ...('titleLogo' in patch ? { titleLogo: patch.titleLogo } : {}),
      ...('author' in patch ? { author: patch.author } : {}),
      ...('stylePromptOverride' in patch ? { stylePromptOverride: patch.stylePromptOverride } : {}),
      ...('visualStyleDefault' in patch ? { visualStyleDefault: patch.visualStyleDefault } : {}),
      ...('targetFormat' in patch ? { targetFormat: patch.targetFormat } : {}),
      ...('issueCountTarget' in patch ? { issueCountTarget: patch.issueCountTarget } : {}),
      ...('origin' in patch ? { origin: patch.origin } : {}),
      llm: mergedLlm,
      updatedAt: new Date().toISOString(),
    });
    if (!merged) throw makeErr('Invalid series payload', ERR_VALIDATION);
    state.series[idx] = merged;
    await writeState(state);
    emitRecordUpdated('series', merged.id);
    return merged;
  });
}

/**
 * Apply a structured patch to one season inside a series. Routes through the
 * shared series write tail so a season-cover render PATCH, the season-cover
 * filename hook landing, and a user-driven season metadata edit all serialize
 * against the single pipeline-series.json file. Returns the updated series.
 *
 * Throws `PIPELINE_SEASON_NOT_FOUND` (the seasons-service ERR_NOT_FOUND
 * value, inlined here to avoid a circular import seasons → series → seasons)
 * when the season is missing so the season-resource routes surface a 404
 * with "Season not found" rather than "Series not found".
 */
export async function updateSeasonOnSeries(seriesId, seasonId, patchFn) {
  return queueSeriesWrite(async () => {
    const state = await readState();
    const idx = state.series.findIndex((s) => s.id === seriesId);
    if (idx < 0) throw makeErr(`Series not found: ${seriesId}`, ERR_NOT_FOUND);
    const cur = state.series[idx];
    const seasons = Array.isArray(cur.seasons) ? cur.seasons : [];
    const seasonIdx = seasons.findIndex((s) => s.id === seasonId);
    if (seasonIdx < 0) {
      throw makeErr(`Season not found: ${seasonId}`, 'PIPELINE_SEASON_NOT_FOUND');
    }
    const existing = seasons[seasonIdx];
    const patched = patchFn(existing);
    // No-op short-circuit: `patchFn` returning `null`/`undefined` (or an empty
    // object) means "nothing changed" — typically a filename-hook racing a
    // newer job. Without this guard, every late completion event bumps
    // `season.updatedAt`, rewrites the series file, and re-broadcasts
    // `recordUpdated('series', …)`, which schedules a share re-export and
    // makes LWW comparisons noisy. Mirrors the empty-patch fast-path the
    // issues-side `updateStageWithLatest` already has.
    if (!patched || (typeof patched === 'object' && Object.keys(patched).length === 0)) {
      return cur;
    }
    const nextSeasons = [...seasons];
    // Force a fresh updatedAt on the touched season so LWW comparisons fire.
    nextSeasons[seasonIdx] = { ...existing, ...patched, updatedAt: new Date().toISOString() };
    const merged = sanitizeSeries({
      ...cur,
      seasons: nextSeasons,
      updatedAt: new Date().toISOString(),
    });
    if (!merged) throw makeErr('Invalid series payload after season patch', ERR_VALIDATION);
    state.series[idx] = merged;
    await writeState(state);
    emitRecordUpdated('series', merged.id);
    return merged;
  });
}

export async function deleteSeries(id) {
  return queueSeriesWrite(async () => {
    const state = await readState();
    const before = state.series.length;
    state.series = state.series.filter((s) => s.id !== id);
    if (state.series.length === before) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    await writeState(state);
    // Any live share-bucket subscription for this series tears itself down via
    // the recordEvents listener instead of orphaning.
    emitRecordDeleted('series', id);
    return { id };
  });
}
