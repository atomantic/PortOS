/**
 * Writers Room — PostgreSQL leaf I/O (#1017).
 *
 * Four tables replace the bespoke file layout:
 *   writers_room_folders        ← folders.json
 *   writers_room_works          ← works/<id>/manifest.json (minus drafts[])
 *   writers_room_draft_versions ← the manifest's drafts[] array (decomposed)
 *   writers_room_exercises      ← exercises.json
 *
 * The draft PROSE BODY stays on disk at works/<id>/drafts/<draftId>.md
 * (file-primary) — only its metadata (hash, word count, segment index, lineage)
 * becomes a row here. local.js still owns the .md read/write; this module is the
 * metadata index over them.
 *
 * PURE leaf I/O — no sanitizing, no path logic, no .md access. The store facade
 * (store.js) selects this backend; local.js reassembles a manifest (work row +
 * its draft rows → the manifest shape with an embedded drafts[]) on read and
 * splits it on write, so its public API is unchanged.
 *
 * The `data` JSONB on every table holds the FULL lossless record; the typed
 * columns are a queryable mirror (never read back into the record).
 *
 * Works FEDERATE across peers as of #1565 (record kind `writersRoomWork`, sync
 * category `writersRoomWorks`): `deleteWork` soft-deletes (tombstone) instead of
 * hard-deleting so the deletion propagates without an out-of-date peer
 * resurrecting it, and `mergeWorksFromSync` LWW-merges an incoming work the same
 * way creativeDirector/projectsDB.js does — per-record `withTransaction` +
 * `SELECT … FOR UPDATE`, conflict-journal base hash seeding, and journaling the
 * about-to-be-overwritten local version when remote wins. The `deleted`/`deletedAt`
 * columns (added in #1017) carry the tombstone; the same pair is mirrored into the
 * work row's `data` JSONB so the sync sanitizer round-trips it. Folders and
 * exercises do NOT federate yet (they lack soft-delete columns).
 */

import { query, withTransaction } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes,
} from '../../lib/conflictJournal.js';
import {
  WRITERS_ROOM_WORK_KIND, mergeWorkRecord,
  WRITERS_ROOM_FOLDER_KIND, mergeFolderRecord,
  WRITERS_ROOM_EXERCISE_KIND, mergeExerciseRecord,
} from './syncLogic.js';

/**
 * Shared per-record LWW merge for a body-less Writers Room record (folder /
 * exercise) — both federate as of #1645 (follow-up to #1565). Same posture as
 * `mergeWorksFromSync` minus the draft-row decomposition: lock the row, rebuild
 * the local record from its `data` JSONB, run the shared pure decision, journal
 * the about-to-be-overwritten local version when remote wins, and persist + seed
 * the conflict-journal base hash. `table` is a hardcoded constant (never user
 * input). Returns `{ applied, count }`.
 */
