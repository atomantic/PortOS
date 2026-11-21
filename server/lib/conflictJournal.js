/**
 * Non-blocking conflict journal.
 *
 * Cross-install merges are last-write-wins by `updatedAt`. When LWW would
 * OVERWRITE a local record but BOTH sides edited it since they were last in sync
 * (a true 3-way divergence), the losing local version is archived here BEFORE
 * the overwrite: peers still converge on the LWW winner and no edit is silently
 * lost (restorable from Sharing → Conflicts).
 *
 * Divergence signal — per-record `syncBaseHash` (content hash when this instance
 * and a peer last held the same content):
 *
 *     conflict := base != null && hLocal !== base && hRemote !== base && hLocal !== hRemote
 *
 * `base == null` is a clean update (conservative: misses at most the first
 * divergence per record, never false-positives) — UNLESS the base-hash store is
 * untrustworthy: a present-but-unreadable `sync_base_hashes.json` latches
 * `_persistBlocked`, under which every overwrite journals fail-closed and
 * nothing writes back over the unreadable file.
 *
 * The base hash advances to the remote's hash on EVERY accepted overwrite, else
 * the 60s snapshot loop would re-journal the same divergence each cycle.
 *
 * This store and the base-hash store are LOCAL-ONLY: never enrolled in
 * PEER_SUBSCRIBABLE_KINDS / snapshot categories / sanitizeStateForWire.
 */

import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import { PATHS, atomicWrite, readJSONFileStrict, ensureDir } from './fileUtils.js';
import { createCollectionStore } from './collectionStore.js';
import { canonicalStringify, isPlainObject } from './objects.js';
import { sanitizeRecordForWire, stripMusicVideoLocalRenderPins } from './syncWire.js';
import { SUBMISSION_FIELDS as ARTIST_SUBMISSION_FIELDS } from './artistLimits.js';

export const WRITERS_ROOM_DRAFT_BODY_CONFLICT_KIND = 'writersRoomDraftBody';

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

// mediaCollection divergence hashes a SCALAR SUBSET: the merge union-merges `items`
// and bumps `updatedAt` on addItem, so hashing the full record would
// false-positive on independent item adds that overwrote nothing. `updatedAt` is
// the LWW key, excluded. Soft-delete fields stay (a remote delete over a
// diverged local edit is a real conflict).
const MEDIA_COLLECTION_SCALAR_FIELDS = Object.freeze(['name', 'description', 'coverKey', 'universeId', 'seriesId']);

// Fields dropped from the CONTENT HASH (they still replicate). Server-managed
// values that mutate without a user edit would read as false divergence:
// `issue.number` shifts on sibling renumbering; `track.renders` is backfilled onto
// existing tracks, so hashing it would invalidate every pre-upgrade base hash.
// Both remain restorable. Contrast HASH_FIELDS, for user-authored additive fields.
const HASH_EXCLUDED_FIELDS = Object.freeze({ issue: ['number'], track: ['renders'] });
const ISSUE_HASH_VERSION_WITHOUT_RUN_HISTORY = 2;

// User-authored fields added to a kind's wire shape later, keyed by a LOCAL
// version (independent of PORTOS_SCHEMA_VERSIONS, which gates wire compat). They
// DO belong in conflict detection, but adding one must not invalidate base
// hashes stamped before it existed: `contentHashForRecord`'s `maxVersion` drops
// later fields, `setSyncBaseHash` stamps the current version, and
// `detectConflict` recomputes at the STORED base's version. A base predating a
// field misses divergence limited to it until the next sync re-stamps it.
const HASH_FIELDS = Object.freeze({
  // v3: chiptuneScore/chiptunePrompt; v4: concept; v7: waveSketch/waveSketchPrompt.
  track: Object.freeze({
    3: Object.freeze(['chiptuneScore', 'chiptunePrompt']),
    4: Object.freeze(['concept']),
    7: Object.freeze(['waveSketch', 'waveSketchPrompt']),
  }),
  // v2: press & submission profile (matches PORTOS_SCHEMA_VERSIONS.artists).
  artist: Object.freeze({
    2: ARTIST_SUBMISSION_FIELDS,
  }),
});

// field→version lookup per kind, inverted once at load.
const HASH_FIELD_VERSION_BY_KIND = Object.freeze(Object.fromEntries(
  Object.entries(HASH_FIELDS).map(([kind, versioned]) => {
    const byField = new Map();
    for (const [v, fields] of Object.entries(versioned)) {
      for (const f of fields) byField.set(f, Number(v));
    }
    return [kind, byField];
  }),
));

