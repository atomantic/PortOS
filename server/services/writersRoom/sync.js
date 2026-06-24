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
} from './syncLogic.js';
import { WORK_ID_RE, DRAFT_ID_RE, wrWorkDir, wrDraftPath } from './_shared.js';

const store = () => writersRoomStore();

/** One work's manifest including a tombstone (for the LWW compare + the push). */
export async function getWorkForSync(id) {
  return store().readWork(id, { includeDeleted: true });
}

/** Work ids — live only by default, or all (incl. tombstones) when asked. */
export async function listWorkIdsForSync(options = {}) {
  return store().listWorkIds(options);
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
 * Receiver-side: given an incoming draft-body manifest, return the subset whose
 * local `.md` is absent OR whose hash differs (peer has a newer body). Validates
 * every workId/draftId as a path segment before any FS op — a peer-supplied id
 * is untrusted (same traversal posture as sanitizeAssetFilename in the generic
 * asset pipeline). Echoes only the sanitized fields so junk can't round-trip.
 */
export async function diffWorkBodyManifest(manifest) {
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
    const localHash = await sha256File(fullPath).catch(() => null);
    if (localHash !== sha256) missing.push(sanitized);
  }
  return missing;
}
