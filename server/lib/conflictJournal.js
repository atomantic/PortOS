/**
 * Non-blocking conflict journal.
 *
 * All cross-install merges are last-write-wins by `updatedAt`. When LWW would
 * OVERWRITE a local record but BOTH sides edited it independently since the
 * last time they were in sync (a true 3-way divergence), the losing local
 * version is archived here BEFORE the overwrite — so convergence is preserved
 * (peers still agree on the LWW winner, sync never wedges) AND no edit is
 * silently lost (the user can review and restore from the Sharing → Conflicts
 * tab).
 *
 * Divergence signal — per-record `syncBaseHash` (the content hash as of the
 * last time this instance and a peer demonstrably held the same content):
 *
 *     conflict := base != null
 *              && hLocal !== base    // local diverged from the common base
 *              && hRemote !== base   // remote also diverged from it
 *              && hLocal !== hRemote  // and they actually differ
 *
 * `base == null` ⇒ treat as a clean update (conservative: we only ever MISS
 * journaling the first divergence after this feature ships for a given record,
 * never wedge and never false-positive on routine sequential updates).
 *
 * The base hash advances to the remote's hash on EVERY accepted overwrite
 * (clean OR conflicting) — without that, the 60s snapshot loop would re-journal
 * the same unresolved divergence every cycle.
 *
 * This store + the base-hash side store are LOCAL-ONLY: they are never enrolled
 * in PEER_SUBSCRIBABLE_KINDS / snapshot categories / sanitizeStateForWire, so
 * they can never cross the wire (no schema-version bump needed).
 */

import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from './fileUtils.js';
import { createCollectionStore } from './collectionStore.js';
import { canonicalStringify, isPlainObject } from './objects.js';
import { sanitizeRecordForWire } from './syncWire.js';

const JOURNAL_TYPE_SCHEMA_VERSION = 1;
const BASE_HASH_FILE = () => join(PATHS.data, 'sharing', 'sync_base_hashes.json');

// ---- conflict-journal collection store ----

let _store = null;
const store = () => {
  if (_store && _store.dir === join(PATHS.data, 'conflict-journal')) return _store;
  _store = createCollectionStore({
    dir: join(PATHS.data, 'conflict-journal'),
    type: 'conflictJournal',
    schemaVersion: JOURNAL_TYPE_SCHEMA_VERSION,
  });
  return _store;
};
export const conflictJournalStore = () => store();

// ---- content hashing (matches the sender/receiver wire convention) ----

// mediaCollection divergence is detected over a SCALAR SUBSET, not the whole
// wire record. The merge (`mergeMediaCollectionsFromSync`) union-merges `items`
// — neither side ever loses a render it knows about — and bumps `updatedAt` on
// every `addItem`. So hashing the full record would false-positive whenever two
// peers independently added different items to the same collection (items +
// updatedAt differ, yet NOTHING was overwritten). The journal only cares about
// the LWW-overwritten scalars; we hash exactly those so an item-only divergence
// is invisible to detection while a real name/description/cover/link overwrite
// still trips it. `updatedAt` is the LWW *key*, not content, so it's excluded
// too. Soft-delete fields stay in (a remote delete that erases a diverged local
// edit is a real conflict — mirrors the universe/series delete-vs-edit case).
const MEDIA_COLLECTION_SCALAR_FIELDS = Object.freeze(['name', 'description', 'coverKey', 'universeId', 'seriesId']);

// Fields dropped from the conflict-detection hash, per kind. These are
// server-managed values that mutate WITHOUT a user edit (and without bumping
// `updatedAt`), so leaving them in the hash would read as a false divergence
// and journal a spurious conflict. Issue `number` is renumber-managed:
// `applyVolumeOrderedNumbers` shifts it in place when a *sibling* issue is
// added/removed, so a local sibling-delete would otherwise make this issue's
// `localHash !== base` even though no restorable content changed (the resulting
// conflict card would have an empty diffSummary, since `number` isn't
// restorable). Excluding it keeps the hash aligned with the restorable-field
// set the UI actually shows. (mediaCollection narrows via its own scalar
// projection below; universe/series exclude nothing, so their already-seeded
// base hashes stay valid across upgrade.)
// Fields dropped from the CONTENT HASH (not the wire payload — they still
// replicate). `issue.number` is renumber-managed. `track.renders` is an additive
// field synthesized (backfilled) onto every existing track on first read: hashing
// it would invalidate every pre-upgrade `sync_base_hash` and journal a one-time
// FALSE 3-way conflict on the first cross-peer edit after both peers upgrade
// (local and remote both differ from a base computed without renders). Excluding
// it from the hash keeps base-hash compatibility; render-only divergences are
// LWW-ordered by `updatedAt` regardless, and renders stays restorable (below).
const HASH_EXCLUDED_FIELDS = Object.freeze({ issue: ['number'], track: ['renders'] });