async function mergeBodylessFromSync(table, kind, mergeFn, persistFn, remoteRecords, source) {
  if (!Array.isArray(remoteRecords)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteRecords) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM ${table} WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = sel.rows[0]?.data ?? null;
      const { next, inserted, remoteWins, changed: didChange } = mergeFn(local, remote);
      if (!next) return false; // malformed remote → dropped
      if (!inserted && (!remoteWins || !didChange)) return false; // local wins, or no-op
      if (!inserted) {
        await maybeJournalBeforeOverwrite({ kind, id: next.id, local, remote: next, source });
      }
      await persistFn(client, next);
      await setSyncBaseHash(kind, next.id, contentHashForRecord(kind, next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  return changed === 0 ? { applied: false, count: 0 } : { applied: true, count: changed };
}

/** Hard-remove tombstoned rows older than the cutoff; returns their ids. */
async function pruneTombstonedRows(table, olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM ${table}
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  const ids = rows.map((r) => r.id);
  return { pruned: ids.length, ids };
}

// ---------- folders ----------

/** Every LIVE folder row's `data` JSONB, ordered for the library tree. */
export async function listFolders() {
  const { rows } = await query(
    `SELECT data FROM writers_room_folders WHERE deleted = FALSE ORDER BY sort_order, created_at`,
  );
  return rows.map((r) => r.data);
}

/**
 * One folder's `data` JSONB, or null. Live only by default; `includeDeleted`
 * surfaces a tombstoned folder (federation reads it to compare `updatedAt` + push
 * the tombstone).
 */
export async function readFolder(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT data FROM writers_room_folders WHERE id = $1`
      : `SELECT data FROM writers_room_folders WHERE id = $1 AND deleted = FALSE`,
    [id],
  );
  return rows[0]?.data ?? null;
}

/** Every folder id — live only by default, or all (incl. tombstones) when asked. */
export async function listFolderIds({ includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT id FROM writers_room_folders`
      : `SELECT id FROM writers_room_folders WHERE deleted = FALSE`,
  );
  return rows.map((r) => r.id);
}

/**
 * Upsert one folder on an open transaction client. The `data` JSONB mirrors the
 * normalized soft-delete pair so `readFolder(includeDeleted)` surfaces a tombstone
 * to the sync sanitizer (the columns alone are never read back into `data`).
 */
function persistFolderTx(client, folder) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(folder?.createdAt, now);
  const deleted = folder?.deleted === true;
  const deletedAt = deleted ? mirrorTimestamp(folder?.deletedAt, now) : null;
  const folderData = { ...folder, deleted, deletedAt };
  return client.query(
    `INSERT INTO writers_room_folders (id, parent_id, name, sort_order, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       parent_id = EXCLUDED.parent_id,
       name = EXCLUDED.name,
       sort_order = EXCLUDED.sort_order,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      folder.id,
      typeof folder?.parentId === 'string' && folder.parentId ? folder.parentId : null,
      String(folder?.name ?? ''),
      Number.isInteger(folder?.sortOrder) ? folder.sortOrder : 0,
      JSON.stringify(folderData),
      createdAt,
      mirrorTimestamp(folder?.updatedAt, createdAt),
      deleted,
      deletedAt,
    ],
  );
}

/** Upsert one folder. `created_at` is preserved on conflict. */
export async function writeFolder(folder) {
  await withTransaction((client) => persistFolderTx(client, folder));
}

/**
 * Soft-delete a folder (tombstone) so the deletion federates and an out-of-date
 * peer can't resurrect it via the LWW merge (#1645). Idempotent — a missing or
 * already-deleted folder is a no-op (the caller 404s a missing folder first).
 */
export async function deleteFolder(id) {
  await withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM writers_room_folders WHERE id = $1 FOR UPDATE`, [id]);
    const current = sel.rows[0]?.data;
    if (!current || current.deleted === true) return;
    const now = new Date().toISOString();
    await persistFolderTx(client, { ...current, deleted: true, deletedAt: now, updatedAt: now });
  });
}

/** Merge an incoming batch of folder records from a peer (LWW, tombstone-aware). */
export async function mergeFoldersFromSync(remoteFolders, { source = { via: 'sync', peerId: null } } = {}) {
  return mergeBodylessFromSync('writers_room_folders', WRITERS_ROOM_FOLDER_KIND, mergeFolderRecord, persistFolderTx, remoteFolders, source);
}

/** Hard-remove tombstoned folders whose `deleted_at` is older than the cutoff. */
export async function pruneTombstonedFolders(olderThanMs) {
  return pruneTombstonedRows('writers_room_folders', olderThanMs);
}

// ---------- exercises ----------

/** Every LIVE exercise row's `data` JSONB, newest sprint first. */
export async function listExercises() {
  const { rows } = await query(
    `SELECT data FROM writers_room_exercises WHERE deleted = FALSE ORDER BY started_at DESC NULLS LAST`,
  );
  return rows.map((r) => r.data);
}

