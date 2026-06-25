/**
 * Writers Room — cross-peer federation facade (#1565).
 *
 * The single import surface for the peer-sync graph (peerSync.js) and tombstone
 * GC (tombstoneGc.js). Routes the LWW/tombstone merge + prune through the active
 * storage backend (store.js → db.js or the file backend) and owns the two
 * facade-level concerns the backends can't: the file-primary draft `.md` BODY
 * asset manifest (sender) + diff (receiver), and the on-disk cleanup + base-hash
 * eviction when a tombstone is hard-pruned.
 *
 * Mirrors creativeDirector/local.js's federation re-exports + moodBoard/index.js,
 * but keeps the announce hooks in local.js (the mutators live there). This module
 * does NOT import peerSync — peerSync statically imports `mergeWorksFromSync`
 * from here, so importing it back would close a load-order cycle.
 */

import { rm } from 'fs/promises';
import { existsSync } from 'fs';
import { sha256File } from '../../lib/fileUtils.js';
import { deleteSyncBaseHash } from '../../lib/conflictJournal.js';
import { writersRoomStore } from './store.js';
import {
  WRITERS_ROOM_WORK_KIND, WRITERS_ROOM_DRAFT_ASSET_KIND, draftAssetEntries,
  WRITERS_ROOM_FOLDER_KIND, WRITERS_ROOM_EXERCISE_KIND,
} from './syncLogic.js';
import {
  WORK_ID_RE, DRAFT_ID_RE, FOLDER_ID_RE, EXERCISE_ID_RE, wrWorkDir, wrDraftPath,
} from './_shared.js';

const store = () => writersRoomStore();

/** One work's manifest including a tombstone (for the LWW compare + the push). */
export async function getWorkForSync(id) {
  return store().readWork(id, { includeDeleted: true });
}

/** Work ids — live only by default, or all (incl. tombstones) when asked. */
export async function listWorkIdsForSync(options = {}) {
  return store().listWorkIds(options);
}

/**
 * Live works as `{ id, updatedAt }` for the peer-sync backfill + full-sync
 * coverage status. `updatedAt` is required by `getFullSyncCoverageForPeer` to
 * detect a confirmed push gone stale — bare `{ id }` stubs would make every
 * old confirmation look fresh and report a changed manuscript as fully mirrored.
 */
export async function listWorksForSync() {
  const works = await store().listWorks();
  return works
    .filter((w) => w && typeof w.id === 'string')
    .map((w) => ({ id: w.id, updatedAt: w.updatedAt }));
}

/** Merge an incoming batch of work records from a peer (LWW, tombstone-aware). */
export async function mergeWorksFromSync(remoteWorks, options = {}) {
  return store().mergeWorksFromSync(remoteWorks, options);
}

/**
 * Hard-remove tombstoned works older than the cutoff (called by tombstone GC).
 * The backend drops the rows (PG) / identifies the dirs (file); this facade then
 * rm's each work's on-disk dir (manifest + file-primary `.md` bodies) and evicts
 * its conflict-journal base hash — uniform across both backends. Returns `{ pruned }`.
 */
export async function pruneTombstonedWorks(olderThanMs) {
  const { pruned, ids } = await store().pruneTombstonedWorks(olderThanMs);
  for (const id of ids) {
    if (typeof id !== 'string' || !WORK_ID_RE.test(id)) continue;
    await rm(wrWorkDir(id), { recursive: true, force: true }).catch(() => {});
    await deleteSyncBaseHash(WRITERS_ROOM_WORK_KIND, id);
  }
  return { pruned };
}

// ---------- folders + exercises (body-less records) ----------
//
// Folders + exercises federate as of #1645 (follow-up to #1565). Unlike works
// they have NO file-primary `.md` body — the whole record is the DB row's `data`
// JSONB (or the folders.json/exercises.json array on the file backend), so these
// facades are the works facades minus the draft-body manifest machinery. The
// only on-disk cleanup at prune time is the conflict-journal base hash (no work
// dir to rm).

// Shared prune facade for a body-less kind: the backend drops the rows/entries,
// then this evicts each pruned id's conflict-journal base hash (the only on-disk
// cleanup — no work dir to rm). `idRe` rejects a junk id before the eviction.
async function pruneTombstonedBodyless(storePruneFn, kind, idRe, olderThanMs) {
  const { pruned, ids } = await storePruneFn(olderThanMs);
  for (const id of ids) {
    if (typeof id !== 'string' || !idRe.test(id)) continue;
    await deleteSyncBaseHash(kind, id);
  }
  return { pruned };
}

/** One folder including a tombstone (for the LWW compare + the push). */
export async function getFolderForSync(id) {
  return store().readFolder(id, { includeDeleted: true });
}

/** Folder ids — live only by default, or all (incl. tombstones) when asked. */
export async function listFolderIdsForSync(options = {}) {
  return store().listFolderIds(options);
}

/**
 * Live folders as `{ id, updatedAt }` for the peer-sync backfill + full-sync
 * coverage status (same `updatedAt`-bearing shape as works — a bare `{ id }`
 * stub would report a renamed/moved folder as fully mirrored).
 */
