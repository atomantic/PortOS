/**
 * Smart-merge engine for duplicate Universes and Series.
 *
 * "Merge" folds a LOSER record's unique data into a SURVIVOR, resolves
 * genuinely-conflicting scalar fields via a caller-supplied `fieldChoices` map
 * (the UI renders each conflict with InlineDiff and picks survivor|loser),
 * re-points the loser's children to the survivor, then tombstones the loser so
 * the deletion propagates to peers via the existing LWW + tombstone machinery.
 *
 * List-shaped fields are UNIONED (no data loss):
 *   - universe.categories  — variations deduped by id OR normalizeLabelKey(label)
 *   - universe.compositeSheets — by id OR label
 *   - universe.characters/places/objects — via storyBible.mergeExtractedBible
 *     (dedupes by name + aliases, the same identity the importer uses)
 *   - universe.influences.{embrace,avoid} — case-insensitive dedupe
 *   - series.seasons — by season `number`
 *   - imageRefs[] on matched variations/sheets — unioned so render history survives
 *
 * `dryRun: true` returns the proposed unioned record + the conflicting-field
 * list + a cascade summary WITHOUT writing — that's the preview the UI shows.
 *
 * Cascade ordering is load-bearing: re-point children BEFORE tombstoning the
 * loser, so nothing is orphaned and (for universes) the block-until-empty
 * delete guard doesn't trip.
 */

import {
  getUniverse, updateUniverse, deleteUniverse,
  normalizeLabelKey,
  VARIATIONS_PER_CATEGORY_MAX, COMPOSITE_SHEETS_MAX, INFLUENCES_PER_LIST_MAX, IMAGE_REFS_PER_ENTRY_MAX,
} from './universeBuilder.js';
import { mergeExtractedBible, BIBLE_KIND, isStr } from '../lib/storyBible.js';
import { canonicalStringify, isEmptyScalar } from '../lib/objects.js';
import { getSeries, updateSeries, deleteSeries, listSeries } from './pipeline/series.js';
import { reassignIssuesToSeries, listIssues } from './pipeline/issues.js';
import {
  findCollectionByUniverseId, findOrCreateUniverseCollection,
  findCollectionBySeriesId, findOrCreateSeriesCollection,
  bulkUpdateCollectionItems, deleteCollection,
} from './mediaCollections.js';

// Own error code (both the universe-builder and pipeline routers map it to
// 400). get*() NOT_FOUND errors propagate with their own per-record codes,
// which each router already maps to 404.
export const ERR_VALIDATION = 'MERGE_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// ---- pure union helpers (exported for unit tests) ----

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// Union two imageRefs arrays (survivor first), dedupe by value, cap to the
// per-entry limit keeping the newest tail (matches the sanitizer's policy).
const unionImageRefs = (a = [], b = []) => {
  const seen = new Set();
  const out = [];
  for (const ref of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = typeof ref === 'string' ? ref : JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out.length > IMAGE_REFS_PER_ENTRY_MAX ? out.slice(-IMAGE_REFS_PER_ENTRY_MAX) : out;
};

// Identity keys for a variation/sheet. Cross-install duplicates routinely
// carry DIFFERENT ids for the same conceptual entry (each install minted its
// own id), so id-only matching would leave obvious same-label dupes side by
// side after a merge. Match by id first, then fall back to normalized label
// (mirrors universeBuilderRefine.js's label-keyed merge). Returns both keys so
// the loser can match a survivor by either.
const entryIdKey = (e) => (e?.id ? `id:${e.id}` : null);
const entryLabelKey = (e) => {
  const norm = normalizeLabelKey(e?.label);
  return norm ? `label:${norm}` : null;
};

/**
 * Union two variation (or composite-sheet) arrays: survivor entries first,
 * loser-uniques appended; on identity match keep the survivor entry but union
 * its imageRefs. A loser entry matches a survivor by id OR by normalized label
 * (so cross-install entries with different ids but the same label still fold).
 * Caps to `max`.
 */
export const unionEntryList = (survivor = [], loser = [], max = VARIATIONS_PER_CATEGORY_MAX) => {
  const out = [];
  const byId = new Map();
  const byLabel = new Map();
  for (const e of Array.isArray(survivor) ? survivor : []) {
    const copy = { ...e };
    const idKey = entryIdKey(copy);
    const labelKey = entryLabelKey(copy);
    if (idKey) byId.set(idKey, copy);
    if (labelKey && !byLabel.has(labelKey)) byLabel.set(labelKey, copy);
    out.push(copy);
  }
  for (const e of Array.isArray(loser) ? loser : []) {
    const idKey = entryIdKey(e);
    const labelKey = entryLabelKey(e);
    const match = (idKey && byId.get(idKey)) || (labelKey && byLabel.get(labelKey));
    if (match) {
      match.imageRefs = unionImageRefs(match.imageRefs, e.imageRefs);
    } else if (out.length < max) {
      const copy = { ...e };
      out.push(copy);
      if (idKey) byId.set(idKey, copy);
      if (labelKey && !byLabel.has(labelKey)) byLabel.set(labelKey, copy);
    }
  }
  return out.slice(0, max);
};

/** Union two `categories` keyed maps. */
export const unionCategories = (survivor = {}, loser = {}) => {
  const out = {};
  const keys = new Set([...Object.keys(survivor || {}), ...Object.keys(loser || {})]);
  for (const key of keys) {
    const s = survivor?.[key];
    const l = loser?.[key];
    if (s && l) {
      out[key] = { ...s, variations: unionEntryList(s.variations, l.variations) };
    } else {
      out[key] = s || l;
    }
  }
  return out;
};

/** Union two `influences` objects ({embrace[],avoid[]}), case-insensitive dedupe. */
export const unionInfluences = (survivor = {}, loser = {}) => {
  const mergeList = (a = [], b = []) => {
    const seen = new Set();
    const out = [];
    for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      const key = lc(v);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
      if (out.length >= INFLUENCES_PER_LIST_MAX) break;
    }
    return out;
  };
  return {
    embrace: mergeList(survivor?.embrace, loser?.embrace),
    avoid: mergeList(survivor?.avoid, loser?.avoid),
  };
};