/** One exercise's `data` JSONB, or null (tombstone surfaced when includeDeleted). */
export async function readExercise(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT data FROM writers_room_exercises WHERE id = $1`
      : `SELECT data FROM writers_room_exercises WHERE id = $1 AND deleted = FALSE`,
    [id],
  );
  return rows[0]?.data ?? null;
}

/** Every exercise id — live only by default, or all (incl. tombstones) when asked. */
export async function listExerciseIds({ includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT id FROM writers_room_exercises`
      : `SELECT id FROM writers_room_exercises WHERE deleted = FALSE`,
  );
  return rows.map((r) => r.id);
}

/** Upsert one exercise on an open transaction client (mirrors the soft-delete pair into `data`). */
function persistExerciseTx(client, exercise) {
  const deleted = exercise?.deleted === true;
  const deletedAt = deleted ? mirrorTimestamp(exercise?.deletedAt, new Date().toISOString()) : null;
  const exerciseData = { ...exercise, deleted, deletedAt };
  return client.query(
    `INSERT INTO writers_room_exercises (id, work_id, status, data, started_at, finished_at, deleted, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       work_id = EXCLUDED.work_id,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      exercise.id,
      typeof exercise?.workId === 'string' && exercise.workId ? exercise.workId : null,
      typeof exercise?.status === 'string' ? exercise.status.slice(0, 16) : null,
      JSON.stringify(exerciseData),
      mirrorTimestamp(exercise?.startedAt, null),
      mirrorTimestamp(exercise?.finishedAt, null),
      deleted,
      deletedAt,
    ],
  );
}

/** Upsert one exercise session. */
export async function writeExercise(exercise) {
  await withTransaction((client) => persistExerciseTx(client, exercise));
}

/** Merge an incoming batch of exercise records from a peer (LWW, tombstone-aware). */
export async function mergeExercisesFromSync(remoteExercises, { source = { via: 'sync', peerId: null } } = {}) {
  return mergeBodylessFromSync('writers_room_exercises', WRITERS_ROOM_EXERCISE_KIND, mergeExerciseRecord, persistExerciseTx, remoteExercises, source);
}

/** Hard-remove tombstoned exercises whose `deleted_at` is older than the cutoff. */
export async function pruneTombstonedExercises(olderThanMs) {
  return pruneTombstonedRows('writers_room_exercises', olderThanMs);
}

// ---------- works + draft versions ----------

/**
 * Map a work row + its draft rows back to the manifest shape local.js expects:
 * the full work record from `data` with `drafts[]` rebuilt from the
 * draft-version rows (ordered by created_at to preserve version lineage order).
 * Returns null for a missing/soft-deleted work.
 */
function rowsToManifest(workRow, draftRows) {
  if (!workRow) return null;
  const manifest = { ...workRow.data };
  manifest.drafts = draftRows.map((d) => d.data);
  return manifest;
}

/**
 * One work's manifest (rebuilt from its row + draft rows), or null. Live works
 * only by default; `includeDeleted` surfaces a tombstoned work too (federation
 * reads it to compare `updatedAt` and to push the tombstone to peers).
 */
export async function readWork(id, { includeDeleted = false } = {}) {
  const work = await query(
    includeDeleted
      ? `SELECT data FROM writers_room_works WHERE id = $1`
      : `SELECT data FROM writers_room_works WHERE id = $1 AND deleted = FALSE`,
    [id],
  );
  if (!work.rows[0]) return null;
  const drafts = await query(
    `SELECT data FROM writers_room_draft_versions WHERE work_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return rowsToManifest(work.rows[0], drafts.rows);
}

/** Every work id — live only by default, or all (incl. tombstones) when asked. */
export async function listWorkIds({ includeDeleted = false } = {}) {
  const { rows } = await query(
    includeDeleted
      ? `SELECT id FROM writers_room_works`
      : `SELECT id FROM writers_room_works WHERE deleted = FALSE`,
  );
  return rows.map((r) => r.id);
}

/** Every live work's manifest, rebuilt with its drafts[] — one pair of queries. */
export async function listWorks() {
  const works = await query(
    `SELECT id, data FROM writers_room_works WHERE deleted = FALSE`,
  );
  if (works.rows.length === 0) return [];
  const drafts = await query(
    `SELECT work_id, data FROM writers_room_draft_versions
     WHERE work_id = ANY($1::text[]) ORDER BY created_at, id`,
    [works.rows.map((r) => r.id)],
  );
  const draftsByWork = new Map();
  for (const d of drafts.rows) {
    if (!draftsByWork.has(d.work_id)) draftsByWork.set(d.work_id, []);
    draftsByWork.get(d.work_id).push({ data: d.data });
  }
  return works.rows.map((w) => rowsToManifest(w, draftsByWork.get(w.id) || []));
}

/**
 * Cheap live-work tally (#2729) — the count listWorks().length used to pay for
 * by running the drafts query and rebuilding every work's full manifest.
 *
 * `deleted` here is a real column (not a JSONB mirror), and it is the SAME
 * predicate listWorks() above filters on — so the two agree by construction.
 * Unlike universeBuilder, no sanitizer sits between the row and the caller on
 * this path, so there is no drop-on-read case to reconcile.
 */
export async function countWorks() {
  const { rows } = await query(
    `SELECT COUNT(*) AS count FROM writers_room_works WHERE deleted = FALSE`,
  );
  return parseInt(rows[0].count, 10);
}

// Bind tuple for one draft-version row from a manifest draft entry.
function draftBinds(workId, draft) {
  return [
    draft.id,
    workId,
    typeof draft?.label === 'string' ? draft.label : null,
    String(draft?.contentFile ?? ''),
    typeof draft?.contentHash === 'string' ? draft.contentHash : null,
    Number.isInteger(draft?.wordCount) ? draft.wordCount : 0,
    JSON.stringify(Array.isArray(draft?.segmentIndex) ? draft.segmentIndex : []),
    typeof draft?.createdFromVersionId === 'string' ? draft.createdFromVersionId : null,
    JSON.stringify(draft),
    mirrorTimestamp(draft?.createdAt, new Date().toISOString()),
  ];
}

/**
 * Upsert a work manifest AND its draft versions atomically. The manifest's
 * `drafts[]` array is the authoritative version set: we upsert each draft row
 * and DELETE any draft rows for this work no longer in the array (covers a
 * version delete). `created_at` is preserved on conflict for both the work and
 * each draft. Runs in a transaction so a half-written work never leaves orphan
 * draft rows or a draft set out of sync with the manifest.
 */
export async function writeWork(manifest) {
  await withTransaction((client) => persistWorkTx(client, manifest));
  return manifest;
}

/**
 * Upsert a work manifest + its draft rows on an open transaction client. Shared
 * by `writeWork` (its own transaction) and `mergeWorksFromSync` (the per-record
 * merge transaction). The work row's `data` holds the manifest WITHOUT the
 * drafts[] array — the draft rows are authoritative — but WITH the normalized
 * soft-delete pair so the sync sanitizer round-trips a tombstone. Honors
 * `manifest.deleted`/`manifest.deletedAt` (default live) so a tombstone merge
 * persists the deletion instead of resurrecting the row.
 */
async function persistWorkTx(client, manifest) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(manifest?.createdAt, now);
  // `drafts` absent (not an array) means "don't touch the draft rows" — the
  // soft-delete tombstone path persists only the work row and must KEEP the
  // existing draft rows (+ .md bodies) until hard-prune. An empty array still
  // means "authoritative empty set → delete all draft rows" (the original
  // behavior writeWork relied on for a version delete).
  const hasDrafts = Array.isArray(manifest?.drafts);
  const drafts = hasDrafts ? manifest.drafts : [];
  const deleted = manifest?.deleted === true;
  const deletedAt = deleted ? mirrorTimestamp(manifest?.deletedAt, now) : null;
  const { drafts: _omit, ...rest } = manifest;
  // Mirror the tombstone trio INTO the JSONB so readWork(includeDeleted) surfaces
  // it to the sync sanitizer (the columns alone are never read back into data).
  const workData = { ...rest, deleted, deletedAt };
  await client.query(
    `INSERT INTO writers_room_works
       (id, folder_id, title, kind, status, active_draft_version_id,
        pipeline_series_id, pipeline_issue_id, cd_project_id, media_collection_id,
        data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET
       folder_id = EXCLUDED.folder_id,
       title = EXCLUDED.title,
       kind = EXCLUDED.kind,
       status = EXCLUDED.status,
       active_draft_version_id = EXCLUDED.active_draft_version_id,
       pipeline_series_id = EXCLUDED.pipeline_series_id,
       pipeline_issue_id = EXCLUDED.pipeline_issue_id,
       cd_project_id = EXCLUDED.cd_project_id,
       media_collection_id = EXCLUDED.media_collection_id,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      manifest.id,
      typeof manifest?.folderId === 'string' && manifest.folderId ? manifest.folderId : null,
      String(manifest?.title ?? ''),
      typeof manifest?.kind === 'string' ? manifest.kind.slice(0, 32) : null,
      typeof manifest?.status === 'string' ? manifest.status.slice(0, 32) : null,
      typeof manifest?.activeDraftVersionId === 'string' ? manifest.activeDraftVersionId : null,
      typeof manifest?.pipelineSeriesId === 'string' ? manifest.pipelineSeriesId : null,
      typeof manifest?.pipelineIssueId === 'string' ? manifest.pipelineIssueId : null,
      typeof manifest?.cdProjectId === 'string' ? manifest.cdProjectId : null,
      typeof manifest?.mediaCollectionId === 'string' ? manifest.mediaCollectionId : null,
      JSON.stringify(workData),
      createdAt,
      mirrorTimestamp(manifest?.updatedAt, createdAt),
      deleted,
      deletedAt,
    ],
  );
  if (!hasDrafts) return; // tombstone-only persist — leave draft rows untouched
  for (const draft of drafts) {
    if (!draft || typeof draft.id !== 'string') continue;
    await client.query(
      `INSERT INTO writers_room_draft_versions
         (id, work_id, label, content_file, content_hash, word_count,
          segment_index, created_from_version_id, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)
       ON CONFLICT (id) DO UPDATE SET
         work_id = EXCLUDED.work_id,
         label = EXCLUDED.label,
         content_file = EXCLUDED.content_file,
         content_hash = EXCLUDED.content_hash,
         word_count = EXCLUDED.word_count,
         segment_index = EXCLUDED.segment_index,
         created_from_version_id = EXCLUDED.created_from_version_id,
         data = EXCLUDED.data`,
      draftBinds(manifest.id, draft),
    );
  }
  // Prune draft rows that are no longer part of the manifest (version delete).
  const keepIds = drafts.map((d) => d?.id).filter((id) => typeof id === 'string');
  if (keepIds.length > 0) {
    await client.query(
      `DELETE FROM writers_room_draft_versions WHERE work_id = $1 AND id <> ALL($2::text[])`,
      [manifest.id, keepIds],
    );
  } else {
    await client.query(`DELETE FROM writers_room_draft_versions WHERE work_id = $1`, [manifest.id]);
  }
}

/**
 * Soft-delete a work (tombstone) so the deletion federates and an out-of-date
 * peer can't resurrect it via the LWW merge (#1565). The work row + its draft
 * rows + the on-disk .md bodies all stay until tombstone GC hard-prunes them
 * (`pruneTombstonedWorks`); `deleted`/`deletedAt`/`updatedAt` stamp now so the
 * tombstone wins on merge. Idempotent: a missing/already-deleted work is a no-op
 * (the caller already 404s a missing work before reaching here).
 */
export async function deleteWork(id) {
  await withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM writers_room_works WHERE id = $1 FOR UPDATE`, [id]);
    const current = sel.rows[0]?.data;
    if (!current || current.deleted === true) return;
    const now = new Date().toISOString();
    await persistWorkTx(client, { ...current, drafts: undefined, deleted: true, deletedAt: now, updatedAt: now });
  });
}