// Highest projection version for `kind`, which `setSyncBaseHash` stamps.
function currentHashVersionForKind(kind) {
  const minimum = kind === 'issue' ? ISSUE_HASH_VERSION_WITHOUT_RUN_HISTORY : 1;
  const versioned = HASH_FIELDS[kind];
  return versioned ? Math.max(minimum, ...Object.keys(versioned).map(Number)) : minimum;
}

/**
 * sha256 of the canonical content projection, via sanitizeRecordForWire +
 * canonicalStringify so sender and receiver agree byte-for-byte. mediaCollection
 * narrows to MEDIA_COLLECTION_SCALAR_FIELDS and some kinds drop
 * HASH_EXCLUDED_FIELDS; both sides apply the same narrowing. Returns null when
 * the record has no wire form (callers treat as "cannot compare").
 *
 * `maxVersion` restricts to fields introduced at or below it — pass the STORED
 * base's version when comparing. Omitted (stamping a new base) means current.
 */
export function contentHashForRecord(kind, record, { maxVersion } = {}) {
  const includeIssueRunHistory = kind === 'issue' && maxVersion != null && maxVersion < ISSUE_HASH_VERSION_WITHOUT_RUN_HISTORY;
  const wire = sanitizeRecordForWire(kind, record, { includeIssueRunHistory });
  if (!wire) return null;
  let hashInput = wire;
  if (kind === 'mediaCollection') {
    hashInput = projectCollectionScalars(wire);
  } else if (kind === 'musicVideoProject') {
    hashInput = stripMusicVideoLocalRenderPins(wire);
  } else if (HASH_EXCLUDED_FIELDS[kind] || HASH_FIELD_VERSION_BY_KIND[kind]) {
    const excluded = HASH_EXCLUDED_FIELDS[kind] || [];
    const introducedAt = HASH_FIELD_VERSION_BY_KIND[kind];
    hashInput = Object.fromEntries(Object.entries(wire).filter(([k]) => {
      if (excluded.includes(k)) return false;
      const fieldVersion = introducedAt?.get(k);
      if (fieldVersion == null) return true; // not a versioned field — always included
      return maxVersion == null || fieldVersion <= maxVersion;
    }));
  }
  return createHash('sha256').update(canonicalStringify(hashInput)).digest('hex');
}

// Narrow a wire-form collection to the tracked scalars plus the normalized soft-delete pair.
function projectCollectionScalars(wire) {
  const out = {};
  for (const f of MEDIA_COLLECTION_SCALAR_FIELDS) if (f in wire) out[f] = wire[f];
  out.deleted = wire.deleted === true;
  out.deletedAt = out.deleted ? (wire.deletedAt ?? null) : null;
  return out;
}

// Map<`${kind}:${id}`, sha256 | { h, v }>. A bare string is a legacy/v1 entry (see
// readBaseEntry); new entries are `{ h, v }` so the version travels with the hash.
let _baseHashes = null;
let _loadPromise = null;
let _baseDirty = false;
let _flushTail = Promise.resolve();
// >0 inside `withBaseHashFlushBatch`: defers the disk write so await-separated loops collapse into one flush.
let _flushBatchDepth = 0;
// Latched when the base-hash file was present-but-unreadable at load.
// flushBaseHashes() whole-file-REPLACES the file, so persisting over an unread
// baseline would destroy entries that exist nowhere else. While latched nothing
// flushes and maybeJournalBeforeOverwrite fails CLOSED. Process-lifetime; only
// __reset clears it.
let _persistBlocked = false;

const baseKey = (kind, id) => `${kind}:${id}`;

async function ensureBaseLoaded() {
  if (_baseHashes) return _baseHashes;
  if (!_loadPromise) {
    _loadPromise = (async () => {
      // Strict: a present-but-unreadable file must NOT read as empty (that disabled
      // detection and let the next flush destroy baselines). ENOENT is the only
      // trustworthy empty; non-object/array shapes latch too.
      const { ok, value } = await readJSONFileStrict(BASE_HASH_FILE(), {}, { allowArray: false });
      if (ok && isPlainObject(value)) {
        _baseHashes = new Map(Object.entries(value));
      } else {
        _persistBlocked = true;
        _baseHashes = new Map();
        // Name the recovery step: the latch is process-lifetime.
        console.error(`❌ conflictJournal: ${BASE_HASH_FILE()} is present but unreadable — base hashes are preserved on disk (persistence latched off) and overwrites journal fail-closed; repair or delete it and restart to re-enable persistence`);
      }
      return _baseHashes;
    })();
  }
  return _loadPromise;
}