/**
 * sha256 of the canonical content projection. Reuses sanitizeRecordForWire +
 * canonicalStringify so the sender hashing what it pushes and the receiver
 * hashing its local copy agree byte-for-byte. For mediaCollection the wire form
 * is further narrowed to its overwritable scalars (see
 * MEDIA_COLLECTION_SCALAR_FIELDS); for issue the renumber-managed `number` is
 * dropped (see HASH_EXCLUDED_FIELDS) — both sides apply the same narrowing, so
 * the base hash stays consistent across peers. Returns null when the record has
 * no wire form (ephemeral non-tombstone, or invalid) — callers treat a null
 * hash as "cannot compare".
 */
export function contentHashForRecord(kind, record) {
  const wire = sanitizeRecordForWire(kind, record);
  if (!wire) return null;
  let hashInput = wire;
  if (kind === 'mediaCollection') {
    hashInput = projectCollectionScalars(wire);
  } else if (HASH_EXCLUDED_FIELDS[kind]) {
    const excluded = HASH_EXCLUDED_FIELDS[kind];
    hashInput = Object.fromEntries(Object.entries(wire).filter(([k]) => !excluded.includes(k)));
  }
  return createHash('sha256').update(canonicalStringify(hashInput)).digest('hex');
}

// Narrow a wire-form collection to the scalars whose overwrite the journal
// tracks, plus the (already-normalized) soft-delete pair. `items`/`updatedAt`/
// `id` and all other fields are dropped. canonicalStringify sorts keys, so the
// insertion order here is irrelevant to the resulting hash.
function projectCollectionScalars(wire) {
  const out = {};
  for (const f of MEDIA_COLLECTION_SCALAR_FIELDS) if (f in wire) out[f] = wire[f];
  out.deleted = wire.deleted === true;
  out.deletedAt = out.deleted ? (wire.deletedAt ?? null) : null;
  return out;
}

// ---- base-hash side store (in-memory cache, batched write-through) ----

let _baseHashes = null;       // Map<`${kind}:${id}`, sha256>
let _loadPromise = null;
let _baseDirty = false;
let _flushTail = Promise.resolve();
// >0 while a `withBaseHashFlushBatch` scope is active. Defers the disk write so
// an await-separated multi-record push loop (peer:online convergence) collapses
// N `sync_base_hashes.json` rewrites into one at the batch's terminal flush.
let _flushBatchDepth = 0;

const baseKey = (kind, id) => `${kind}:${id}`;

async function ensureBaseLoaded() {
  if (_baseHashes) return _baseHashes;
  if (!_loadPromise) {
    _loadPromise = (async () => {
      const obj = await readJSONFile(BASE_HASH_FILE(), {}, { logError: false });
      _baseHashes = new Map(obj && typeof obj === 'object' ? Object.entries(obj) : []);
      return _baseHashes;
    })();
  }
  return _loadPromise;
}

export async function getSyncBaseHash(kind, id) {
  const map = await ensureBaseLoaded();
  return map.get(baseKey(kind, id)) ?? null;
}

/** Set the base hash in memory (write-through deferred to flushBaseHashes). */
export async function setSyncBaseHash(kind, id, hash) {
  const map = await ensureBaseLoaded();
  if (!hash) return;
  if (map.get(baseKey(kind, id)) === hash) return;
  map.set(baseKey(kind, id), hash);
  _baseDirty = true;
}

/**
 * Remove the base hash for a pruned record (idempotent — no-op if already
 * absent). Call when a tombstone is force-pruned so the entry doesn't grow
 * without bound on long-lived federated installs.
 */