// Union series seasons by `number`: survivor seasons first; loser seasons whose
// number isn't already present get appended. On a number collision the loser
// season is NOT dropped — its non-empty fields gap-fill the survivor season (the
// survivor wins real conflicts) so a colliding season's summary/episodes/cover
// can't be silently lost when the loser series is tombstoned. Seasons are
// cloned so the gap-fill never mutates the input survivor record.
const unionSeasons = (survivor = [], loser = []) => {
  const out = [];
  const byNumber = new Map();
  for (const s of Array.isArray(survivor) ? survivor : []) {
    const clone = (s && typeof s === 'object') ? { ...s } : s;
    out.push(clone);
    if (Number.isFinite(clone?.number)) byNumber.set(clone.number, clone);
  }
  for (const l of Array.isArray(loser) ? loser : []) {
    if (Number.isFinite(l?.number) && byNumber.has(l.number)) {
      const sv = byNumber.get(l.number);
      if (sv && typeof sv === 'object' && l && typeof l === 'object') {
        for (const [k, v] of Object.entries(l)) {
          if (k === 'number') continue;
          if (isEmptyScalar(sv[k]) && !isEmptyScalar(v)) sv[k] = v;
        }
      }
      continue;
    }
    out.push(l);
    if (Number.isFinite(l?.number)) byNumber.set(l.number, l);
  }
  return out;
};

/**
 * Resolve a set of scalar fields between survivor + loser.
 * Returns `{ values, conflicts, autoResolved }`:
 *   - conflicts: both sides non-empty AND differ → caller must supply a choice.
 *   - autoResolved: only one side non-empty → take it (no prompt needed).
 *   - equal / both-empty → survivor value, silently.
 * `fieldChoices` is `{ [field]: 'survivor' | 'loser' }`.
 * `fieldOverrides` is `{ [field]: any }` — if a field appears here, the value
 * is taken verbatim and the survivor/loser binary is ignored (used by the
 * AI-merge flow which produces a unified third option, editable by the user).
 * Overrides skip the conflict gate even when both sides differ, so an explicit
 * AI/user-edited value flows through without a redundant 'survivor'|'loser'
 * choice.
 */
