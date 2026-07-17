/**
 * Universe Builder — CRUD + runs + render-history mutation helpers.
 *
 * Owns the storage-facing lifecycle: read/list/get, create/insert/update/
 * delete, run recording, and the per-entry `imageRefs` append/lock helpers.
 * All writes go through the synchronous store facade (`store()`), which owns
 * the per-id write queue and applies `sanitizeTemplate` on read. Split out of
 * the former monolithic `universeBuilder.js` (#2529); the barrel at
 * `../universeBuilder.js` re-exports this module so existing import paths keep
 * working.
 */

import { randomUUID } from 'crypto';
import { PATHS, ensureDir, resolveImageRef } from '../../lib/fileUtils.js';
import {
  pruneStaleReferenceSheets, mergePreservedSheetPointers, isStr, trimTo,
} from '../../lib/storyBible.js';
import { store } from './storeFacade.js';
import {
  sanitizeTemplate, sanitizeRun, sanitizeImageRefFilename,
  makeErr, UNIVERSE_ID_RE,
  ERR_NOT_FOUND, ERR_VALIDATION, ERR_DUPLICATE, ERR_HAS_LIVE_SERIES,
  NAME_MAX_LENGTH, CURRENT_SCHEMA_VERSION, ENTRY_REF_KIND, IMAGE_REFS_PER_ENTRY_MAX,
} from './sanitize.js';
import {
  emitRecordUpdated, emitRecordDeleted,
  autoSubscribeRecordToAllPeers, unsubscribeAllForRecord,
} from '../sharing/recordEvents.js';
import { renameCollectionForUniverse, unlinkCollectionsForUniverse } from '../mediaCollections.js';
import {
  clearPendingSheetSlot, clearPendingSheetSlotsForUniverse,
} from '../universeCharacterSheetSlot.js';
// Hierarchy guard: a universe can't be deleted while live series reference it.
// series.js does NOT import universeBuilder (one-directional), so this static
// import is cycle-safe — unlike canonUsage.js, which back-imports this module.
import { listSeries } from '../pipeline/series.js';

// Once-per-process flag for the canon-backfill log — readState() runs in both
// the queue and from un-queued readers, and the in-memory migration is cheap
// to recompute every read, but the log line should fire once.
let canonBackfillLogged = false;

async function readState() {
  await ensureDir(PATHS.data);
  const s = store();
  // Load raw records (no sanitizer) so we can detect schema-version drift
  // before the in-memory sanitization step. listRaw() is one bulk read (a
  // single SELECT on PG; parallel file reads on the escape hatch) — we
  // deliberately sanitize HERE rather than via a loadAll() that would lose the
  // pre-sanitized schemaVersion needed for the backfill log.
  const rawRecords = await s.listRaw();
  const rawById = new Map();
  for (const r of rawRecords) {
    if (r && typeof r.id === 'string') rawById.set(r.id, r);
  }
  const universes = rawRecords.map((r) => sanitizeTemplate(r)).filter(Boolean);
  const runs = (await s.loadRuns()).map(sanitizeRun).filter(Boolean);
  // The in-memory result is always at CURRENT_SCHEMA_VERSION (sanitizeTemplate
  // re-stamps it on every read). Don't persist the migration here — that
  // write would race against any concurrent per-record mutator and could
  // overwrite a freshly-patched record with the pre-patch migration baseline.
  // The next per-record write persists the migrated shape naturally.
  if (!canonBackfillLogged) {
    const migrated = universes.filter((u) => (rawById.get(u.id)?.schemaVersion || 0) < CURRENT_SCHEMA_VERSION);
    if (migrated.length > 0) {
      console.log(`🌍 Universe Builder canon backfill — migrated ${migrated.length} universe(s) in-memory to schemaVersion=${CURRENT_SCHEMA_VERSION}; persists on next write`);
      canonBackfillLogged = true;
    }
  }
  return { universes, runs };
}