export async function deleteSyncBaseHash(kind, id) {
  const map = await ensureBaseLoaded();
  const key = baseKey(kind, id);
  if (!map.has(key)) return;
  map.delete(key);
  _baseDirty = true;
  await flushBaseHashes();
}

/**
 * Sweep base-hash entries whose record no longer resolves to a live record.
 *
 * The per-record prune paths (`pruneTombstonedUniverses` / `…Series` / `…Issues`
 * / `…Collections`) already evict a record's base hash when they hard-delete its
 * tombstone. This is the BACKSTOP for keys that escaped those paths: a record
 * hand-deleted on disk, a key left behind by an older version before the prune
 * paths evicted, or any future kind that seeds a base hash without a matching
 * eviction. Without it the side store accumulates dead keys forever on a
 * long-lived federated install.
 *
 * `resolves` is an async predicate `(kind, id) => boolean` — return true if the
 * key still maps to a record we want to keep a base hash for. Keys whose kind
 * the caller doesn't recognize are LEFT ALONE (the predicate should return true
 * for unknown kinds) so a partial resolver can never strip live entries it
 * simply didn't know how to check. Coalesces into one disk write via the dirty
 * flag + a single trailing flush.
 *
 * Returns `{ pruned }`.
 */
export async function pruneOrphanedBaseHashes(resolves) {
  if (typeof resolves !== 'function') return { pruned: 0 };
  const map = await ensureBaseLoaded();
  let pruned = 0;
  for (const key of [...map.keys()]) {
    const sep = key.indexOf(':');
    if (sep < 0) continue; // malformed key — leave it, never guess
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);
    const keep = await resolves(kind, id).catch(() => true); // resolver error → conservative keep
    if (keep) continue;
    map.delete(key);
    _baseDirty = true;
    pruned += 1;
  }
  if (pruned > 0) await flushBaseHashes();
  return { pruned };
}

/** Persist the base-hash map if dirty. Serialized so concurrent flushes can't
 *  interleave file writes. Call once after a merge's write loop.
 *
 *  Inside a `withBaseHashFlushBatch` scope the write is deferred: the in-memory
 *  stamps stay coalesced (`_baseDirty`) and the single disk write fires when the
 *  outermost batch closes. Callers still get a thenable (`_flushTail`) so any
 *  `await flushBaseHashes()` resolves immediately rather than blocking inside
 *  the batch. */
export function flushBaseHashes() {
  // Defer while inside a batch, and no-op when nothing is dirty — either way the
  // outstanding `_flushTail` thenable is the right thing to await.
  if (_flushBatchDepth > 0 || !_baseDirty) return _flushTail;
  _flushTail = _flushTail.then(async () => {
    if (!_baseDirty) return;
    _baseDirty = false;
    const map = await ensureBaseLoaded();
    await ensureDir(join(PATHS.data, 'sharing'));
    await atomicWrite(BASE_HASH_FILE(), Object.fromEntries(map));
  }).catch((err) => {
    _baseDirty = true; // retry on next flush
    console.error(`❌ conflictJournal: base-hash flush failed: ${err?.message || err}`);
  });
  return _flushTail;
}

/**
 * Run `fn` with base-hash disk writes coalesced into ONE flush at the end.
 *
 * The base-hash map already coalesces SYNCHRONOUS bursts (the `_baseDirty` flag
 * means a run of `setSyncBaseHash` calls before a single `flushBaseHashes` pays
 * one write). What it can't collapse on its own is an AWAIT-SEPARATED loop that
 * stamps + flushes per iteration: each flush lands on the previous one's settled
 * `_flushTail`, so an N-iteration loop rewrites `sync_base_hashes.json` N times.
 * Wrapping the loop in this scope defers every interior flush; the single
 * terminal write captures all N stamps. (Caller in the tree today: the
 * `peer:online` convergence walk `retryPendingPushesForPeer`, which pushes —
 * and stamps — every subscribed record in sequence.)
 *
 * Re-entrant (depth-counted) so nested scopes collapse to the outermost batch,
 * and the terminal flush runs in `finally` so a thrown/rejected `fn` still
 * persists whatever stamps landed before it failed. Unlike a `setTimeout`
 * debounce (tried and reverted — the unref'd timer leaked into `peerSync.test.js`'s
 * settle-waits and made the suite flaky), this is deterministic: the flush is
 * tied to the scope boundary, not a wall-clock timer, so tests just `await` it.
 *
 * Contract note: stamps performed inside the scope must have settled (the
 * in-memory `setSyncBaseHash` awaited) before `fn` returns, or the terminal
 * flush won't see `_baseDirty` for them. The current caller awaits its stamps.
 */
