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
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import { emitRecordUpdated, emitRecordDeleted } from '../sharing/recordEvents.js';
import { renameCollectionForSeries, unlinkCollectionsForSeries } from '../mediaCollections.js';

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
// How `stylePromptOverride` composes with the universe's style influences:
//   'prepend'  — override leads, universe trails (the historical default
//                — slight deviation, universe still visible)
//   'append'   — universe leads, override trails (universe-dominant)
//   'override' — universe style is dropped entirely (full spinoff look)
// Default 'prepend' so existing series migrate forward without a writer
// pass and the field can be absent in JSON.
export const STYLE_PROMPT_OVERRIDE_MODES = Object.freeze(['prepend', 'append', 'override']);
export const STYLE_PROMPT_OVERRIDE_MODE_DEFAULT = 'prepend';
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

// Per-field arc lock targets. Each field can be individually frozen so
// `resolveVerifyIssues` / `commitSeasonsWithRemap` rewrite unlocked fields
// while preserving locked ones verbatim. Sibling to the binary `locked.arc`
// (which freezes everything); the two stack — `locked.arc: true` always wins.
export const ARC_LOCKABLE_FIELDS = Object.freeze([
  'logline', 'summary', 'protagonistArc', 'themes', 'shape',
]);

const sanitizeSeriesLocked = (raw = {}) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of LOCKABLE_STAGES) {
    if (raw[key] === true) out[key] = true;
  }
  if (raw.arcFields && typeof raw.arcFields === 'object') {
    const arcFields = {};
    for (const k of ARC_LOCKABLE_FIELDS) {
      if (raw.arcFields[k] === true) arcFields[k] = true;
    }
    if (Object.keys(arcFields).length > 0) out.arcFields = arcFields;
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
    stylePromptOverrideMode: STYLE_PROMPT_OVERRIDE_MODES.includes(raw.stylePromptOverrideMode)
      ? raw.stylePromptOverrideMode
      : STYLE_PROMPT_OVERRIDE_MODE_DEFAULT,
    targetFormat,
    issueCountTarget,
    llm,
    // Share-bucket provenance — present on imported records, absent on locally-authored ones.
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
    // Soft-delete fields — peer sync needs the tombstone in the record itself
    // so LWW merge can resolve delete-vs-edit races by `updatedAt`.
    ...sanitizeSoftDeleteFields(raw),
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

export async function listSeries({ includeDeleted = false } = {}) {
  const { series } = await readState();
  const filtered = includeDeleted ? series : series.filter((s) => !s.deleted);
  return [...filtered].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getSeries(id, { includeDeleted = false } = {}) {
  const { series } = await readState();
  const found = series.find((s) => s.id === id);
  if (!found) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  if (found.deleted && !includeDeleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
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
      stylePromptOverrideMode: input.stylePromptOverrideMode,
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
    // Tombstone-overwrite: same contract as universeBuilder.insertUniverseWithId —
    // re-import undeletes; peer-sync resurrection is prevented at the merge
    // path via LWW, not here.
    const existingIdx = state.series.findIndex((s) => s.id === input.id);
    if (existingIdx >= 0 && !state.series[existingIdx].deleted) {
      throw makeErr(`Series id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const next = sanitizeSeries({ ...input, name });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    if (existingIdx >= 0) {
      console.warn(`♻️  insertSeriesWithId: overwriting tombstone for ${input.id}`);
      state.series[existingIdx] = next;
    } else {
      state.series.push(next);
    }
    await writeState(state);
    return next;
  });
}

export async function updateSeries(id, patch = {}) {
  // Pre-B.4 canon (characters/settings/objects) lives on the universe, not the
  // series — but a stale browser tab can still POST a legacy series shape and
  // see a silent 200. Warn so a regression that re-introduces the legacy
  // payload is observable in logs instead of vanishing canon.
  const legacyFields = ['characters', 'settings', 'objects'].filter((k) => k in patch);
  if (legacyFields.length > 0) {
    console.warn(`⚠️ series PATCH ${id.slice(0, 8)} stripped legacy canon fields: ${legacyFields.join(', ')}`);
  }
  const { merged, nameChanged } = await queueSeriesWrite(async () => {
    const state = await readState();
    const idx = state.series.findIndex((s) => s.id === id);
    if (idx < 0) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const cur = state.series[idx];
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    // Per-field merge so `{ provider: 'codex' }` doesn't clobber an existing `model`.
    const mergedLlm = 'llm' in patch
      ? { ...(cur.llm || {}), ...(patch.llm || {}) }
      : cur.llm;
    const next = sanitizeSeries({
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
      ...('stylePromptOverrideMode' in patch ? { stylePromptOverrideMode: patch.stylePromptOverrideMode } : {}),
      ...('targetFormat' in patch ? { targetFormat: patch.targetFormat } : {}),
      ...('issueCountTarget' in patch ? { issueCountTarget: patch.issueCountTarget } : {}),
      ...('origin' in patch ? { origin: patch.origin } : {}),
      llm: mergedLlm,
      updatedAt: new Date().toISOString(),
    });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    state.series[idx] = next;
    await writeState(state);
    emitRecordUpdated('series', next.id);
    return { merged: next, nameChanged: next.name !== cur.name };
  });
  // Cascade rename onto the linked per-series media collection (if any) —
  // log but don't fail the save. Runs OUTSIDE the queue so the media-
  // collections write tail can't stall subsequent series mutators. No-op
  // when no series-linked collection exists (the common case for
  // universe-backed series, where the universe owns the auto-collection).
  if (nameChanged) {
    await renameCollectionForSeries(merged.id, merged.name).catch((err) => {
      console.error(`❌ series-collection rename cascade failed for ${merged.id}: ${err?.message || err}`);
    });
  }
  return merged;
}

export async function setArcFieldLock(id, field, locked) {
  if (!ARC_LOCKABLE_FIELDS.includes(field)) {
    throw makeErr(`Unknown arc lock field: ${field}`, ERR_VALIDATION);
  }
  return queueSeriesWrite(async () => {
    const state = await readState();
    const idx = state.series.findIndex((s) => s.id === id);
    if (idx < 0) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const cur = state.series[idx];
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const arcFields = { ...(cur.locked?.arcFields || {}) };
    if (locked === true) arcFields[field] = true;
    else delete arcFields[field];
    const nextLocked = { ...(cur.locked || {}) };
    if (Object.keys(arcFields).length > 0) nextLocked.arcFields = arcFields;
    else delete nextLocked.arcFields;
    const next = sanitizeSeries({
      ...cur,
      locked: nextLocked,
      updatedAt: new Date().toISOString(),
    });
    if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
    state.series[idx] = next;
    await writeState(state);
    emitRecordUpdated('series', next.id);
    return next;
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
    if (cur.deleted) throw makeErr(`Series not found: ${seriesId}`, ERR_NOT_FOUND);
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
  // Soft-delete: flip `deleted` + stamp `deletedAt`, bump `updatedAt` so the
  // tombstone propagates via the existing LWW merge. Side effects (media-
  // collection unlink + recordDeleted emit) still run locally and also fire
  // on the receiving peer via mergeSeriesFromSync's transition detection.
  const result = await queueSeriesWrite(async () => {
    const state = await readState();
    const idx = state.series.findIndex((s) => s.id === id);
    if (idx < 0) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const cur = state.series[idx];
    if (cur.deleted) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
    const now = new Date().toISOString();
    state.series[idx] = { ...cur, deleted: true, deletedAt: now, updatedAt: now };
    await writeState(state);
    // Any live share-bucket subscription for this series tears itself down via
    // the recordEvents listener instead of orphaning.
    emitRecordDeleted('series', id);
    return { id };
  });
  // Release the rename-lock on any linked per-series media collection so
  // the orphan becomes a normal user-owned bucket. Runs OUTSIDE the series
  // write tail; best-effort, mirrors the universe-side flow.
  await unlinkCollectionsForSeries(id).catch((err) => {
    console.error(`❌ unlink media collections for deleted series ${id} failed: ${err?.message || err}`);
  });
  return result;
}

/**
 * Cascade orphan cleanup for a series whose soft-delete arrived via peer
 * sync. Mirrors the post-queue cleanup in deleteSeries so a synced delete on
 * the receiver leaves the same orphan-free state as a local delete.
 */
async function cascadeDeleteSideEffects(id) {
  await unlinkCollectionsForSeries(id).catch((err) => {
    console.error(`❌ unlink media collections for synced-delete series ${id} failed: ${err?.message || err}`);
  });
  emitRecordDeleted('series', id);
}

/**
 * Sync-orchestrator entry point. Merges a remote peer's series array into
 * local state INSIDE `queueSeriesWrite`, so the read-modify-write window
 * can't clobber (or be clobbered by) a concurrent bible edit, season-metadata
 * PATCH, season-cover render PATCH, or season-cover filename hook also running
 * through the same queue. Each incoming record passes through `sanitizeSeries`
 * for shape enforcement. LWW by `updatedAt`; returns `{ applied, count }`
 * where `count` is the number of series actually changed/added.
 */
export async function mergeSeriesFromSync(remoteSeries) {
  if (!Array.isArray(remoteSeries)) return { applied: false, count: 0 };
  // Series IDs that transitioned to deleted via this merge — cascade fires
  // after the write queue releases (mirrors local-delete contract).
  //
  // Edit-merges (no delete-transition) DO NOT call `emitRecordUpdated` here —
  // see `mergeUniversesFromSync` for the rationale (the Stage 2 per-record
  // peer-sync push owns sync-time edit emits).
  const transitionedToDeleted = [];
  const result = await queueSeriesWrite(async () => {
    const state = await readState();
    const localById = new Map(state.series.map((s) => [s.id, s]));
    let changed = 0;
    for (const remote of remoteSeries) {
      if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
      const sanitized = sanitizeSeries(remote);
      if (!sanitized) continue;
      const local = localById.get(sanitized.id);
      if (!local) {
        // See universeBuilder.mergeUniversesFromSync — no local means no
        // cascade work, regardless of inbound tombstone state.
        localById.set(sanitized.id, sanitized);
        changed++;
      } else {
        const localTs = local.updatedAt || '';
        const remoteTs = sanitized.updatedAt || '';
        if (remoteTs > localTs) {
          localById.set(sanitized.id, sanitized);
          if (sanitized.deleted && !local.deleted) transitionedToDeleted.push(sanitized.id);
          changed++;
        }
      }
    }
    if (changed === 0) return { applied: false, count: 0 };
    state.series = Array.from(localById.values());
    await writeState(state);
    return { applied: true, count: changed };
  });
  for (const id of transitionedToDeleted) {
    await cascadeDeleteSideEffects(id);
  }
  return result;
}

/**
 * Garbage-collect series tombstones older than `beforeMs`. See
 * `pruneTombstonedUniverses` in universeBuilder.js for the contract — the
 * caller owns the ack-cursor + grace-period math and just tells us the
 * cutoff timestamp. Tombstones with unparseable `deletedAt` are kept.
 */
export async function pruneTombstonedSeries(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  return queueSeriesWrite(async () => {
    const state = await readState();
    const original = state.series.length;
    state.series = state.series.filter((s) => {
      if (!s?.deleted) return true;
      const t = Date.parse(s.deletedAt || '');
      if (!Number.isFinite(t)) return true;
      return t >= beforeMs;
    });
    const pruned = original - state.series.length;
    if (pruned > 0) await writeState(state);
    return { pruned };
  });
}