export async function listUniverses({ includeDeleted = false } = {}) {
  const { universes } = await readState();
  const filtered = includeDeleted ? universes : universes.filter((u) => !u.deleted);
  // Newest first — matches user expectation for a "your universes" list.
  return [...filtered].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getUniverse(id, { includeDeleted = false } = {}) {
  // Direct per-record load — no full collection scan needed for a by-id read.
  // The store's sanitizer (sanitizeTemplate) runs on the loaded record, so the
  // returned object is shape-equivalent to what listUniverses would surface.
  const w = await store().loadOne(id);
  if (!w) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
  if (w.deleted && !includeDeleted) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
  return w;
}

// Returns true when the raw on-disk universe carries variations or composite
// sheets that are missing a stable `id` field — i.e. sanitizeTemplate would
// mint fresh UUIDs (and those UUIDs would differ on every read until the
// migration is persisted). The render route uses this to gate a one-time
// no-op write before queueing jobs whose `entryRef.id` must match the on-disk
// record at completion time. Reads raw JSON without sanitizing, so callers
// can skip the write entirely when the universe is already fully migrated —
// avoiding unwanted `updatedAt` bumps that would otherwise interfere with
// LWW sync and trigger spurious re-export/notification emits.
export async function needsEntryIdPersist(id) {
  // Raw read (no sanitizer) so we inspect the on-disk shape, not the
  // freshly-minted ids the sanitizer would stamp in-memory.
  const rec = await store().loadOneRaw(id);
  if (!rec || rec.deleted) return false;
  const cats = rec.categories && typeof rec.categories === 'object' ? rec.categories : {};
  for (const cat of Object.values(cats)) {
    const vars = Array.isArray(cat?.variations) ? cat.variations : [];
    for (const v of vars) {
      if (!isStr(v?.id) || !v.id.trim()) return true;
    }
  }
  const sheets = Array.isArray(rec.compositeSheets) ? rec.compositeSheets : [];
  for (const s of sheets) {
    if (!isStr(s?.id) || !s.id.trim()) return true;
  }
  return false;
}

export async function createUniverse(input = {}) {
  const name = trimTo(input.name, NAME_MAX_LENGTH);
  if (!name) throw makeErr(`Universe name is required (1..${NAME_MAX_LENGTH} chars)`, ERR_VALIDATION);
  const id = randomUUID();
  const created = await store().queueRecordWrite(id, async () => {
    const now = new Date().toISOString();
    const next = sanitizeTemplate({
      id,
      name,
      starterPrompt: input.starterPrompt || '',
      stylePrompt: input.stylePrompt || '',
      negativePrompt: input.negativePrompt || '',
      logline: input.logline || '',
      premise: input.premise || '',
      styleNotes: input.styleNotes || '',
      categories: input.categories || {},
      compositeSheets: input.compositeSheets || [],
      influences: input.influences || {},
      styleImageRefs: input.styleImageRefs || [],
      locked: input.locked || {},
      // Canon registries — let callers seed a universe at creation time
      // (writers-room promote, share-bucket import). sanitizeTemplate runs
      // each through sanitizeBibleList, so per-entry shape is enforced.
      characters: input.characters || [],
      places: input.places || [],
      objects: input.objects || [],
      // Stamp the current schema so backfillCanonFromCategories takes its
      // hot-path skip on first read. Without this, the legacy categories→
      // canon backfill fires on every brand-new universe and re-pollutes
      // `characters/places/objects` with every category variation —
      // counter to Phase B's separation of canon (named entities) from
      // categories (exploratory variations). New universes are always at
      // CURRENT_SCHEMA_VERSION; the backfill exists only for legacy reads.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      llm: input.llm || {},
      createdAt: now,
      updatedAt: now,
      // Optional local-only marker — when true, every sync transport
      // (snapshot loop + per-record push) skips this universe (see
      // sanitizeRecordForWire) and the auto-subscribe below short-circuits.
      ephemeral: input.ephemeral === true,
      // Importer-orphan marker (issue #727) — see sanitizeTemplate.
      importDraft: input.importDraft === true,
    });
    // Persist through the facade (backend-agnostic). We're inside the per-id
    // queue, and writeRecord does NOT re-queue, so this can't deadlock.
    await store().writeRecord(next.id, next);
    return next;
  });
  // Fire-and-forget auto-subscribe to every peer with universe-sync enabled,
  // via the recordEvents subscription adapter (peerSync registers the real
  // implementation at boot — importing peerSync from here would close a cycle).
  // Skip the auto-subscribe entirely for ephemeral universes — the push
  // would short-circuit anyway via sanitizeRecordForWire returning null, but
  // not creating the subscription in the first place keeps peer_subscriptions.json
  // free of orphan rows tied to records the user explicitly excluded.
  if (!created.ephemeral) {
    autoSubscribeRecordToAllPeers('universe', created.id).catch((err) => {
      console.log(`⚠️ universe: auto-subscribe after create failed: ${err.message}`);
    });
  }
  return created;
}

/**
 * Insert a universe with a caller-supplied id (used by the share-bucket
 * importer so re-imports of the same universe LWW-merge onto the same local
 * row). Throws ERR_DUPLICATE / ERR_VALIDATION on contract violations.
 */
export async function insertUniverseWithId(input = {}) {
  if (!isStr(input.id) || !UNIVERSE_ID_RE.test(input.id)) {
    throw makeErr(`insertUniverseWithId: invalid id "${input.id}"`, ERR_VALIDATION);
  }
  const name = trimTo(input.name, NAME_MAX_LENGTH);
  if (!name) throw makeErr(`Universe name is required (1..${NAME_MAX_LENGTH} chars)`, ERR_VALIDATION);
  const s = store();
  const { next, wasResurrection } = await s.queueRecordWrite(input.id, async () => {
    // Tombstone-overwrite: a previously-deleted record with the same id is
    // overwritten (effectively undeleted) — this keeps the share-bucket
    // re-import flow idempotent (deleting then re-importing the same manifest
    // restores the universe rather than 409ing). The peer-sync resurrection
    // hazard is already prevented by `mergeUniversesFromSync`'s LWW check,
    // which is the transport the federation uses.
    const existing = await s.loadOne(input.id);
    if (existing && !existing.deleted) {
      throw makeErr(`Universe id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const wasResurrection = !!existing;
    const next = sanitizeTemplate({ ...input, name });
    if (!next) throw makeErr('Invalid universe payload', ERR_VALIDATION);
    if (wasResurrection) {
      console.warn(`♻️  insertUniverseWithId: overwriting tombstone for ${input.id}`);
    }
    await s.writeRecord(next.id, next);
    return { next, wasResurrection };
  });
  // Mirror createUniverse's federation side-effects on tombstone-overwrite:
  // peers that still have the deleted record need the resurrection propagated.
  if (wasResurrection && !next.ephemeral) {
    emitRecordUpdated('universe', next.id);
    autoSubscribeRecordToAllPeers('universe', next.id).catch((err) => {
      console.log(`⚠️ universe: auto-subscribe after resurrection failed: ${err.message}`);
    });
  }
  return next;
}

// Canon array keys carrying bible entries that project to catalog rows.
const CANON_ARRAY_KEYS = ['characters', 'places', 'objects'];

// Compare two canon entries for CONTENT equality, ignoring `updatedAt` (the
// field we're deciding whether to bump). A cheap stable-stringify is enough —
// entries are small plain objects and a false "changed" only costs a redundant
// projection write, never correctness.
function canonEntryContentEqual(a, b) {
  const strip = (e) => { const { updatedAt: _x, ...rest } = e || {}; return rest; };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

// Stamp `updatedAt = now` on every canon entry in `next` whose content differs
// from its same-id entry in `prev` (or that is new). Mutates `next`'s arrays in
// place. So the embedded entry's LWW clock truthfully reflects a real edit —
// the bible sanitizer otherwise preserves the prior timestamp and the
// canon→catalog projection would skip a genuine change. Untouched entries keep
// their old timestamp so this never manufactures projection churn.
function stampChangedCanonEntries(prev, next) {
  const nowMs = Date.now();
  for (const key of CANON_ARRAY_KEYS) {
    const nextList = Array.isArray(next[key]) ? next[key] : null;
    if (!nextList) continue;
    const prevById = new Map(
      (Array.isArray(prev?.[key]) ? prev[key] : []).map((e) => [e?.id, e]),
    );
    next[key] = nextList.map((entry) => {
      if (!entry?.id) return entry;
      const before = prevById.get(entry.id);
      if (before && canonEntryContentEqual(before, entry)) return entry;
      // Monotonic bump: a content change MUST advance the LWW clock past the
      // entry's prior `updatedAt`, even when the edit lands in the same
      // millisecond as the create/last-edit (Date.now() granularity). Without
      // this, a same-ms edit stamps an equal timestamp, and the canon→catalog
      // projection's `>`-based LWW merge would not treat the change as newer.
      const beforeMs = before?.updatedAt ? Date.parse(before.updatedAt) : NaN;
      const stampMs = Number.isNaN(beforeMs) ? nowMs : Math.max(nowMs, beforeMs + 1);
      return { ...entry, updatedAt: new Date(stampMs).toISOString() };
    });
  }
}

export async function updateUniverse(id, patchOrMutator = {}, options = {}) {
  // The queued section covers only the universe-builder read/modify/write
  // cycle. The cross-file media-collection rename runs *after* the queue
  // releases so a slow/stuck collection write can't block unrelated universe
  // mutators (the universe row is already persisted by then).
  //
  // `patchOrMutator` overloads:
  //   - Plain object: patch is applied directly inside the queue (legacy).
  //   - `async (latest) => patch | null`: mutator runs INSIDE the queue with
  //     the freshest persisted record so callers whose read-modify-write
  //     straddles a slow LLM call can't race a concurrent edit. Returning
  //     `null`/`undefined` short-circuits the write and resolves with the
  //     unchanged record (no `updatedAt` bump, no rename cascade, no
  //     `recordUpdated` emit).
  //
  // `options.silent: true` suppresses the post-write `emitRecordUpdated`
  // peer-sync fan-out — used by the bible→catalog backfill which would
  // otherwise emit one event per universe at boot on every install. The
  // universe is still persisted; peers learn about the change on the next
  // normal sync cycle.
  const isMutator = typeof patchOrMutator === 'function';
  // `canonProjectionGuard` is set (to an ingredientId) when this write
  // ORIGINATED from a catalog→canon projection. Threaded into projectToCatalog
  // below so the originating catalog row isn't written back a second time
  // (breaks the projectToCanon → updateUniverse → projectToCatalog loop).
  // `options.replaceCategories: true` replaces the whole `categories` map with
  // the patch's instead of unioning it per-key. Used by the conflict-journal
  // "restore mine" path so a faithful restore of the archived snapshot drops a
  // category the live record gained since the conflict, rather than resurrecting
  // it under the normal additive-PATCH semantics (see `mergedCategories` below).
  const { silent = false, canonProjectionGuard = null, replaceCategories = false } = options;
  const s = store();
  const { merged, nameChanged, skipped, removedCharacterIds, prevEphemeral, nextEphemeral } = await s.queueRecordWrite(id, async () => {
    const cur = await s.loadOne(id);
    if (!cur) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);

    let patch;
    if (isMutator) {
      patch = await patchOrMutator(cur);
      if (patch === null || patch === undefined) {
        return { merged: cur, nameChanged: false, skipped: true };
      }
      // `typeof === 'object'` matches arrays and null — reject both so a stray
      // `return []` can't slip through and silently no-op the categories merge.
      if (Array.isArray(patch) || typeof patch !== 'object') {
        throw makeErr('updateUniverse mutator must return a plain object or null', ERR_VALIDATION);
      }
    } else {
      patch = patchOrMutator;
    }

    // Merge `categories` per-key — a partial PATCH that only includes
    // `landscapes` must NOT wipe characters/structures/etc. Whole categories
    // not present in the patch are kept as-is from the current universe.
    // EXCEPT under `replaceCategories` (conflict-journal restore), where the
    // patch's categories map replaces the current one wholesale so a faithful
    // restore can drop a category the live record gained since the conflict.
    const mergedCategories = 'categories' in patch
      ? (replaceCategories ? (patch.categories || {}) : { ...cur.categories, ...(patch.categories || {}) })
      : cur.categories;

    // Merge `llm` field-by-field — sending only `{ provider }` shouldn't
    // clear `model` and vice versa.
    const mergedLlm = 'llm' in patch
      ? { ...(cur.llm || {}), ...(patch.llm || {}) }
      : cur.llm;

    // `locked` replaces wholesale when the patch sends it (so unticking a lock
    // actually unlocks). Skipped when the patch omits it.
    const mergedLocked = 'locked' in patch ? (patch.locked || {}) : (cur.locked || {});

    // `influences` also replaces wholesale (each list is the user's full
    // intended state — partial merging would leave stale entries the user
    // thought they removed).
    const mergedInfluences = 'influences' in patch ? (patch.influences || {}) : (cur.influences || {});

    // Scalar fields: only apply what the patch actually carries, so a partial
    // PATCH never clobbers a field the caller didn't send. `categories` + `llm`
    // + `locked` are handled above (they need per-key merging or wholesale
    // replacement, not the simple scalar copy).
    const PATCHABLE_SCALARS = [
      'name', 'starterPrompt',
      'logline', 'premise', 'styleNotes', 'compositeSheets',
      // Base style-probe render refs — patched wholesale (sanitizer re-caps).
      'styleImageRefs',
      // Canon entity arrays — patched wholesale (the sanitizer reruns
      // sanitizeBibleList so per-entry shape is enforced on every save).
      'characters', 'places', 'objects',
      // Share-bucket origin metadata (importer sets it; user clears via wholesale null).
      'origin',
      // Local-only "don't sync" marker — see sanitizeTemplate. The safety
      // property is one-directional: ONLY a literal `true` marks the record
      // ephemeral; every other value (`false`, `'true'`, `1`, etc.) is
      // dropped at the sanitizer back to absent — i.e. sync-enabled. A
      // mutator PATCH like `{ ephemeral: 'false' }` therefore CLEARS the
      // flag (re-enabling sync), it does NOT mark the record ephemeral.
      // The asymmetry is intentional: protecting "private by default" is
      // not the goal — protecting "you can't accidentally truthy your way
      // into ephemeral and never sync again" is.
      'ephemeral',
      // Importer-orphan marker (issue #727). commitImport clears it on
      // promotion via `{ importDraft: false }`; the sanitizer drops every
      // non-`true` value back to absent, mirroring `ephemeral`.
      'importDraft',
    ];
    const scalarPatch = Object.fromEntries(
      PATCHABLE_SCALARS.filter((k) => k in patch).map((k) => [k, patch[k]]),
    );
    // Server-owned operational fields on characters (see
    // SERVER_OWNED_CHARACTER_FIELDS in storyBible.js) are written only by
    // server-side render-completion mutators. A literal-object PATCH that
    // round-trips a character body the client loaded before a newer
    // render finished would otherwise clobber the freshly-stamped
    // pointer (multi-tab / parallel render race). Preserve cur's value
    // per-(id, field); new characters in the patch start fresh.
    //
    // ONLY applies to literal-object patches. The mutator path is the
    // trusted writer here — `onSheetComplete` reads `cur` itself and
    // intentionally constructs a patch with the newly stamped value, so
    // running preservation against its output would clobber the stamp
    // back to the OLD/null value and the sheet would never persist. The
    // sharing importer wraps `updateUniverse(id, () => record)` for the
    // same reason — sync's intent is LWW including operational pointers,
    // so it opts into the mutator-bypass.
    if (!isMutator
      && Array.isArray(scalarPatch.characters)
      && Array.isArray(cur.characters)) {
      const curById = new Map(cur.characters.filter((c) => c?.id).map((c) => [c.id, c]));
      // Preserve cur's server-stamped sheet pointers ONLY when they still
      // resolve on disk. Without the FS check, this guard reintroduces
      // stale pointers that the GET route's lazy `pruneStaleReferenceSheets`
      // already nulled out: GET → null (file gone) → client PATCH carries
      // null → guard overwrites null with cur's stale filename → thumbnail
      // 404s again. The map variant (`referenceSheets`) merges per-key so a
      // freshly-stamped blueprint can't be clobbered by a patch that omits
      // the field while a separately-rendered standard sheet survives.
      const checkExists = (name) => !!resolveImageRef(name, { mustExist: true });
      scalarPatch.characters = scalarPatch.characters.map((c) => {
        const prev = c?.id ? curById.get(c.id) : null;
        if (!prev) return c;
        return mergePreservedSheetPointers(prev, c, checkExists);
      });
    }

    // Server-stamped render history on variations + composite sheets. The
    // collection hook is the sole writer (via the mutator-form of
    // updateUniverse, which bypasses this guard). A literal-object PATCH that
    // round-trips the variation body the client loaded before a render
    // completed would otherwise clobber the freshly-appended filename. Match
    // by `id` and preserve cur's `imageRefs` when it has more entries than
    // the patch OR when their tails differ (the at-cap rotation case, where
    // an append drops the oldest and lengths stay equal). Same-length +
    // same-tail means the client is current and the patch survives — note
    // that as a corollary, an empty patched list against a non-empty cur is
    // treated as stale and cur's history is preserved (the current UI has
    // no explicit-clear control, so this is the safer default).
    if (!isMutator && 'categories' in patch && patch.categories && typeof patch.categories === 'object') {
      for (const [catKey, catVal] of Object.entries(mergedCategories)) {
        if (!catVal || !Array.isArray(catVal.variations)) continue;
        const curCat = cur.categories?.[catKey];
        if (!curCat || !Array.isArray(curCat.variations)) continue;
        // Only run preservation against categories the patch actually sent —
        // categories preserved verbatim from cur already have the right imageRefs.
        if (!(catKey in patch.categories)) continue;
        mergedCategories[catKey] = {
          ...catVal,
          variations: preserveImageRefsById(catVal.variations, curCat.variations),
        };
      }
    }
    if (!isMutator && Array.isArray(scalarPatch.compositeSheets) && Array.isArray(cur.compositeSheets)) {
      scalarPatch.compositeSheets = preserveImageRefsById(scalarPatch.compositeSheets, cur.compositeSheets);
    }

    // Server-stamped render history on canon entries (characters / places /
    // objects). Like the variations + composite-sheet guards above, the
    // collection hook appends to these `imageRefs[]` via the mutator form of
    // updateUniverse (which bypasses this guard). A literal whole-array PATCH
    // that round-trips a canon list the client loaded before a section-local
    // or batch render completed (#1395) would otherwise clobber the freshly-
    // appended filename. Preserve cur's imageRefs per-id when the patch is
    // stale. (The characters array was already remapped above for sheet
    // pointers — this preserves a different field and composes cleanly.)
    if (!isMutator) {
      for (const canonKey of ['characters', 'places', 'objects']) {
        if (Array.isArray(scalarPatch[canonKey]) && Array.isArray(cur[canonKey])) {
          scalarPatch[canonKey] = preserveImageRefsById(scalarPatch[canonKey], cur[canonKey]);
        }
      }
    }

    const mergedRecord = sanitizeTemplate({
      ...cur,
      ...scalarPatch,
      // sanitizeTemplate runs the v2 → v3 prose-prompt merge — see its
      // `mergeLegacyPromptsIntoInfluences` call.
      ...(patch.stylePrompt !== undefined ? { stylePrompt: patch.stylePrompt } : {}),
      ...(patch.negativePrompt !== undefined ? { negativePrompt: patch.negativePrompt } : {}),
      categories: mergedCategories,
      influences: mergedInfluences,
      locked: mergedLocked,
      llm: mergedLlm,
      updatedAt: new Date().toISOString(),
    });
    if (!mergedRecord) throw makeErr('Invalid universe payload', ERR_VALIDATION);
    // Stamp `updatedAt = now` on every canon entry whose CONTENT changed vs the
    // pre-write record. The bible sanitizer preserves a present `updatedAt`, so
    // an inline edit / AI rewrite that does `{ ...e, ...patch }` keeps the OLD
    // timestamp — which makes the canon→catalog projection's LWW clock lie (a
    // catalog row that's merely newer-by-clock would win and the canon edit
    // would never reach the catalog row, breaking lockstep). Bumping the clock
    // on genuine content changes makes the embedded entry's timestamp truthful
    // so projectToCatalog correctly carries the edit across. Unchanged entries
    // keep their old timestamp (no spurious revisions / no projection churn).
    stampChangedCanonEntries(cur, mergedRecord);
    // Persist the stale-reference-sheet null at write time so the on-disk
    // record catches up with what the GET-route pruner shows. Otherwise a
    // PATCH that omits `characters` (e.g. rename) merges from `cur` and
    // returns the stale filename, and the UI re-renders the broken thumbnail.
    // Render-completion writes are unaffected — the renderer copies the file
    // BEFORE its mutator runs, so the just-stamped pointer resolves on disk
    // and the prune skips it.
    if (Array.isArray(mergedRecord.characters)) {
      mergedRecord.characters = pruneStaleReferenceSheets(mergedRecord.characters);
    }
    await s.writeRecord(id, mergedRecord);
    // Project the freshly-persisted canon arrays back into their catalog rows
    // SYNCHRONOUSLY (inside the queue) so the authoritative catalog_ingredients
    // row can never lag the embedded cache on the same request. Best-effort:
    // projectToCatalog never throws (per-entry failures are logged), but wrap
    // the import/call anyway — this runs inside the queued write critical
    // section and an uncaught throw here would reject the whole save. Skipped
    // when the patch can't have touched canon arrays (rename/scalar PATCH).
    if (isMutator || 'characters' in patch || 'places' in patch || 'objects' in patch) {
      try {
        const { projectToCatalog } = await import('../catalogCanonProjection.js');
        await projectToCatalog(id, mergedRecord, { guardToken: canonProjectionGuard });
      } catch (err) {
        console.error(`🔁 canon→catalog projection failed for ${id}: ${err.message}`);
      }
    }
    // Diff inside the queue so we read against the freshest merged state;
    // gate on patches that could have touched characters (mutator or
    // literal-PATCH carrying `characters`) — rename/scalar PATCHes are the
    // common case and skip the Set construction entirely.
    let removedCharacterIds = null;
    if (isMutator || 'characters' in patch) {
      const idsOf = (arr) => (Array.isArray(arr)
        ? arr.filter((c) => c?.id).map((c) => c.id) : []);
      const prevIds = new Set(idsOf(cur.characters));
      const nextIds = new Set(idsOf(mergedRecord.characters));
      removedCharacterIds = [...prevIds].filter((id) => !nextIds.has(id));
    }
    return {
      merged: mergedRecord,
      nameChanged: mergedRecord.name !== cur.name,
      skipped: false,
      removedCharacterIds,
      // Surface the (prev, next) ephemeral pair so the post-queue side
      // effects can wire subscribe / unsubscribe for the transition.
      // Compare against `cur` (the pre-merge record) so transitions are
      // detected regardless of patch shape (literal-object or mutator).
      prevEphemeral: cur.ephemeral === true,
      nextEphemeral: mergedRecord.ephemeral === true,
    };
  });
  if (skipped) return merged;
  // Slot map is in-process; without this it persists past the logical delete.
  for (const removedId of removedCharacterIds ?? []) {
    clearPendingSheetSlot(id, removedId);
  }
  // Cascade rename onto the linked media collection — log but don't fail
  // the save: a stale collection name is recoverable, a failed save isn't.
  // Runs OUTSIDE the queue so the media-collections write tail can't stall
  // subsequent universe mutators.
  if (nameChanged) {
    await renameCollectionForUniverse(merged.id, merged.name).catch((err) => {
      console.error(`❌ universe-collection rename cascade failed for ${merged.id}: ${err?.message || err}`);
    });
  }
  // Ephemeral lifecycle wiring — fires AFTER the queued write so the on-disk
  // state already reflects the transition before any peer-sync work runs.
  // false→true: tear down every existing per-record sub for this universe
  //             (peers keep their last-pushed copy on disk; we just stop
  //             future pushes). Mirror of createUniverse's `if (!created.ephemeral)`
  //             auto-subscribe-skip — both ends of the lifecycle keep
  //             peer_subscriptions.json free of orphan rows.
  // true→false: fire autoSubscribeRecordToAllPeers so the now-shareable
  //             record reaches every peer with the universe category
  //             enabled via the responsive per-record push pipeline. (The 60s
  //             snapshot loop would also carry it now — the source only
  //             excludes records it ALREADY pushes per-record, so an
  //             un-subscribed record rides the snapshot — but the push path
  //             converges it immediately instead of waiting up to a cycle.)
  // Awaited (not fire-and-forget) — a .catch()-only call settles on a
  // microtask AFTER the synchronous emitRecordUpdated below, so the
  // peerSync 'updated' listener would schedule pushes against subs the
  // user just disabled. The await keeps the documented "BEFORE
  // emitRecordUpdated" contract honest.
  if (prevEphemeral && !nextEphemeral) {
    await autoSubscribeRecordToAllPeers('universe', merged.id).catch((err) => {
      console.log(`⚠️ universe: re-subscribe after un-ephemeralizing failed: ${err.message}`);
    });
  } else if (!prevEphemeral && nextEphemeral) {
    await unsubscribeAllForRecord('universe', merged.id).catch((err) => {
      console.log(`⚠️ universe: unsubscribe after ephemeralizing failed: ${err.message}`);
    });
  }
  if (!silent) {
    emitRecordUpdated('universe', merged.id);
  }
  return merged;
}

export async function deleteUniverse(id) {
  // Soft-delete: mark the record with `deleted: true` + `deletedAt` and bump
  // `updatedAt` so federated peers learn about the deletion via the existing
  // LWW merge (tombstone-as-state). The orchestrator's tombstone-cleanup
  // sweep prunes the record entirely once every subscribed peer has acked.
  //
  // Cross-file side effects still run on the local delete: drop runs,
  // unlink media collections, clear sheet slots. These cascades also run on
  // the receiving peer when a soft-delete arrives via mergeUniversesFromSync
  // so a synced delete doesn't leave orphan media-collection locks.
  const s = store();
  // Hierarchy invariant (block-until-empty): refuse to delete a universe that
  // still has live (non-deleted) series — the user must move or delete those
  // series first. Filter listSeries() inline rather than calling
  // canonUsage.listLinkedSeriesNames (canonUsage back-imports this module → a
  // require cycle). This runs OUTSIDE the record queue: a read-only pre-check,
  // and the queued write below re-validates existence anyway.
  const blockingSeries = (await listSeries())
    .filter((ser) => ser.universeId === id)
    .map((ser) => ({ id: ser.id, name: ser.name }));
  if (blockingSeries.length > 0) {
    throw Object.assign(
      makeErr(`Universe has ${blockingSeries.length} live series — move or delete them first`, ERR_HAS_LIVE_SERIES),
      { blockingSeries },
    );
  }
  await s.queueRecordWrite(id, async () => {
    const cur = await s.loadOne(id);
    if (!cur) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    const now = new Date().toISOString();
    const tombstone = { ...cur, deleted: true, deletedAt: now, updatedAt: now };
    await s.writeRecord(id, tombstone);
  });
  // Drop runs referencing the deleted universe — they're useless without it.
  // The facade's removeRunsForUniverses serializes the runs read→filter→write on
  // its own run-tail, so a concurrent recordRun can't lose its newly-appended
  // run to a stale filtered snapshot.
  await s.removeRunsForUniverses([id]);
  // Release the rename-lock on any linked media collections — without this,
  // the orphan collection's `universeId` stays stamped and the lock in
  // updateCollection blocks renames forever even though the universe is gone.
  // Best-effort: a failure here mustn't fail the delete (the universe is
  // already tombstoned). Runs OUTSIDE the universe-builder queue.
  await unlinkCollectionsForUniverse(id).catch((err) => {
    console.error(`❌ unlink media collections for deleted universe ${id} failed: ${err?.message || err}`);
  });
  // Slot map is in-process; persists across the logical delete without this.
  clearPendingSheetSlotsForUniverse(id);
  emitRecordDeleted('universe', id);
  return { id };
}

export async function recordRun(run) {
  const sanitized = sanitizeRun(run);
  if (!sanitized) throw makeErr('Invalid run payload', ERR_VALIDATION);
  // The facade serializes the runs append→cap on its own run-tail (and caps at
  // 200), so concurrent recordRun + delete-cascade can't clobber each other.
  await store().appendRun(sanitized);
  return sanitized;
}

export async function listRuns(universeId = null) {
  const runs = (await store().loadRuns(universeId)).map(sanitizeRun).filter(Boolean);
  return [...runs].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Append a rendered gallery filename to the imageRefs[] of the entry the job
// targeted. `entryRef` shape mirrors what `compilePrompts` stamps onto each
// job (see `universeRun.entryRef`); the mutator branches on `kind`:
//   - 'variation' → `universe.categories[categoryKey].variations[id]`
//   - 'sheet'     → `universe.compositeSheets[id]`
//   - 'canon'     → `universe[kindKey][id]` (characters/places/objects)
// Dedupes against the existing list so a re-render that produces the same
// filename doesn't bloat the history. Runs through `updateUniverse`'s mutator
// form so the read→modify→write window is serialized against concurrent edits
// on the same universe.
/**
 * Bulk-set `locked` on every variation in a category bucket. When
 * `categoryKey` is null, every variation in every bucket of the universe is
 * affected. Composite sheets are included in the universe-wide path (caller
 * intent for "lock everything" is consistent across both lists). Returns the
 * updated universe plus the count of variations whose state actually changed
 * — entries already at the target state are no-ops so the toast can read
 * "Locked N variations".
 */
export async function setVariationsLockAll(universeId, { categoryKey = null, locked, includeSheets = false } = {}) {
  const target = locked === true;
  let changed = 0;
  let total = 0;
  const updated = await updateUniverse(universeId, (cur) => {
    const patch = {};
    const categories = cur.categories || {};
    const nextCategories = {};
    let touchedCategories = false;
    for (const [key, bucket] of Object.entries(categories)) {
      const variations = Array.isArray(bucket?.variations) ? bucket.variations : [];
      if (categoryKey && key !== categoryKey) {
        nextCategories[key] = bucket;
        continue;
      }
      // Increment `total` only for buckets the caller actually targeted —
      // otherwise a single-bucket lock-all would report every variation in
      // every bucket as the denominator and the response toast lies.
      total += variations.length;
      let bucketTouched = false;
      const nextVariations = variations.map((v) => {
        if (!v || typeof v !== 'object') return v;
        if ((v.locked === true) === target) return v;
        changed += 1;
        bucketTouched = true;
        return { ...v, locked: target };
      });
      nextCategories[key] = bucketTouched ? { ...bucket, variations: nextVariations } : bucket;
      if (bucketTouched) touchedCategories = true;
    }
    if (touchedCategories) patch.categories = nextCategories;

    if (!categoryKey && includeSheets && Array.isArray(cur.compositeSheets)) {
      total += cur.compositeSheets.length;
      let sheetsTouched = false;
      const nextSheets = cur.compositeSheets.map((s) => {
        if (!s || typeof s !== 'object') return s;
        if ((s.locked === true) === target) return s;
        changed += 1;
        sheetsTouched = true;
        return { ...s, locked: target };
      });
      if (sheetsTouched) patch.compositeSheets = nextSheets;
    }

    if (!Object.keys(patch).length) return null;
    return patch;
  });
  return { universe: updated, locked: target, changed, total, categoryKey: categoryKey || null };
}

export async function appendEntryImageRef(universeId, entryRef, filename) {
  if (!isStr(universeId) || !entryRef || typeof entryRef !== 'object') return null;
  // Apply the same filename guard the sanitizer uses on round-trip so a
  // pathy or traversal-laden filename is rejected up-front rather than
  // entering the queued write and triggering a no-op `updatedAt` bump
  // when sanitizeTemplate strips it on the way out.
  const safe = sanitizeImageRefFilename(filename);
  if (!safe) return null;
  return updateUniverse(universeId, (cur) => {
    if (entryRef.kind === ENTRY_REF_KIND.VARIATION && isStr(entryRef.categoryKey) && isStr(entryRef.id)) {
      const cat = cur.categories?.[entryRef.categoryKey];
      const variations = mapAppendImageRef(cat?.variations, entryRef.id, safe);
      if (!variations) return null;
      return { categories: { [entryRef.categoryKey]: { ...cat, variations } } };
    }
    if (entryRef.kind === ENTRY_REF_KIND.SHEET && isStr(entryRef.id)) {
      const sheets = mapAppendImageRef(cur.compositeSheets, entryRef.id, safe);
      if (!sheets) return null;
      return { compositeSheets: sheets };
    }
    if (entryRef.kind === ENTRY_REF_KIND.CANON && isStr(entryRef.kindKey) && isStr(entryRef.id)) {
      const list = mapAppendImageRef(cur[entryRef.kindKey], entryRef.id, safe);
      if (!list) return null;
      return { [entryRef.kindKey]: list };
    }
    return null;
  });
}

// Preserve cur's `imageRefs` on entries the patch round-tripped from a stale
// load. Match by `id`; we consider the patch stale (and restore cur's history)
// when EITHER cur's list has more entries than the patch's OR the newest entry
// (tail) differs between cur and patch. The tail check catches the at-cap case:
// once imageRefs is at IMAGE_REFS_PER_ENTRY_MAX (12), a server-side append
// rotates the list — pushing the new filename and dropping the oldest — so
// lengths stay equal even though cur is strictly newer. Comparing tails
// detects this; a stale client PATCH (with the pre-rotation list) has a
// different last element than the freshly-appended cur. Used by both the
// variations and composite-sheets preservation paths in updateUniverse.
function preserveImageRefsById(next, prev) {
  if (!Array.isArray(next) || !Array.isArray(prev)) return next;
  const prevById = new Map(prev.filter((p) => p?.id).map((p) => [p.id, p]));
  return next.map((n) => {
    const p = n?.id ? prevById.get(n.id) : null;
    if (!p) return n;
    const prevRefs = Array.isArray(p.imageRefs) ? p.imageRefs : [];
    const nextRefs = Array.isArray(n.imageRefs) ? n.imageRefs : [];
    if (prevRefs.length === 0) return n;
    // Restore when cur has strictly more refs (patch dropped some) OR cur has
    // a different newest entry than the patch (server-side rotation at cap).
    // Equal-length + same tail means the patch is current and survives.
    const isStale =
      prevRefs.length > nextRefs.length ||
      (prevRefs.length > 0 && prevRefs[prevRefs.length - 1] !== nextRefs[nextRefs.length - 1]);
    return isStale ? { ...n, imageRefs: prevRefs } : n;
  });
}

// Append `filename` (deduped + capped to IMAGE_REFS_PER_ENTRY_MAX) to the
// imageRefs[] of the entry in `list` matched by `id`. Returns the new list,
// or `null` when the id isn't present so the caller can short-circuit.
function mapAppendImageRef(list, id, filename) {
  if (!Array.isArray(list) || !list.some((e) => e?.id === id)) return null;
  return list.map((e) => {
    if (e?.id !== id) return e;
    const refs = Array.isArray(e.imageRefs) ? e.imageRefs : [];
    if (refs.includes(filename)) return e;
    const next = [...refs, filename];
    return { ...e, imageRefs: next.length > IMAGE_REFS_PER_ENTRY_MAX ? next.slice(-IMAGE_REFS_PER_ENTRY_MAX) : next };
  });
}