export async function withBaseHashFlushBatch(fn) {
  _flushBatchDepth += 1;
  try {
    return await fn();
  } finally {
    _flushBatchDepth -= 1;
    if (_flushBatchDepth === 0) await flushBaseHashes();
  }
}

// ---- conflict detection + journaling ----

/**
 * Detect a true 3-way divergence for a record about to be overwritten.
 * Returns `{ isConflict, baseHash, localHash, remoteHash }`.
 */
export async function detectConflict({ kind, id, local, remote }) {
  const baseHash = await getSyncBaseHash(kind, id);
  const localHash = contentHashForRecord(kind, local);
  const remoteHash = contentHashForRecord(kind, remote);
  const isConflict = baseHash != null && localHash != null && remoteHash != null
    && localHash !== baseHash && remoteHash !== baseHash && localHash !== remoteHash;
  return { isConflict, baseHash, localHash, remoteHash };
}

// User-authored content fields a restore/merge may write back, per kind. This
// is the SINGLE SOURCE OF TRUTH — the resolver imports it for its merge-fields
// allowlist, and diffSummary filters to it so the Conflicts UI only ever offers
// fields the resolver will accept (server-owned fields like id/createdAt/
// schemaVersion/locked/origin/deleted are neither restorable nor shown).
export const RESTORABLE_FIELDS = Object.freeze({
  universe: ['name', 'starterPrompt', 'logline', 'premise', 'styleNotes', 'categories', 'compositeSheets', 'influences', 'characters', 'places', 'objects'],
  series: ['name', 'logline', 'premise', 'styleNotes', 'styleGuide', 'titleLogo', 'author', 'stylePromptOverride', 'stylePromptOverrideMode', 'targetFormat', 'issueCountTarget', 'arc', 'seasons'],
  // mediaCollection restores only the user-authored content scalars. `items`
  // are union-merged (never lost, nothing to restore); `universeId`/`seriesId`
  // are structural links managed by the link/unlink helpers, not `updateCollection`
  // patches — so they're hashed for DETECTION but not offered for restore.
  mediaCollection: ['name', 'description', 'coverKey'],
  // Author personas: all user-authored text scalars are restorable. `id`, the
  // LWW/tombstone trio, and `createdAt` are server-owned/structural. Mirrors the
  // PATCHABLE field set in services/authors/logic.js. The author wire form is
  // LWW-overwritten whole (no field-union like mediaCollection's items), so it
  // is hashed in full by contentHashForRecord — no scalar-narrowing branch.
  author: ['name', 'writingStyle', 'bio', 'physicalDescription', 'headshotStyle', 'headshotImageUrl'],
  artist: ['name', 'genre', 'bio', 'musicalStyle', 'physicalDescription', 'portraitStyle', 'portraitImageUrl'],
  album: ['title', 'artistId', 'artist', 'description', 'genre', 'releaseYear', 'coverImageUrl', 'trackIds'],
  // `renders` IS restorable (a conflict restore must bring back the local render
  // history) but is EXCLUDED FROM THE CONTENT HASH — see HASH_EXCLUDED_FIELDS for
  // why (base-hash compatibility for this additive backfilled field).
  track: ['title', 'albumId', 'artistId', 'artist', 'lyrics', 'prompt', 'engine', 'modelId', 'durationSec', 'audioFilename', 'renders'],
  // Issue: the user-authored content the merge can restore. `stages` carries
  // the bulk of the work (prose, comic pages, render metadata). Server-owned /
  // structural fields are excluded deliberately — `number` is renumber-managed,
  // `seriesId` is the immutable parent link, `origin` is share provenance —
  // and `mergeIssuePatch` accepts every field listed here.
  issue: ['title', 'status', 'seasonId', 'arcPosition', 'arcRole', 'lengthProfile', 'pageTarget', 'minutesTarget', 'stages'],
  // Creative Director projects (#1564): the user-authored config + creative
  // content the merge can restore. `treatment` (logline/synopsis/scenes) carries
  // the bulk of the work. Server-owned / machine-managed fields are excluded —
  // `id`/`createdAt`/the LWW-tombstone trip are structural, `collectionId`/
  // `timelineProjectId`/`finalVideoId` are derived output pointers, and `runs[]`
  // is render history (regenerated, not hand-authored). The whole record is
  // hashed for DETECTION by contentHashForRecord (no scalar narrowing); this set
  // is what the Conflicts UI offers for restore. `creativeDirectorProject`
  // matches the record kind and mergeProjectRecord accepts every field here.
  creativeDirectorProject: ['name', 'status', 'styleSpec', 'userStory', 'treatment', 'aspectRatio', 'quality', 'modelId', 'targetDurationSeconds', 'disableAudio', 'autoAcceptScenes', 'startingImageFile'],
  // Mood boards (#1564): the user-authored fields the merge can restore. `items[]`
  // (the pinned image/text references) carries the bulk of the work, alongside
  // name/description. Server-owned / structural fields are excluded — `id`/
  // `createdAt`/the LWW-tombstone trio. The whole record is hashed for DETECTION
  // by contentHashForRecord (no scalar narrowing); this set is what the Conflicts
  // UI offers for restore. `moodBoard` matches the record kind, and the resolver
  // routes restore through restoreBoard → applyBoardRestore (which accepts items,
  // unlike the route's applyBoardPatch).
  moodBoard: ['name', 'description', 'items'],
  // Writers Room works (#1565): the user-authored manifest fields the merge can
  // restore through `updateWork` (which accepts exactly this set + the liveMode
  // partial-merge). Server-owned / structural fields are excluded — `id`/
  // `createdAt`/the LWW-tombstone trio, the draft-version structure
  // (`drafts`/`activeDraftVersionId`, file-primary + lineage-managed), and the
  // bridge links (`pipelineSeriesId`/`cdProjectId`/`mediaCollectionId`, set by
  // their own helpers). The whole manifest is hashed for DETECTION by
  // contentHashForRecord (no scalar narrowing); this set is what the Conflicts UI
  // offers for restore. `writersRoomWork` matches the record kind.
  writersRoomWork: ['title', 'kind', 'status', 'folderId', 'imageStyle', 'liveMode'],
  // Writers Room folders (#1645): the user-authored structural fields the merge
  // can restore through `restoreFolder`. Server-owned / structural fields are
  // excluded — `id`/`createdAt`/the LWW-tombstone trio. The whole folder is
  // hashed for DETECTION by contentHashForRecord (no scalar narrowing); this set
  // is what the Conflicts UI offers for restore. `writersRoomFolder` matches the
  // record kind.
  writersRoomFolder: ['name', 'parentId', 'sortOrder'],
  // A commissionFeedback (#2686) is one taste reaction — the user-authored fields
  // the Conflicts UI may restore are the rating + its note/tags. `commissionId`/
  // `runId` are structural keys (they address the reaction) and are excluded.
  commissionFeedback: ['rating', 'note', 'tags'],
  // A creativeCommission (#2686) restores its federated BRIEF fields; the
  // machine-local schedule/runs/assignment are never in a snapshot (stripped from
  // the wire) so they're excluded.
  creativeCommission: ['name', 'enabled', 'targetAbility', 'brief', 'generation', 'feedbackWindow'],
  // Writers Room exercises (#1645): the user-authored sprint fields the merge can
  // restore through `restoreExercise` — the appended prose + the sprint config.
  // Server-owned / structural fields are excluded (`id`/`createdAt`/`startedAt`/
  // the LWW-tombstone trio). `writersRoomExercise` matches the record kind.
  writersRoomExercise: ['workId', 'prompt', 'durationSeconds', 'startingWords', 'endingWords', 'wordsAdded', 'appendedText', 'status', 'finishedAt'],
  // Music Video projects (#1770): the user-authored config + creative content the
  // merge can restore. `scenes[]` (the beat-aligned director board with prompts)
  // carries the bulk of the work, alongside name/status/mode/trackId/
  // uploadedAudioFilename/concept. Server-owned / machine-managed fields are
  // excluded — `id`/`createdAt`/the LWW-tombstone trio are structural,
  // `renderHistoryId` is a derived output pointer, and `audioAnalysis` is the
  // machine-derived beat cache (regenerated from the audio, not hand-authored).
  // The whole record is hashed for DETECTION by contentHashForRecord (no scalar
  // narrowing); this set is what the Conflicts UI offers for restore.
  // `musicVideoProject` matches the record kind and updateProject (via
  // applyProjectPatch's wholesale spread) accepts every field here.
  musicVideoProject: ['name', 'status', 'mode', 'trackId', 'uploadedAudioFilename', 'concept', 'scenes'],
});