export async function listFoldersForSync() {
  const folders = await store().listFolders();
  return folders
    .filter((f) => f && typeof f.id === 'string')
    .map((f) => ({ id: f.id, updatedAt: f.updatedAt }));
}

/** Merge an incoming batch of folder records from a peer (LWW, tombstone-aware). */
export async function mergeFoldersFromSync(remoteFolders, options = {}) {
  return store().mergeFoldersFromSync(remoteFolders, options);
}

/**
 * Hard-remove tombstoned folders older than the cutoff (called by tombstone GC).
 * The backend drops the row/array entry; this facade evicts each folder's
 * conflict-journal base hash. Returns `{ pruned }`.
 */
export async function pruneTombstonedFolders(olderThanMs) {
  return pruneTombstonedBodyless((ms) => store().pruneTombstonedFolders(ms), WRITERS_ROOM_FOLDER_KIND, FOLDER_ID_RE, olderThanMs);
}

/** One exercise including a tombstone (for the LWW compare + the push). */
export async function getExerciseForSync(id) {
  return store().readExercise(id, { includeDeleted: true });
}

/** Exercise ids — live only by default, or all (incl. tombstones) when asked. */
export async function listExerciseIdsForSync(options = {}) {
  return store().listExerciseIds(options);
}

/**
 * Live exercises as `{ id, updatedAt }` for the peer-sync backfill + coverage.
 * Exercises carry no stored `updatedAt`; derive the LWW key the same way
 * sanitizeExerciseForSync does (`finishedAt ?? startedAt`) so coverage compares
 * the same value the wire merge keys on.
 */
export async function listExercisesForSync() {
  const exercises = await store().listExercises();
  return exercises
    .filter((e) => e && typeof e.id === 'string')
    .map((e) => ({ id: e.id, updatedAt: e.updatedAt ?? e.finishedAt ?? e.startedAt }));
}

/** Merge an incoming batch of exercise records from a peer (LWW, tombstone-aware). */
export async function mergeExercisesFromSync(remoteExercises, options = {}) {
  return store().mergeExercisesFromSync(remoteExercises, options);
}

/** Hard-remove tombstoned exercises older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedExercises(olderThanMs) {
  return pruneTombstonedBodyless((ms) => store().pruneTombstonedExercises(ms), WRITERS_ROOM_EXERCISE_KIND, EXERCISE_ID_RE, olderThanMs);
}

/**
 * Sender-side: hash each of a work's file-primary draft bodies so the receiver
 * can pull the bytes from `/data/writers-room/works/<workId>/drafts/<draftId>.md`.
 * A body with no readable file is skipped silently (can't ship bytes we don't
 * have, mirroring hashImageForManifest). Tombstone callers pass `[]` upstream.
 */
export async function buildWorkBodyManifest(work) {
  const entries = draftAssetEntries(work);
  const out = [];
  for (const { workId, draftId } of entries) {
    const sha256 = await sha256File(wrDraftPath(workId, draftId)).catch(() => null);
    if (sha256) out.push({ kind: WRITERS_ROOM_DRAFT_ASSET_KIND, workId, draftId, sha256 });
  }
  return out;
}

/**
 * Receiver-side: given an incoming draft-body manifest, return the subset to
 * pull. Validates every workId/draftId as a path segment before any FS op — a
 * peer-supplied id is untrusted (same traversal posture as sanitizeAssetFilename
 * in the generic asset pipeline). Echoes only the sanitized fields so junk can't
 * round-trip.
 *
 * An ABSENT local body is always pulled — it can't overwrite anything, it fills
 * a fresh insert, and it lets a previously-failed pull retry on the next push.
 * A PRESENT-but-different local body is pulled ONLY when `includeMismatched`
 * (the work-record merge actually accepted the remote, i.e. remote won/inserted).
 * That gate is the data-safety boundary: when a STALE work push arrives after a
 * local edit (local `updatedAt` wins the LWW merge so the metadata is kept), the
 * sender's body hashes are the loser's — pulling them would clobber the newer
 * local prose while leaving the newer local metadata in place. So a present
 * body is only ever replaced when the receiver also took the remote's record.
 */
export async function diffWorkBodyManifest(manifest, { includeMismatched = false } = {}) {
  if (!Array.isArray(manifest)) return [];
  const missing = [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue;
    const { workId, draftId, sha256 } = entry;
    if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) continue;
    if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) continue;
    if (typeof sha256 !== 'string' || !sha256) continue;
    const sanitized = { kind: WRITERS_ROOM_DRAFT_ASSET_KIND, workId, draftId, sha256 };
    const fullPath = wrDraftPath(workId, draftId);
    if (!existsSync(fullPath)) {
      missing.push(sanitized);
      continue;
    }
    if (!includeMismatched) continue; // local body present + remote didn't win → keep local
    const localHash = await sha256File(fullPath).catch(() => null);
    if (localHash !== sha256) missing.push(sanitized);
  }
  return missing;
}
