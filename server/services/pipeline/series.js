/**
 * Pipeline — Series Service
 *
 * A Series is the long-lived parent record for a narrative arc (comic series,
 * TV show, or both). It carries the shared "bible" — premise, characters,
 * world ref, style notes — that gets injected into every Issue's stage prompts
 * so issues stay visually and tonally consistent.
 *
 * Persisted to data/pipeline-series.json. Issues live in their own file
 * (server/services/pipeline/issues.js) and reference a series by id.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { sanitizeBibleList, BIBLE_LIMITS, BIBLE_KIND, isStr, trimTo } from '../../lib/storyBible.js';

// Lazy resolution — PATHS.data may not be available at module-load time
// (e.g. tests that swap it through a Proxy mock).
const statePath = () => join(PATHS.data, 'pipeline-series.json');

export const ERR_NOT_FOUND = 'PIPELINE_SERIES_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_SERIES_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const NAME_MAX = 200;
export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 8000;
export const STYLE_NOTES_MAX = 4000;
export const CHARACTER_NAME_MAX = BIBLE_LIMITS.NAME_MAX;
export const CHARACTER_DESCRIPTION_MAX = BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX;
export const CHARACTERS_PER_SERIES_MAX = BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX;
export const BIBLE_ENTRIES_PER_SERIES_MAX = BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX;
export const IMAGE_REFS_PER_CHARACTER_MAX = BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX;
export const IMAGE_REF_MAX = BIBLE_LIMITS.IMAGE_REF_MAX;
export const WORLD_ID_MAX = 64;
export const WRITERS_ROOM_WORK_ID_MAX = 64;
export const TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);
export const ISSUE_COUNT_TARGET_MAX = 999;

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
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    name,
    logline: trimTo(raw.logline, LOGLINE_MAX),
    premise: trimTo(raw.premise, PREMISE_MAX),
    worldId: trimTo(raw.worldId, WORLD_ID_MAX) || null,
    // Bidirectional link to a Writers Room work (item 6 of the DRY
    // unification). Set by the "Promote to pipeline" flow; never auto-cleared.
    writersRoomWorkId: trimTo(raw.writersRoomWorkId, WRITERS_ROOM_WORK_ID_MAX) || null,
    characters: sanitizeBibleList(raw.characters, BIBLE_KIND.CHARACTER),
    settings: sanitizeBibleList(raw.settings, BIBLE_KIND.SETTING),
    objects: sanitizeBibleList(raw.objects, BIBLE_KIND.OBJECT),
    styleNotes: trimTo(raw.styleNotes, STYLE_NOTES_MAX),
    targetFormat,
    issueCountTarget,
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
  const state = await readState();
  const now = new Date().toISOString();
  const next = sanitizeSeries({
    id: `ser-${randomUUID()}`,
    name,
    logline: input.logline || '',
    premise: input.premise || '',
    worldId: input.worldId || null,
    writersRoomWorkId: input.writersRoomWorkId || null,
    characters: input.characters || [],
    settings: input.settings || [],
    objects: input.objects || [],
    styleNotes: input.styleNotes || '',
    targetFormat: input.targetFormat || 'comic+tv',
    issueCountTarget: input.issueCountTarget || 0,
    createdAt: now,
    updatedAt: now,
  });
  state.series.push(next);
  await writeState(state);
  return next;
}

export async function updateSeries(id, patch = {}) {
  const state = await readState();
  const idx = state.series.findIndex((s) => s.id === id);
  if (idx < 0) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  const cur = state.series[idx];
  const merged = sanitizeSeries({
    ...cur,
    ...('name' in patch ? { name: patch.name } : {}),
    ...('logline' in patch ? { logline: patch.logline } : {}),
    ...('premise' in patch ? { premise: patch.premise } : {}),
    ...('worldId' in patch ? { worldId: patch.worldId } : {}),
    ...('writersRoomWorkId' in patch ? { writersRoomWorkId: patch.writersRoomWorkId } : {}),
    ...('characters' in patch ? { characters: patch.characters } : {}),
    ...('settings' in patch ? { settings: patch.settings } : {}),
    ...('objects' in patch ? { objects: patch.objects } : {}),
    ...('styleNotes' in patch ? { styleNotes: patch.styleNotes } : {}),
    ...('targetFormat' in patch ? { targetFormat: patch.targetFormat } : {}),
    ...('issueCountTarget' in patch ? { issueCountTarget: patch.issueCountTarget } : {}),
    updatedAt: new Date().toISOString(),
  });
  if (!merged) throw makeErr('Invalid series payload', ERR_VALIDATION);
  state.series[idx] = merged;
  await writeState(state);
  return merged;
}

export async function deleteSeries(id) {
  const state = await readState();
  const before = state.series.length;
  state.series = state.series.filter((s) => s.id !== id);
  if (state.series.length === before) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  await writeState(state);
  return { id };
}