const resolveScalars = (fields, survivor, loser, fieldChoices = {}, fieldOverrides = {}) => {
  const values = {};
  const conflicts = [];
  const autoResolved = [];
  for (const field of fields) {
    const sv = survivor[field];
    const lv = loser[field];
    // Explicit override wins outright. Use Object.prototype.hasOwnProperty so
    // an empty-string override (user cleared the AI-merged value to mean
    // "blank this field") is honored instead of falling through to the
    // survivor/loser picker.
    if (Object.prototype.hasOwnProperty.call(fieldOverrides, field)) {
      values[field] = fieldOverrides[field];
      continue;
    }
    const sEmpty = isEmptyScalar(sv);
    const lEmpty = isEmptyScalar(lv);
    if (sEmpty && lEmpty) { values[field] = sv ?? lv ?? ''; continue; }
    if (sEmpty !== lEmpty) {
      values[field] = sEmpty ? lv : sv;
      if (sEmpty) autoResolved.push({ field, from: 'loser' });
      continue;
    }
    // Both non-empty. Compare with canonicalStringify (sorted-key) so an
    // object-valued scalar like `series.arc` doesn't surface a false conflict
    // when both sides are semantically identical but key-ordered differently.
    if (canonicalStringify(sv) === canonicalStringify(lv)) { values[field] = sv; continue; }
    const choice = fieldChoices[field];
    if (choice === 'loser') values[field] = lv;
    else if (choice === 'survivor') values[field] = sv;
    else { conflicts.push({ field, survivorValue: sv, loserValue: lv }); values[field] = sv; }
  }
  return { values, conflicts, autoResolved };
};

const UNIVERSE_SCALARS = ['name', 'starterPrompt', 'logline', 'premise', 'styleNotes'];
const SERIES_SCALARS = [
  'name', 'logline', 'premise', 'styleNotes', 'titleLogo', 'author',
  'stylePromptOverride', 'stylePromptOverrideMode', 'targetFormat', 'issueCountTarget', 'arc',
  // Preserve a Writers Room promotion link: if only the loser is linked it must
  // be carried to the survivor (else the link is lost when the loser is
  // tombstoned); if both are linked differently it's surfaced as a conflict.
  'writersRoomWorkId',
];

// ---- union summary (preview only) ----
//
// List-shaped fields are unioned (no data loss) rather than surfaced as
// survivor/loser conflicts — but that combine is otherwise invisible in the
// merge modal. These helpers build a per-field summary the preview renders so
// the user can SEE what's being folded together. `survivor` = entries kept
// from the survivor, `added` = entries the folded copy contributed beyond
// those (after dedupe), so `survivor + added === merged` always holds.
const listLen = (a) => (Array.isArray(a) ? a.length : 0);
// Categories are a keyed map of buckets; count the variations across all
// buckets (the actual unioned leaf entries), not the bucket keys.
const categoryVariationCount = (cats) =>
  Object.values(cats && typeof cats === 'object' ? cats : {})
    .reduce((n, b) => n + listLen(b?.variations), 0);

const summaryRow = (field, survivorCount, mergedCount) => ({
  field,
  survivor: survivorCount,
  merged: mergedCount,
  added: Math.max(0, mergedCount - survivorCount),
});
const listRow = (field, survivorList, mergedList) => summaryRow(field, listLen(survivorList), listLen(mergedList));

// `record` is the already-unioned result, so the loser's net contribution is
// derived as `merged - survivor` (post-dedupe) rather than from the raw loser —
// that's why these take only (survivor, record).
/** Per-list-field combine summary for a universe merge preview. */
export const summarizeUniverseUnion = (survivor, record) => [
  listRow('Style prompt (embrace)', survivor.influences?.embrace, record.influences?.embrace),
  listRow('Negative prompt (avoid)', survivor.influences?.avoid, record.influences?.avoid),
  summaryRow('Categories', categoryVariationCount(survivor.categories), categoryVariationCount(record.categories)),
  listRow('Composite sheets', survivor.compositeSheets, record.compositeSheets),
  listRow('Characters', survivor.characters, record.characters),
  listRow('Places', survivor.places, record.places),
  listRow('Objects', survivor.objects, record.objects),
].filter((r) => r.merged > 0);

/** Per-list-field combine summary for a series merge preview. */
export const summarizeSeriesUnion = (survivor, record) =>
  [listRow('Seasons', survivor.seasons, record.seasons)].filter((r) => r.merged > 0);

/** Build the unioned universe patch + conflict report from survivor + loser. */
export const buildUniverseUnion = (survivor, loser, fieldChoices = {}, fieldOverrides = {}) => {
  const { values, conflicts, autoResolved } = resolveScalars(UNIVERSE_SCALARS, survivor, loser, fieldChoices, fieldOverrides);
  const record = {
    ...values,
    categories: unionCategories(survivor.categories, loser.categories),
    compositeSheets: unionEntryList(survivor.compositeSheets, loser.compositeSheets, COMPOSITE_SHEETS_MAX),
    influences: unionInfluences(survivor.influences, loser.influences),
    characters: mergeExtractedBible(survivor.characters, loser.characters, BIBLE_KIND.CHARACTER),
    places: mergeExtractedBible(survivor.places, loser.places, BIBLE_KIND.PLACE),
    objects: mergeExtractedBible(survivor.objects, loser.objects, BIBLE_KIND.OBJECT),
  };
  return { record, conflicts, autoResolved, unionSummary: summarizeUniverseUnion(survivor, record) };
};

