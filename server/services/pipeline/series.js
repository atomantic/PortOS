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
import {
  sanitizeBibleList, mergeExtractedBible,
  BIBLE_LIMITS, BIBLE_KIND, BIBLE_FIELD, BIBLE_KEYS, BIBLE_SOURCE,
  isStr, trimTo,
} from '../../lib/storyBible.js';
import { sanitizeArc, sanitizeSeasonList } from '../../lib/storyArc.js';
import { sanitizeVisualStyleRef } from '../../lib/visualStyles.js';
import { extractBible } from '../../lib/bibleExtractor.js';
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { emitRecordUpdated, emitRecordDeleted } from '../sharing/recordEvents.js';

// Lazy resolution — PATHS.data may not be available at module-load time
// (e.g. tests that swap it through a Proxy mock).
const statePath = () => join(PATHS.data, 'pipeline-series.json');

export const ERR_NOT_FOUND = 'PIPELINE_SERIES_NOT_FOUND';
export const ERR_VALIDATION = 'PIPELINE_SERIES_VALIDATION';
export const ERR_DUPLICATE = 'PIPELINE_SERIES_DUPLICATE';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const SERIES_ID_RE = /^ser-[A-Za-z0-9-]+$/;

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
    characters: sanitizeBibleList(raw.characters, BIBLE_KIND.CHARACTER),
    settings: sanitizeBibleList(raw.settings, BIBLE_KIND.SETTING),
    objects: sanitizeBibleList(raw.objects, BIBLE_KIND.OBJECT),
    // Phase 2 of Story Arc Planning: optional multi-season story spine + the
    // ordered season list. Both default to empty so existing series.json
    // files migrate forward without a writer pass — first save backfills.
    arc: sanitizeArc(raw.arc),
    seasons: sanitizeSeasonList(raw.seasons),
    locked: sanitizeSeriesLocked(raw.locked),
    styleNotes: trimTo(raw.styleNotes, STYLE_NOTES_MAX),
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
  const state = await readState();
  const now = new Date().toISOString();
  const next = sanitizeSeries({
    id: `ser-${randomUUID()}`,
    name,
    logline: input.logline || '',
    premise: input.premise || '',
    universeId: input.universeId || null,
    writersRoomWorkId: input.writersRoomWorkId || null,
    characters: input.characters || [],
    settings: input.settings || [],
    objects: input.objects || [],
    arc: input.arc || null,
    seasons: input.seasons || [],
    locked: input.locked || {},
    styleNotes: input.styleNotes || '',
    targetFormat: input.targetFormat || 'comic+tv',
    issueCountTarget: input.issueCountTarget || 0,
    llm: input.llm || null,
    createdAt: now,
    updatedAt: now,
  });
  state.series.push(next);
  await writeState(state);
  return next;
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
  const state = await readState();
  if (state.series.some((s) => s.id === input.id)) {
    throw makeErr(`Series id already exists: ${input.id}`, ERR_DUPLICATE);
  }
  const next = sanitizeSeries({ ...input, name });
  if (!next) throw makeErr('Invalid series payload', ERR_VALIDATION);
  state.series.push(next);
  await writeState(state);
  return next;
}

export async function updateSeries(id, patch = {}) {
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
    ...('characters' in patch ? { characters: patch.characters } : {}),
    ...('settings' in patch ? { settings: patch.settings } : {}),
    ...('objects' in patch ? { objects: patch.objects } : {}),
    ...('arc' in patch ? { arc: patch.arc } : {}),
    ...('seasons' in patch ? { seasons: patch.seasons } : {}),
    // Wholesale replace — `locked: {}` clears every lock; omission preserves.
    ...('locked' in patch ? { locked: patch.locked } : {}),
    ...('styleNotes' in patch ? { styleNotes: patch.styleNotes } : {}),
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
}

/**
 * Strip a filename from every `imageRefs[]` across every series's
 * characters/settings/objects. Called by the image-delete route so a noun
 * card stops pointing at a file the user just deleted from the gallery.
 *
 * Returns `{ removed }` — total references stripped across all series.
 * Skips the write when nothing matched, so a delete of a non-noun image
 * (the common case) is a cheap no-op read.
 */