/**
 * Merge an incoming batch of work records from a peer (per-record push). Each
 * record's read-modify-write runs inside `withTransaction` + `SELECT … FOR
 * UPDATE` so a concurrent local edit can't lose to (or clobber) the merge. LWW
 * on `updatedAt` (tombstone-aware) via the shared `mergeWorkRecord` decision —
 * identical to the file backend so the two can't drift. Mirrors
 * `mergeProjectsFromSync`: seeds/advances the conflict-journal base hash and
 * journals the about-to-be-overwritten local version when remote wins
 * (best-effort, never throws into the merge). Returns `{ applied, count }`.
 */
export async function mergeWorksFromSync(remoteWorks, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteWorks)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteWorks) {
    const applied = await withTransaction(async (client) => {
      // Lock the work row, then rebuild the local manifest (row data + its draft
      // rows) so the LWW comparison + journaled snapshot see the full record.
      const sel = await client.query(`SELECT data FROM writers_room_works WHERE id = $1 FOR UPDATE`, [remote?.id]);
      let local = null;
      if (sel.rows[0]) {
        const draftRows = await client.query(
          `SELECT data FROM writers_room_draft_versions WHERE work_id = $1 ORDER BY created_at, id`,
          [remote.id],
        );
        local = rowsToManifest(sel.rows[0], draftRows.rows);
      }
      const { next, inserted, remoteWins, changed: didChange } = mergeWorkRecord(local, remote);
      if (!next) return false; // malformed remote → dropped
      if (inserted) {
        await persistWorkTx(client, next);
        await setSyncBaseHash(WRITERS_ROOM_WORK_KIND, next.id, contentHashForRecord(WRITERS_ROOM_WORK_KIND, next));
        return true;
      }
      if (!remoteWins || !didChange) return false; // local wins, or no-op
      await maybeJournalBeforeOverwrite({ kind: WRITERS_ROOM_WORK_KIND, id: next.id, local, remote: next, source });
      await persistWorkTx(client, next);
      await setSyncBaseHash(WRITERS_ROOM_WORK_KIND, next.id, contentHashForRecord(WRITERS_ROOM_WORK_KIND, next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned works (+ their draft rows) whose deletedAt is older than
 * the cutoff. Called by tombstone GC once every subscribed peer has acked the
 * deletion. Returns the pruned ids so the facade (sync.js) can rm the on-disk .md
 * dirs + evict each work's conflict-journal base hash. Mirrors
 * `pruneTombstonedProjects` (the base-hash eviction lives in the facade here
 * because the .md cleanup is a facade concern too).
 */
export async function pruneTombstonedWorks(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const ids = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `DELETE FROM writers_room_works
       WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
       RETURNING id`,
      [cutoffIso],
    );
    const pruned = rows.map((r) => r.id);
    if (pruned.length > 0) {
      await client.query(`DELETE FROM writers_room_draft_versions WHERE work_id = ANY($1::text[])`, [pruned]);
    }
    return pruned;
  });
  return { pruned: ids.length, ids };
}

/**
 * Every live draft-version row (work_id + the metadata) for the restore-coherence
 * check — every row's content_file must exist on disk + content_hash must match.
 */
export async function listDraftVersionsForCoherence() {
  const { rows } = await query(
    `SELECT v.id, v.work_id, v.content_file, v.content_hash
       FROM writers_room_draft_versions v
       JOIN writers_room_works w ON w.id = v.work_id AND w.deleted = FALSE
       ORDER BY v.work_id, v.created_at`,
  );
  return rows.map((r) => ({
    id: r.id, workId: r.work_id, contentFile: r.content_file, contentHash: r.content_hash,
  }));
}