/** Build the unioned series patch + conflict report from survivor + loser. */
export const buildSeriesUnion = (survivor, loser, fieldChoices = {}, fieldOverrides = {}) => {
  const { values, conflicts, autoResolved } = resolveScalars(SERIES_SCALARS, survivor, loser, fieldChoices, fieldOverrides);
  const record = {
    ...values,
    seasons: unionSeasons(survivor.seasons, loser.seasons),
  };
  return { record, conflicts, autoResolved, unionSummary: summarizeSeriesUnion(survivor, record) };
};

const requireResolved = (conflicts) => {
  if (conflicts.length > 0) {
    throw makeErr(
      `Unresolved conflicting field(s): ${conflicts.map((c) => c.field).join(', ')}`,
      ERR_VALIDATION,
    );
  }
};

// ---- universe merge ----

/**
 * Merge two duplicate universes. `dryRun` returns a preview without writing.
 * On execute: writes the unioned survivor, re-points the loser's child series
 * + media collection, then tombstones the loser.
 */
export async function mergeUniverses(survivorId, loserId, fieldChoices = {}, { dryRun = false, fieldOverrides = {} } = {}) {
  if (!survivorId || !loserId || survivorId === loserId) {
    throw makeErr('survivorId and loserId must be distinct', ERR_VALIDATION);
  }
  const survivor = await getUniverse(survivorId);
  const loser = await getUniverse(loserId);

  const { record, conflicts, autoResolved, unionSummary } = buildUniverseUnion(survivor, loser, fieldChoices, fieldOverrides);

  // Cascade preview: which series re-point, how many collection items fold.
  const childSeries = (await listSeries()).filter((s) => s.universeId === loserId);
  const loserCollection = await findCollectionByUniverseId(loserId);
  const cascade = {
    seriesToRepoint: childSeries.map((s) => ({ id: s.id, name: s.name })),
    loserCollectionItemCount: loserCollection ? (loserCollection.items || []).length : 0,
  };

  if (dryRun) {
    return { survivorId, loserId, preview: { ...survivor, ...record }, conflicts, autoResolved, unionSummary, cascade };
  }
  requireResolved(conflicts);

  // 1. Write the unioned survivor (mutator form bypasses the literal-patch
  //    imageRef / reference-sheet preservation guards — our union already has
  //    the merged refs and must win verbatim).
  await updateUniverse(survivorId, () => record);

  // 2. Re-point child series to the survivor BEFORE tombstoning the loser, so
  //    the block-until-empty delete guard doesn't trip and nothing is orphaned.
  for (const s of childSeries) {
    await updateSeries(s.id, { universeId: survivorId });
  }

  // 3. Fold the loser's auto-collection into the survivor's. The deterministic
  //    id `uc-<survivorId>` is already taken, so items are folded (not renamed)
  //    then the loser's now-empty bucket is tombstoned.
  if (loserCollection && (loserCollection.items || []).length > 0) {
    const survivorCollection = await findOrCreateUniverseCollection({ universeId: survivorId, universeName: record.name || survivor.name });
    await bulkUpdateCollectionItems(survivorCollection.id, {
      add: loserCollection.items.map((it) => ({ kind: it.kind, ref: it.ref })),
    });
  }
  if (loserCollection) {
    await deleteCollection(loserCollection.id).catch((err) => {
      console.error(`❌ mergeUniverses: deleting loser collection ${loserCollection.id} failed: ${err?.message || err}`);
    });
  }

  // 4. Tombstone the loser (children re-pointed → guard passes).
  await deleteUniverse(loserId);

  console.log(`🧬 mergeUniverses: folded ${loserId} into ${survivorId} (${cascade.seriesToRepoint.length} series re-pointed, ${cascade.loserCollectionItemCount} collection items)`);
  return { survivorId, loserId, merged: true, cascade };
}

// ---- series merge ----

/**
 * Merge two duplicate series (must be in the same universe — the caller scopes
 * candidates that way). `dryRun` returns a preview without writing. On execute:
 * writes the unioned survivor, re-points the loser's issues + media collection,
 * then tombstones the loser.
 */