// Normalize a raw value (bare string or `{ h, v }`) to `{ hash, version }`; absent version is 1, the floor before versioned fields.
function readBaseEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { hash: raw, version: 1 };
  const version = Number.isInteger(raw.v) ? raw.v : 1;
  return { hash: raw.h ?? null, version };
}

/** Shared lookup behind getSyncBaseHash and detectConflict. */
async function readStoredBaseEntry(kind, id) {
  const map = await ensureBaseLoaded();
  return readBaseEntry(map.get(baseKey(kind, id)));
}

/** The stored base hash, or null. Use detectConflict when the version matters. */
export async function getSyncBaseHash(kind, id) {
  return (await readStoredBaseEntry(kind, id))?.hash ?? null;
}

/**
 * Set the base hash in memory (disk write deferred to flushBaseHashes). Stamps
 * the current version for `kind` unless `version` is given (tests plant older-version hashes).
 */
export async function setSyncBaseHash(kind, id, hash, { version } = {}) {
  const map = await ensureBaseLoaded();
  if (!hash) return;
  const v = Number.isInteger(version) ? version : currentHashVersionForKind(kind);
  const key = baseKey(kind, id);
  const existing = readBaseEntry(map.get(key));
  if (existing?.hash === hash && existing?.version === v) return;
  map.set(key, { h: hash, v });
  _baseDirty = true;
}

/** Remove the base hash for a pruned record (idempotent) so entries don't grow unbounded. */
export async function deleteSyncBaseHash(kind, id) {
  const map = await ensureBaseLoaded();
  const key = baseKey(kind, id);
  if (!map.has(key)) return;
  map.delete(key);
  _baseDirty = true;
  await flushBaseHashes();
}

/**
 * Sweep base-hash entries whose record no longer resolves — a BACKSTOP for keys
 * that escaped the per-record prune paths (hand-deleted records, older versions).
 *
 * `resolves` is an async `(kind, id) => boolean`; return true to keep. Unknown
 * kinds must return true so a partial resolver never strips live entries.
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

/** Persist the base-hash map if dirty, serialized so flushes can't interleave.
 *  Inside a `withBaseHashFlushBatch` scope the write is deferred to the outermost
 *  close; callers still get the `_flushTail` thenable. No-ops while
 *  `_persistBlocked` is latched: persisting would replace a file that may hold
 *  the real baselines. Evictions still apply in memory. */
