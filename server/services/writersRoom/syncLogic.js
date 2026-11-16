/**
 * Writers Room — pure record transforms for cross-peer federation (#1565).
 *
 * Works federate via the per-record peer-sync push pipeline (record kind
 * `writersRoomWork`, sync category `writersRoomWorks`). A federated work record IS
 * the manifest local.js round-trips: metadata + active-draft pointer + version
 * history (`drafts[]` metadata). Draft PROSE BODIES stay file-primary
 * (`works/<workId>/drafts/<draftId>.md`) and replicate separately as assets via
 * the body manifest in sync.js.
 *
 * Storage-agnostic so the PostgreSQL backend (db.js) and the file backend
 * (store.js) can't drift in sanitizing or LWW-merging an incoming work. Mirrors
 * creativeDirector/projectsLogic.js.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import { WORK_ID_RE, DRAFT_ID_RE, FOLDER_ID_RE, EXERCISE_ID_RE } from './_shared.js';
import { isStr } from '../../lib/textUtils.js';

// The peer-sync record kind + the asset kind its draft bodies ride. Exported so
// peerSync.js / sync.js reference one source of truth instead of bare strings.
export const WRITERS_ROOM_WORK_KIND = 'writersRoomWork';
export const WRITERS_ROOM_DRAFT_ASSET_KIND = 'writers-room-draft';
// Folders + exercises federate too (#1645): body-less records (no `.md`, no asset
// manifest), so the same per-record LWW push minus the draft-body machinery.
export const WRITERS_ROOM_FOLDER_KIND = 'writersRoomFolder';
export const WRITERS_ROOM_EXERCISE_KIND = 'writersRoomExercise';

/**
 * Normalize a raw work manifest into the canonical stored shape for a sync
 * round-trip. Null for a non-object or an id-less record (the drop-on-the-floor
 * contract every sanitizer shares). The work body is passed through verbatim;
 * the LWW key (`updatedAt`) and soft-delete trio are normalized so the wire/hash
 * shape is stable. Mirrors `sanitizeProjectForSync`.
 */
export function sanitizeWorkForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // The id is a filesystem path segment (works/<id>/...): drop a peer-supplied id
  // failing WORK_ID_RE BEFORE merge/persist instead of throwing in saveManifest.
  if (!isStr(raw.id) || !WORK_ID_RE.test(raw.id)) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  // Draft-version ids are ALSO filesystem path segments, so ALWAYS normalize to a
  // filtered array (drop drafts whose id isn't DRAFT_ID_RE-valid; coerce a
  // missing/non-array `drafts` to []) or a malformed payload persists a work whose
  // body read throws in wrDraftPath(). Clamp the active pointer to a surviving
  // draft (or null). A no-op for legitimate works.
  const out = { ...raw, createdAt, updatedAt, deleted, deletedAt };
  const draftsArray = Array.isArray(raw.drafts) ? raw.drafts : [];
  out.drafts = draftsArray.filter((d) => d && typeof d === 'object' && isStr(d.id) && DRAFT_ID_RE.test(d.id));
  const ids = new Set(out.drafts.map((d) => d.id));
  out.activeDraftVersionId = isStr(raw.activeDraftVersionId) && ids.has(raw.activeDraftVersionId)
    ? raw.activeDraftVersionId
    : (out.drafts[0]?.id ?? null);
  return out;
}

/**
 * LWW merge decision for one incoming work record against the local copy (mirrors
 * `mergeProjectRecord` in creativeDirector/projectsLogic.js): the remote is
 * sanitized (malformed → `next: null`); no local → insert verbatim; both present →
 * newer `updatedAt` wins (`compareNewerWins`: unparseable-loses, tie → local),
 * tombstones included. Returns `{ next, inserted, remoteWins, changed }`;
 * `changed` is false when the winner is byte-identical to local. Whole-manifest
 * overwrite (no field-union), hashed in full by `contentHashForRecord`.
 */