const present = (v) => v !== undefined;
const changedFlag = (lv, rv) => (present(lv) && present(rv) ? 'both' : (present(rv) ? 'remote-only' : 'local-only'));

// First non-empty string among `fields`, in order — used both to pick a stable
// PAIR key for an array element and to pick a human display LABEL for it.
const firstStringField = (el, fields) => {
  for (const k of fields) {
    if (typeof el?.[k] === 'string' && el[k].trim()) return el[k];
  }
  return null;
};
// Stable key used to PAIR two array elements across the local/remote sides
// (prefer an explicit id so a reorder/insert doesn't cascade). Null ⇒ the
// element carries no identity and the array isn't deep-diffable by identity.
const entryMatchKey = (el) => firstStringField(el, ['id', 'key', 'slug', 'name']);
// Human-friendly LABEL for a changed sub-entry (a uuid id is a poor label, so a
// name/title is preferred for display even when the match used the id).
const entryLabel = (el, fallback) => firstStringField(el, ['name', 'title', 'label', 'key', 'slug', 'id']) ?? fallback;

// Diff two key→value maps: one part per key whose value differs. Each part
// carries a STABLE, unique `path` (the map key — used as the React render key)
// and a human `label(key, lv, rv)` for display; for an object map the two are
// the same, but for an identity-paired array the path is the (unique) match key
// while the label is a friendly name that may collide. Returns the parts array,
// or null when nothing differs.
const diffEntryMaps = (lMap, rMap, label) => {
  const parts = [];
  for (const key of new Set([...lMap.keys(), ...rMap.keys()])) {
    const lv = lMap.get(key);
    const rv = rMap.get(key);
    if (canonicalStringify(lv) === canonicalStringify(rv)) continue;
    parts.push({ path: key, label: label(key, lv, rv), localValue: lv, remoteValue: rv, changed: changedFlag(lv, rv) });
  }
  return parts.length ? parts : null;
};