export async function purgeImageRefFromAllSeries(filename) {
  if (!filename || typeof filename !== 'string') return { removed: 0 };
  const state = await readState();
  let removed = 0;
  const touchedIds = [];
  const nextSeries = state.series.map((s) => {
    let touched = false;
    const patched = { ...s };
    for (const key of BIBLE_KEYS) {
      const list = Array.isArray(s[key]) ? s[key] : null;
      if (!list) continue;
      const nextList = list.map((entry) => {
        const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : null;
        if (!refs || !refs.includes(filename)) return entry;
        const trimmed = refs.filter((f) => f !== filename);
        removed += refs.length - trimmed.length;
        touched = true;
        return { ...entry, imageRefs: trimmed };
      });
      if (touched) patched[key] = nextList;
    }
    if (touched) touchedIds.push(s.id);
    return touched ? { ...patched, updatedAt: new Date().toISOString() } : s;
  });
  if (removed > 0) {
    await writeState({ series: nextSeries });
    // Each touched series is a mutation any active subscription should
    // propagate to its bucket; otherwise recipients keep stale imageRefs.
    for (const id of touchedIds) emitRecordUpdated('series', id);
  }
  return { removed };
}

/**
 * Run bible extraction across the requested kinds and merge results into a
 * series. The route layer used to thread extract → merge → patch itself,
 * which made `mergeExtractedBible` a route-layer concern. Lifting it here
 * gives the route a 3-line call and lets future consumers (re-sync from
 * Writers Room, batch bible refresh, etc) reuse the same orchestration.
 *
 * @param {string} seriesId
 * @param {object} opts
 * @param {string[]} opts.kinds        BIBLE_KIND values to run (defaults to all three)
 * @param {string} opts.corpus         prose body to extract from
 * @param {boolean} [opts.parallel]    fan out the kinds concurrently (HTTP-API providers only)
 * @param {string} [opts.providerOverride]
 * @returns {Promise<{ series, results }>} results is keyed by BIBLE_FIELD (e.g. `characters`)
 */
export async function extractAndMergeIntoSeries(seriesId, opts = {}) {
  const series = await getSeries(seriesId);

  // Phase B.3 routing: when the series links to a universe, extract into the
  // universe and return a compatible shape so every legacy caller keeps
  // working without a fork. New entries arrive auto-locked + tagged with this
  // series so a later refine/differentiate cannot silently rewrite them.
  if (series.universeId) {
    // Dynamic import avoids a circular dep through universeCanon → series.js.
    const { extractCanonFromProse } = await import('../universeCanon.js');
    const { universe, results } = await extractCanonFromProse(series.universeId, {
      ...opts,
      source: BIBLE_SOURCE.SERIES_EXTRACT,
      autoLock: true,
      sourceSeriesId: series.id,
    });
    return { series, universe, results };
  }

  // Dedup `kinds` — duplicates would run extra LLM calls AND last-write-wins
  // the merge for the same field, so the only observable effect of a repeat
  // is a wasted provider round-trip. Preserve first-seen order so callers
  // can rely on response key order in `results`.
  const rawKinds = (opts.kinds && opts.kinds.length)
    ? opts.kinds
    : [BIBLE_KIND.CHARACTER, BIBLE_KIND.SETTING, BIBLE_KIND.OBJECT];
  const kinds = [...new Set(rawKinds)];
  if (!isStr(opts.corpus) || !opts.corpus.trim()) {
    throw makeErr('extractAndMergeIntoSeries: corpus is required', ERR_VALIDATION);
  }

  const runOne = (kind) => extractBible({
    kind,
    corpus: opts.corpus,
    existing: series[BIBLE_FIELD[kind]] || [],
    context: { series: { id: series.id, name: series.name } },
    providerOverride: opts.providerOverride,
    source: `pipeline-bible-${kind}`,
  }).then((result) => ({ kind, result }));

  const completed = opts.parallel
    ? await Promise.all(kinds.map(runOne))
    : await kinds.reduce(async (acc, kind) => [...(await acc), await runOne(kind)], Promise.resolve([]));

  const results = {};
  const patch = {};
  for (const { kind, result } of completed) {
    const field = BIBLE_FIELD[kind];
    patch[field] = mergeExtractedBible(series[field] || [], result.extracted, kind);
    results[field] = {
      extracted: result.extracted, runId: result.runId,
      providerId: result.providerId, model: result.model,
    };
  }

  const updated = await updateSeries(series.id, patch);
  return { series: updated, results };
}

export async function deleteSeries(id) {
  const state = await readState();
  const before = state.series.length;
  state.series = state.series.filter((s) => s.id !== id);
  if (state.series.length === before) throw makeErr(`Series not found: ${id}`, ERR_NOT_FOUND);
  await writeState(state);
  // Any live share-bucket subscription for this series tears itself down via
  // the recordEvents listener instead of orphaning.
  emitRecordDeleted('series', id);
  return { id };
}