export function flushBaseHashes() {
  // Defer in a batch, refuse when untrustworthy, no-op when clean.
  if (_persistBlocked || _flushBatchDepth > 0 || !_baseDirty) return _flushTail;
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
 * Collapses an AWAIT-SEPARATED loop that stamps + flushes per iteration
 * (peer:online convergence, `pruneTombstoned*` loops) from N rewrites into one.
 * Eviction only marks `_baseDirty` for a key actually held, so a no-op prune
 * costs zero writes.
 *
 * Re-entrant (depth-counted); the terminal flush runs in `finally` so a thrown
 * `fn` still persists earlier stamps. Scope-bound, not a timer (a debounce timer
 * leaked into peerSync test settle-waits).
 *
 * Stamps must be awaited before `fn` returns. Depth is module-level, so
 * CONCURRENT batches merge: the last to close flushes everything accumulated.
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
 * Returns `{ isConflict, baseHash, localHash, remoteHash, baseUnavailable }`.
 * local/remote are recomputed at the STORED base's version (see HASH_FIELDS) so
 * the comparison is apples-to-apples.
 */
export async function detectConflict({ kind, id, local, remote }) {
  const base = await readStoredBaseEntry(kind, id);
  const baseHash = base?.hash ?? null;
  const maxVersion = base ? base.version : undefined;
  const localHash = contentHashForRecord(kind, local, { maxVersion });
  const remoteHash = contentHashForRecord(kind, remote, { maxVersion });
  const isConflict = baseHash != null && localHash != null && remoteHash != null
    && localHash !== baseHash && remoteHash !== baseHash && localHash !== remoteHash;
  // `baseUnavailable`: the baseline file was unreadable, so `isConflict === false`
  // means "no base", NOT "proven clean"; the merge path fails closed.
  return { isConflict, baseHash, localHash, remoteHash, baseUnavailable: _persistBlocked };
}

// Restorable fields whose ABSENCE from a snapshot is meaningful: universe `factual`
// is persisted only when true, so restoring to fiction needs the resolver to
// fill in an explicit `false`.
export const ABSENT_MEANS_FALSE_FIELDS = Object.freeze({
  universe: Object.freeze(['factual']),
});

// User-authored fields a restore/merge may write back, per kind. SINGLE SOURCE OF
// TRUTH: the resolver's merge allowlist and diffSummary both use it, so the UI
// never offers fields the resolver rejects (server-owned fields are neither).
export const RESTORABLE_FIELDS = Object.freeze({
  // `factual` is federated and hashed, so it must be restorable or its conflict
  // would journal a diff that can't mention it. See ABSENT_MEANS_FALSE_FIELDS.
  universe: ['name', 'starterPrompt', 'logline', 'premise', 'styleNotes', 'categories', 'compositeSheets', 'influences', 'characters', 'places', 'objects', 'factual'],
  series: ['name', 'logline', 'premise', 'styleNotes', 'styleGuide', 'titleLogo', 'author', 'stylePromptOverride', 'stylePromptOverrideMode', 'targetFormat', 'issueCountTarget', 'arc', 'seasons'],
  // Only content scalars: `items` are union-merged; `universeId`/`seriesId` are
  // structural links, hashed for detection but not restorable.
  mediaCollection: ['name', 'description', 'coverKey'],
  // Mirrors PATCHABLE in services/authors/logic.js; hashed in full (no scalar narrowing).
  author: ['name', 'writingStyle', 'bio', 'physicalDescription', 'headshotStyle', 'headshotImageUrl'],
  artist: ['name', 'genre', 'bio', 'musicalStyle', 'physicalDescription', 'portraitStyle', 'portraitImageUrl', ...ARTIST_SUBMISSION_FIELDS],
  album: ['title', 'artistId', 'artist', 'description', 'genre', 'releaseYear', 'coverImageUrl', 'trackIds'],
  // `renders` is restorable but excluded from the hash (see HASH_EXCLUDED_FIELDS);
  // chiptune*/waveSketch* are restorable and hashed via HASH_FIELDS.
  track: ['title', 'albumId', 'artistId', 'artist', 'concept', 'lyrics', 'prompt', 'engine', 'modelId', 'durationSec', 'audioFilename', 'renders', 'chiptuneScore', 'chiptunePrompt', 'waveSketch', 'waveSketchPrompt'],
  // `stages` carries the bulk of the work. `number` (renumber-managed), `seriesId`
  // and `origin` are excluded; `mergeIssuePatch` accepts every field listed.
  issue: ['title', 'status', 'seasonId', 'arcPosition', 'arcRole', 'lengthProfile', 'pageTarget', 'minutesTarget', 'stages'],
  // `treatment` carries the bulk. Excluded: structural id/createdAt/tombstone trio,
  // derived output pointers (`collectionId`/`timelineProjectId`/`finalVideoId`)
  // and `runs[]` render history.
  creativeDirectorProject: ['name', 'status', 'styleSpec', 'userStory', 'treatment', 'aspectRatio', 'quality', 'modelId', 'targetDurationSeconds', 'disableAudio', 'autoAcceptScenes', 'startingImageFile'],
  // `items[]` carries the bulk; `style`/`posterImageRef` are user-triggered so must
  // be restorable. Restore routes through restoreBoard → applyBoardRestore
  // (which, unlike applyBoardPatch, accepts items).
  moodBoard: ['name', 'description', 'items', 'style', 'posterImageRef', 'collageImageRef'],
  writersRoomCharacters: ['characters'],
  writersRoomPlaces: ['places'],
  writersRoomObjects: ['objects'],
  [WRITERS_ROOM_DRAFT_BODY_CONFLICT_KIND]: ['body'],
  // Restored via `updateWork`. Excluded: structural fields, draft-version structure
  // (lineage-managed) and bridge links set by their own helpers.
  writersRoomWork: ['title', 'kind', 'status', 'folderId', 'imageStyle', 'liveMode'],
  // Restored via `restoreFolder`.
  writersRoomFolder: ['name', 'parentId', 'sortOrder'],
  // One taste reaction: rating + note/tags; `commissionId`/`runId` are structural keys.
  commissionFeedback: ['rating', 'note', 'tags'],
  // Federated BRIEF fields only; machine-local schedule/runs/assignment/enabled are stripped from the wire.
  creativeCommission: ['name', 'targetAbility', 'brief', 'generation', 'feedbackWindow'],
  // `kind` is structural (roster minted from it, CHECK-constrained); `cards[]`
  // restores with the deck row via `restoreDeck`; capability pins never reach a snapshot.
  deck: ['name', 'description', 'styleNotes', 'influences', 'layoutPrompt', 'cardOrientation', 'cardOrientationPrompt', 'samples', 'cardSize', 'universeId'],
  // `tempTrack` restores with `beats` so sanitizeStoryboard re-resolves beat pins
  // against restored markers. `plotLlm` is a per-user provider pick and stays local.
  storyboard: ['name', 'logline', 'aspectRatio', 'artStyle', 'universeId', 'moodBoardId', 'recipe', 'plot', 'tempTrack', 'beats'],
  // Authored story graph, playback config and render prefs; universe/series ids are structural links.
  fableLoom: ['name', 'logline', 'premise', 'styleNotes', 'format', 'playSettings', 'renderSettings', 'seriesPlan', 'productionStatus', 'protagonistCharacterId', 'protagonistWardrobeId', 'protagonistWardrobeLocked', 'participationMode', 'audienceCommunicationMedium', 'episodes'],
  // Restored via `restoreExercise`.
  writersRoomExercise: ['workId', 'prompt', 'durationSeconds', 'startingWords', 'endingWords', 'wordsAdded', 'appendedText', 'status', 'finishedAt'],
  // `scenes[]` carries the bulk. Excluded: structural fields, derived
  // `renderHistoryId` and the machine-derived `audioAnalysis` beat cache.
  musicVideoProject: ['name', 'status', 'mode', 'trackId', 'uploadedAudioFilename', 'vocalStemFilename', 'concept', 'scenes'],
});

const present = (v) => v !== undefined;
const changedFlag = (lv, rv) => (present(lv) && present(rv) ? 'both' : (present(rv) ? 'remote-only' : 'local-only'));

// First non-empty string among `fields`: used for both pair keys and display labels.
const firstStringField = (el, fields) => {
  for (const k of fields) {
    if (typeof el?.[k] === 'string' && el[k].trim()) return el[k];
  }
  return null;
};
// Stable key pairing array elements across sides (prefer id so reorder/insert doesn't cascade); null means no identity.
const entryMatchKey = (el) => firstStringField(el, ['id', 'key', 'slug', 'name']);
// Display label (prefer name/title over a uuid).
const entryLabel = (el, fallback) => firstStringField(el, ['name', 'title', 'label', 'key', 'slug', 'id']) ?? fallback;

// Diff two key→value maps, one part per differing key. `path` is the unique map
// key (React key); `label` is display-only and may collide. Null when nothing differs.
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

// Map elements by match key. Null (caller falls back to whole-field diff) on an
// identity-less or duplicate-key element, since a last-wins Map would drop one.
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
 * One-level structural diff of a restorable field, so the Conflicts tab shows
 * "which sub-entry changed" rather than one JSON blob. Returns changed entries
 * `[{ path, label, localValue, remoteValue, changed }]`, or `null` when not
 * deepenable (scalar, scalar array, arrays without unique identities, shape
 * mismatch) so the caller keeps the whole-field diff.
 *
 * Objects diff per key; arrays of identity-bearing objects pair by
 * `entryMatchKey` (path = match key, label = human name).
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

// Per-field diff over restorable fields. Object-map/array fields carry display-only
// `parts`; merge selection stays at FIELD granularity.
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
    const { isConflict, baseHash, localHash, remoteHash, baseUnavailable } = await detectConflict({ kind, id, local, remote });
    const localIsTombstone = local?.deleted === true;
    // Fail CLOSED when baselines are unreadable: a spurious entry costs one
    // dismissal, a missed one costs an edit. Nothing-to-lose guards still apply.
    if ((isConflict || baseUnavailable) && localHash != null && !localIsTombstone) {
      await journalConflict({ kind, id, local, remote, source, hashes: { baseHash, localHash, remoteHash } });
    }
    // Stamp an UNRESTRICTED hash: setSyncBaseHash tags the current version, so a
    // version-restricted hash would be mislabeled and never match once a HASH_FIELDS field is added.
    const stampHash = contentHashForRecord(kind, remote);
    if (stampHash != null) await setSyncBaseHash(kind, id, stampHash);
  } catch (err) {
    console.error(`❌ conflictJournal: maybeJournalBeforeOverwrite(${kind}:${id}) failed (proceeding): ${err?.message || err}`);
  }
}

/**
 * True while the `_persistBlocked` latch is held: persistence is off and
 * overwrites journal fail-closed. Awaits the load so a status poll can't report
 * healthy before the file was ever read.
 */
export async function isBaseHashPersistBlocked() {
  await ensureBaseLoaded();
  return _persistBlocked;
}

// Test-only reset of the in-memory base-hash cache so suites that swap PATHS.data
// between tests don't bleed state across the module-level cache.
export function __resetBaseHashCacheForTests() {
  _baseHashes = null;
  _loadPromise = null;
  _baseDirty = false;
  _flushTail = Promise.resolve();
  _flushBatchDepth = 0;
  _persistBlocked = false;
  _store = null;
}