export async function mergeSeries(survivorId, loserId, fieldChoices = {}, { dryRun = false, fieldOverrides = {} } = {}) {
  if (!survivorId || !loserId || survivorId === loserId) {
    throw makeErr('survivorId and loserId must be distinct', ERR_VALIDATION);
  }
  const survivor = await getSeries(survivorId);
  const loser = await getSeries(loserId);
  const survivorUniverseId = survivor.universeId || null;
  const loserUniverseId = loser.universeId || null;
  if (!survivorUniverseId || !loserUniverseId) {
    // Orphan series are surfaced separately as "never merged"; merging two
    // unrelated orphans (both universeId null) would fold issues/collections
    // across unrelated works. Require linking into a universe first.
    throw makeErr('Orphan series (no universe) cannot be merged — link them into a universe first', ERR_VALIDATION);
  }
  if (survivorUniverseId !== loserUniverseId) {
    throw makeErr('Series can only be merged within the same universe', ERR_VALIDATION);
  }

  const { record, conflicts, autoResolved, unionSummary } = buildSeriesUnion(survivor, loser, fieldChoices, fieldOverrides);

  const loserCollection = await findCollectionBySeriesId(loserId);
  // Issues are reassigned to the survivor, keeping their season grouping where
  // the loser's season maps to a survivor season of the same number; count for
  // the preview.
  const loserIssues = await listIssues({ seriesId: loserId });
  const cascade = {
    issuesToRepoint: loserIssues.length,
    loserCollectionItemCount: loserCollection ? (loserCollection.items || []).length : 0,
  };

  if (dryRun) {
    return { survivorId, loserId, preview: { ...survivor, ...record }, conflicts, autoResolved, unionSummary, cascade };
  }
  requireResolved(conflicts);

  // 1. Write the unioned survivor. Capture the PERSISTED record — `updateSeries`
  //    runs `sanitizeSeasonList` (which caps at SEASONS_PER_SERIES_MAX), so the
  //    saved seasons can differ from the in-memory union; the season map below
  //    must pair against what actually landed on disk.
  const persistedSurvivor = await updateSeries(survivorId, record);

  // 2. Re-point the loser's issues to the survivor before tombstone, preserving
  //    season grouping. The persisted survivor carries a season for every loser
  //    season number that survived the union (a number collision gap-fills the
  //    survivor's same-number season; a non-colliding loser season is appended
  //    verbatim), so pair each loser season to the survivor season sharing its
  //    number. An issue whose loser season has no number, or maps to a season
  //    that didn't persist (e.g. dropped at the season cap), lands un-grouped —
  //    the map only ever holds ids that exist on the saved survivor.
  if (loserIssues.length > 0) {
    const survivorSeasonIdByNumber = new Map(
      (persistedSurvivor.seasons || [])
        .filter((s) => Number.isFinite(s?.number) && isStr(s?.id))
        .map((s) => [s.number, s.id]),
    );
    const seasonIdMap = {};
    for (const ls of loser.seasons || []) {
      if (!isStr(ls?.id) || !Number.isFinite(ls?.number)) continue;
      const survivorSeasonId = survivorSeasonIdByNumber.get(ls.number);
      if (survivorSeasonId) seasonIdMap[ls.id] = survivorSeasonId;
    }
    await reassignIssuesToSeries(loserId, survivorId, { seasonIdMap });
  }

  // 3. Fold the loser's series-collection into the survivor's, then tombstone it.
  if (loserCollection && (loserCollection.items || []).length > 0) {
    const survivorCollection = await findOrCreateSeriesCollection({ seriesId: survivorId, seriesName: record.name || survivor.name });
    await bulkUpdateCollectionItems(survivorCollection.id, {
      add: loserCollection.items.map((it) => ({ kind: it.kind, ref: it.ref })),
    });
  }
  if (loserCollection) {
    await deleteCollection(loserCollection.id).catch((err) => {
      console.error(`❌ mergeSeries: deleting loser collection ${loserCollection.id} failed: ${err?.message || err}`);
    });
  }

  // 4. Tombstone the loser.
  await deleteSeries(loserId);

  console.log(`🧬 mergeSeries: folded ${loserId} into ${survivorId} (${cascade.issuesToRepoint} issues re-pointed, ${cascade.loserCollectionItemCount} collection items)`);
  return { survivorId, loserId, merged: true, cascade };
}
