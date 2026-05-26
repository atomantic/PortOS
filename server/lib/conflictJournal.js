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
import { canonicalStringify } from './objects.js';
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

/**
 * sha256 of the canonical wire projection. Reuses sanitizeRecordForWire +
 * canonicalStringify so the sender hashing what it pushes and the receiver
 * hashing its local copy agree byte-for-byte. Returns null when the record has
 * no wire form (ephemeral non-tombstone, or invalid) — callers treat a null
 * hash as "cannot compare".
 */
export function contentHashForRecord(kind, record) {
  const wire = sanitizeRecordForWire(kind, record);
  if (!wire) return null;
  return createHash('sha256').update(canonicalStringify(wire)).digest('hex');
}

// ---- base-hash side store (in-memory cache, batched write-through) ----

let _baseHashes = null;       // Map<`${kind}:${id}`, sha256>
let _loadPromise = null;
let _baseDirty = false;
let _flushTail = Promise.resolve();

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

/** Persist the base-hash map if dirty. Serialized so concurrent flushes can't
 *  interleave file writes. Call once after a merge's write loop. */
export function flushBaseHashes() {
  if (!_baseDirty) return _flushTail;
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
  series: ['name', 'logline', 'premise', 'styleNotes', 'titleLogo', 'author', 'stylePromptOverride', 'stylePromptOverrideMode', 'targetFormat', 'issueCountTarget', 'arc', 'seasons'],
});

// Top-level shallow diff over the kind's restorable content fields — enough for
// the UI to render "Name, Premise differ" with InlineDiff and offer each as a
// selectable merge-field. Deep field diffing is a follow-up.
const diffSummary = (kind, local, remote) => {
  const fields = RESTORABLE_FIELDS[kind] || [];
  const out = [];
  for (const field of fields) {
    const lv = local?.[field];
    const rv = remote?.[field];
    if (canonicalStringify(lv) === canonicalStringify(rv)) continue;
    const present = (v) => v !== undefined;
    out.push({
      field,
      localValue: lv,
      remoteValue: rv,
      changed: present(lv) && present(rv) ? 'both' : (present(rv) ? 'remote-only' : 'local-only'),
    });
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
  _store = null;
}