// Build a Map keyed by each element's stable match key. Returns null — so the
// caller falls back to the whole-field diff — when ANY element is identity-less
// (null key) OR two elements share a key (a duplicate id, or two entries that
// both fall back to the same name): identity pairing isn't reliable, and a
// last-wins Map would silently drop the collided element from the diff.
const buildKeyedMap = (arr) => {
  const map = new Map();
  for (const el of arr) {
    const key = entryMatchKey(el);
    if (key === null || map.has(key)) return null;
    map.set(key, el);
  }
  return map;
};

/**
 * One-level structural diff of a single restorable field, used to render the
 * Conflicts tab as "which sub-entry changed" instead of one giant JSON blob.
 * Returns an array of changed sub-entries `[{ path, label, localValue,
 * remoteValue, changed }]`, or `null` when the field isn't deepenable — a
 * scalar, an array of scalars, an array of objects without unique stable
 * identities, or a shape-mismatch (object vs array) — in which case the caller
 * keeps the whole-field diff. Only entries that actually differ are emitted.
 *
 * - Object map / structured object (`categories`, `stages`, `arc`): one part
 *   per key whose value differs (path = label = key).
 * - Array of identity-bearing objects (`characters`, `places`, `seasons`):
 *   paired by `entryMatchKey`; one part per identity that differs (a side
 *   missing ⇒ added/removed). The `path` is the unique match key; the `label`
 *   is a human name.
 */
