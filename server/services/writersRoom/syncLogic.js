/**
 * Writers Room — pure record transforms for cross-peer federation (#1565).
 *
 * Works (PostgreSQL `writers_room_works` + decomposed `writers_room_draft_versions`)
 * federate across peers via the per-record peer-sync push pipeline — record kind
 * `writersRoomWork`, sync category `writersRoomWorks`. A federated work record IS
 * the manifest local.js round-trips: work metadata + the active-draft pointer +
 * the version history (`drafts[]` of draft-version METADATA). The draft PROSE
 * BODIES stay file-primary (`works/<workId>/drafts/<draftId>.md`) and replicate
 * separately as assets via the body manifest in sync.js — never round-tripped
 * through this record.
 *
 * This module is storage-agnostic so the PostgreSQL backend (db.js) and the
 * test/dev file backend (store.js) can never drift in how an incoming work is
 * sanitized or LWW-merged. Mirrors creativeDirector/projectsLogic.js.
 */

import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import { WORK_ID_RE, DRAFT_ID_RE, FOLDER_ID_RE, EXERCISE_ID_RE } from './_shared.js';

const isStr = (v) => typeof v === 'string';

// The peer-sync record kind + the asset kind its draft bodies ride. Exported so
// peerSync.js / sync.js reference one source of truth instead of bare strings.
export const WRITERS_ROOM_WORK_KIND = 'writersRoomWork';
export const WRITERS_ROOM_DRAFT_ASSET_KIND = 'writers-room-draft';
// Folders + exercises federate too (#1645 — follow-up to #1565). Both are
// body-less records (no file-primary `.md`, no asset manifest), so their wiring
// is the same per-record LWW push as works minus the draft-body machinery.
export const WRITERS_ROOM_FOLDER_KIND = 'writersRoomFolder';
export const WRITERS_ROOM_EXERCISE_KIND = 'writersRoomExercise';

/**
 * Normalize a raw work manifest into the canonical stored shape for a sync
 * round-trip. Returns null for a non-object or a record without a usable id
 * (the "drop on the floor" contract every sanitizer shares, so a malformed peer
 * payload can't land). The work body (title/kind/status/drafts/links/liveMode)
 * is passed through verbatim — it is all app-authored data — while the LWW key
 * (`updatedAt`) and the soft-delete trio are normalized so the wire/hash shape
 * is stable regardless of on-disk key position. Mirrors `sanitizeProjectForSync`.
 */
export function sanitizeWorkForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // The id is used as a filesystem path segment (works/<id>/...) and the path
  // helpers enforce WORK_ID_RE — so drop a peer-supplied id that isn't a valid
  // work id BEFORE merge/persist, rather than letting it throw in the file
  // backend's saveManifest or plant an unaddressable PG row.
  if (!isStr(raw.id) || !WORK_ID_RE.test(raw.id)) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  // Draft-version ids are ALSO filesystem path segments (drafts/<draftId>.md), so
  // ALWAYS normalize to a filtered array — drop any draft whose id isn't
  // DRAFT_ID_RE-valid (and coerce a missing/non-array `drafts` to []). Otherwise
  // a malformed peer payload persists a work whose body read throws in
  // wrDraftPath(), or whose `manifest.drafts` isn't the array local readers
  // assume. Clamp the active pointer to a surviving draft (or null). Legitimate
  // works (live or tombstone) always carry a drafts[] array, so this is a no-op
  // for them — only malformed input is reshaped.
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
 * LWW merge decision for one incoming work record against the local copy —
 * mirrors `mergeProjectRecord` (creativeDirector/projectsLogic.js):
 *   - remote sanitized here (drop-on-floor on a malformed payload → `next: null`).
 *   - No local counterpart → insert the remote verbatim (`inserted: true`).
 *   - Both present → newer `updatedAt` wins (`compareNewerWins`: epoch-ms,
 *     unparseable-loses, tie → local). Tombstones ride the same path.
 * Returns `{ next, inserted, remoteWins, changed }`; `changed` is false when the
 * winner is byte-identical to local. The whole manifest is LWW-overwritten (no
 * field-union), so it is hashed in full by `contentHashForRecord`.
 */
export function mergeWorkRecord(local, remoteRaw) {
  const remote = sanitizeWorkForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  // The remote arrives wire-stripped of `liveMode.usage`/`renderUsage` (local-only
  // daily budgets — see sanitizeRecordForWire). When the remote wins the LWW,
  // carry the RECEIVER's own counters forward onto it so a peer's manuscript edit
  // doesn't reset this machine's budget state. When local wins, `next` is already
  // local (counters intact).
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
 * The draft-version → file-body asset references a work carries: one entry per
 * draft version whose id + work id are valid path segments. Pure (no disk I/O) —
 * sync.js hashes the on-disk `.md` per entry to build the wire manifest, and the
 * receiver resolves each `{ workId, draftId }` to `works/<workId>/drafts/<draftId>.md`.
 * Skips drafts with a malformed id so a hand-edited/corrupt manifest can't smuggle
 * a path-traversal filename into the asset pull.
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
 * LWW merge decision for a body-less record (folder/exercise) against the local
 * copy. Same contract as `mergeWorkRecord` minus the live-counter carry-forward
 * (these records have no local-only counters): the remote is sanitized here
 * (drop-on-floor → `next: null`), a missing local inserts the remote, and
 * otherwise newer `updatedAt` wins (`compareNewerWins`: epoch-ms, unparseable-
 * loses, tie → local). The whole record is LWW-overwritten (no field-union) and
 * hashed in full by `contentHashForRecord`. Tombstones ride the same path.
 */
function mergeBodylessRecord(local, remoteRaw, sanitize) {
  const remote = sanitize(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  // Derive the LOCAL lww key through the SAME sanitizer as the remote so the
  // compare is symmetric. Exercises predate federation and may carry no stored
  // `updatedAt` (the sanitizer derives it from `finishedAt ?? startedAt`); the
  // stored local record is raw (unsanitized), so an `undefined` local.updatedAt
  // would lose to ANY parseable remote — `compareNewerWins` treats an
  // unparseable incumbent as always-loses — letting a STALE push clobber a
  // newer local. `sanitize(local)` can't be null here (local came from our own
  // store with a valid id); fall back to the raw key defensively.
  const localKey = sanitize(local)?.updatedAt ?? local.updatedAt;
  const remoteWins = compareNewerWins(remote.updatedAt, localKey);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/**
 * Normalize a raw folder into the canonical stored shape for a sync round-trip.
 * Drops a non-object or a record without a usable `wr-folder-` id (the
 * drop-on-floor contract). The body (`name`/`parentId`/`sortOrder`) passes
 * through verbatim; the LWW key (`updatedAt`) + soft-delete trio are normalized
 * so the wire/hash shape is stable regardless of on-disk key position.
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
 * federation and carry no `updatedAt`/`createdAt` — derive both from the existing
 * timestamps (`startedAt` is the creation moment; `finishedAt ?? startedAt` is the
 * last mutation) so an OLD pre-federation exercise still gets a stable LWW key and
 * a fresh one (stamped by local.js) round-trips unchanged. Soft-delete trio is
 * normalized for the tombstone-aware merge even though no current path deletes an
 * exercise (a future peer might).
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