export function mergeWorkRecord(local, remoteRaw) {
  const remote = sanitizeWorkForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  // The remote arrives wire-stripped of `liveMode.usage`/`renderUsage` (local-only
  // daily budgets, see sanitizeRecordForWire). When the remote wins, carry the
  // RECEIVER's counters onto it so a peer's edit doesn't reset this machine's budget.
  const next = remoteWins ? preserveLocalLiveCounters(remote, local) : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/** Re-attach the receiver's local-only live-mode counters onto a winning remote. */
function preserveLocalLiveCounters(remote, local) {
  const localLive = local?.liveMode;
  if (!localLive || typeof localLive !== 'object' || Array.isArray(localLive)) return remote;
  const carried = {};
  if (localLive.usage !== undefined) carried.usage = localLive.usage;
  if (localLive.renderUsage !== undefined) carried.renderUsage = localLive.renderUsage;
  if (Object.keys(carried).length === 0) return remote;
  return { ...remote, liveMode: { ...(remote.liveMode || {}), ...carried } };
}

/**
 * The draft-version → file-body asset references a work carries, one per draft
 * whose id + work id are valid path segments. Pure: sync.js hashes the on-disk
 * `.md` per entry, and the receiver resolves `{ workId, draftId }` to
 * `works/<workId>/drafts/<draftId>.md`. Skips malformed ids so a corrupt manifest
 * can't smuggle a path-traversal filename into the asset pull.
 */
export function draftAssetEntries(work) {
  const drafts = Array.isArray(work?.drafts) ? work.drafts : [];
  const workId = work?.id;
  if (!isStr(workId) || !WORK_ID_RE.test(workId)) return [];
  const out = [];
  for (const d of drafts) {
    const draftId = d?.id;
    if (!isStr(draftId) || !DRAFT_ID_RE.test(draftId)) continue;
    out.push({ workId, draftId });
  }
  return out;
}

// ---------- folders + exercises (body-less records) ----------

/**
 * LWW merge decision for a body-less record (folder/exercise): same contract as
 * `mergeWorkRecord` minus the live-counter carry-forward. The remote is sanitized
 * (drop-on-floor → `next: null`), a missing local inserts, otherwise newer
 * `updatedAt` wins. Whole-record overwrite, hashed in full by `contentHashForRecord`.
 */
function mergeBodylessRecord(local, remoteRaw, sanitize) {
  const remote = sanitize(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  // Derive the LOCAL lww key through the SAME sanitizer as the remote so the compare
  // is symmetric: exercises may carry no stored `updatedAt`, and an undefined local
  // key would lose to ANY parseable remote, letting a STALE push clobber a newer
  // local. Falls back to the raw key defensively.
  const localKey = sanitize(local)?.updatedAt ?? local.updatedAt;
  const remoteWins = compareNewerWins(remote.updatedAt, localKey);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Normalize a raw folder into the canonical stored shape for a sync round-trip.
 * Drops a non-object or a record without a usable `wr-folder-` id. The body
 * passes through verbatim; the LWW key + soft-delete trio are normalized so the
 * wire/hash shape is stable.
 */
export function sanitizeFolderForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !FOLDER_ID_RE.test(raw.id)) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return { ...raw, createdAt, updatedAt, deleted, deletedAt };
}

/**
 * Normalize a raw exercise into the canonical stored shape for a sync round-trip.
 * Drops a non-object or a record without a usable `wr-ex-` id. Exercises predate
 * federation and carry no `updatedAt`/`createdAt`, so both derive from existing
 * timestamps (`startedAt` is creation; `finishedAt ?? startedAt` the last
 * mutation) for a stable LWW key. The soft-delete trio is normalized for the
 * tombstone-aware merge.
 */
export function sanitizeExerciseForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !EXERCISE_ID_RE.test(raw.id)) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt
    : (isStr(raw.startedAt) ? raw.startedAt : new Date().toISOString());
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt
    : (isStr(raw.finishedAt) ? raw.finishedAt : createdAt);
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return { ...raw, createdAt, updatedAt, deleted, deletedAt };
}

/** LWW merge decision for one incoming folder record. */
export function mergeFolderRecord(local, remoteRaw) {
  return mergeBodylessRecord(local, remoteRaw, sanitizeFolderForSync);
}

/** LWW merge decision for one incoming exercise record. */
export function mergeExerciseRecord(local, remoteRaw) {
  return mergeBodylessRecord(local, remoteRaw, sanitizeExerciseForSync);
}