export function deepFieldDiff(localVal, remoteVal) {
  if (isPlainObject(localVal) && isPlainObject(remoteVal)) {
    return diffEntryMaps(new Map(Object.entries(localVal)), new Map(Object.entries(remoteVal)), (key) => key);
  }
  if (Array.isArray(localVal) && Array.isArray(remoteVal)) {
    if (localVal.length === 0 && remoteVal.length === 0) return null;
    const lMap = buildKeyedMap(localVal);
    const rMap = buildKeyedMap(remoteVal);
    if (!lMap || !rMap) return null; // identity-less or duplicate keys → whole-field diff
    return diffEntryMaps(lMap, rMap, (key, lv, rv) => entryLabel(lv ?? rv, key));
  }
  return null;
}

// Per-field diff over the kind's restorable content fields. A scalar field
// carries its whole-field `localValue`/`remoteValue` for InlineDiff; an
// object-map or array-of-objects field instead carries `parts` (the changed
// sub-entries) so the UI renders one focused diff per entry rather than a
// single giant JSON blob. The merge-fields selection stays at FIELD granularity
// (the resolver applies whole snapshot fields) — `parts` is display-only.
const diffSummary = (kind, local, remote) => {
  const fields = RESTORABLE_FIELDS[kind] || [];
  const out = [];
  for (const field of fields) {
    const lv = local?.[field];
    const rv = remote?.[field];
    if (canonicalStringify(lv) === canonicalStringify(rv)) continue;
    const changed = changedFlag(lv, rv);
    const parts = deepFieldDiff(lv, rv);
    if (parts) out.push({ field, changed, parts });
    else out.push({ field, localValue: lv, remoteValue: rv, changed });
  }
  return out;
};

/**
 * Archive a losing local version. Writes a `pending` journal entry; returns its
 * id. Snapshots are stored in sanitized wire form so a later restore re-applies
 * a clean shape.
 */
export async function journalConflict({ kind, id, local, remote, source, hashes }) {
  const localSnapshot = sanitizeRecordForWire(kind, local) ?? local;
  const remoteSnapshot = sanitizeRecordForWire(kind, remote) ?? remote;
  const entry = {
    id: randomUUID(),
    recordKind: kind,
    recordId: id,
    detectedAt: new Date().toISOString(),
    source: source || { via: 'unknown', peerId: null, bucketId: null },
    baseHash: hashes?.baseHash ?? null,
    localHash: hashes?.localHash ?? null,
    remoteHash: hashes?.remoteHash ?? null,
    localSnapshot,
    remoteSnapshot,
    localUpdatedAt: local?.updatedAt ?? null,
    remoteUpdatedAt: remote?.updatedAt ?? null,
    diffSummary: diffSummary(kind, localSnapshot, remoteSnapshot),
    status: 'pending',
    resolvedAt: null,
    resolution: null,
  };
  await store().saveOne(entry.id, entry);
  console.log(`🪢 conflictJournal: archived ${kind} ${String(id).slice(0, 12)} (source=${entry.source.via})`);
  return entry.id;
}

/**
 * The one call every merge makes RIGHT BEFORE its overwrite. Detects a true
 * conflict, archives the losing local version if so, and advances the base hash
 * to the remote's (in memory — caller flushes after its loop). NEVER throws into
 * the merge — a journal failure logs and the merge proceeds (convergence wins).
 *
 * Skips journaling (but still advances base) when there is no local content to
 * lose: an absent/ephemeral local, or a local tombstone being overwritten.
 */
export async function maybeJournalBeforeOverwrite({ kind, id, local, remote, source }) {
  try {
    const { isConflict, baseHash, localHash, remoteHash } = await detectConflict({ kind, id, local, remote });
    const localIsTombstone = local?.deleted === true;
    if (isConflict && localHash != null && !localIsTombstone) {
      await journalConflict({ kind, id, local, remote, source, hashes: { baseHash, localHash, remoteHash } });
    }
    if (remoteHash != null) await setSyncBaseHash(kind, id, remoteHash);
  } catch (err) {
    console.error(`❌ conflictJournal: maybeJournalBeforeOverwrite(${kind}:${id}) failed (proceeding): ${err?.message || err}`);
  }
}

// Test-only reset of the in-memory base-hash cache so suites that swap PATHS.data
// between tests don't bleed state across the module-level cache.
export function __resetBaseHashCacheForTests() {
  _baseHashes = null;
  _loadPromise = null;
  _baseDirty = false;
  _flushTail = Promise.resolve();
  _flushBatchDepth = 0;
  _store = null;
}
