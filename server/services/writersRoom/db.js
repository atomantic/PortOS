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
 * columns are a queryable mirror (never read back into the record). Writers Room
 * is NOT federated, so there is no ephemeral/sync column and no mutation epoch.
 */

import { query, withTransaction } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

// ---------- folders ----------

/** Every folder row's `data` JSONB, ordered for the library tree. */
export async function listFolders() {
  const { rows } = await query(
    `SELECT data FROM writers_room_folders ORDER BY sort_order, created_at`,
  );
  return rows.map((r) => r.data);
}

/** Upsert one folder. `created_at` is preserved on conflict. */
export async function writeFolder(folder) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(folder?.createdAt, now);
  await query(
    `INSERT INTO writers_room_folders (id, parent_id, name, sort_order, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       parent_id = EXCLUDED.parent_id,
       name = EXCLUDED.name,
       sort_order = EXCLUDED.sort_order,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      folder.id,
      typeof folder?.parentId === 'string' && folder.parentId ? folder.parentId : null,
      String(folder?.name ?? ''),
      Number.isInteger(folder?.sortOrder) ? folder.sortOrder : 0,
      JSON.stringify(folder),
      createdAt,
      mirrorTimestamp(folder?.updatedAt, createdAt),
    ],
  );
}

/** Hard-delete a folder. Idempotent — missing row is a no-op. */
export async function deleteFolder(id) {
  await query(`DELETE FROM writers_room_folders WHERE id = $1`, [id]);
}

// ---------- exercises ----------

/** Every exercise row's `data` JSONB, newest sprint first. */
export async function listExercises() {
  const { rows } = await query(
    `SELECT data FROM writers_room_exercises ORDER BY started_at DESC NULLS LAST`,
  );
  return rows.map((r) => r.data);
}

/** Upsert one exercise session. */
export async function writeExercise(exercise) {
  await query(
    `INSERT INTO writers_room_exercises (id, work_id, status, data, started_at, finished_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       work_id = EXCLUDED.work_id,
       status = EXCLUDED.status,
       data = EXCLUDED.data,
       started_at = EXCLUDED.started_at,
       finished_at = EXCLUDED.finished_at`,
    [
      exercise.id,
      typeof exercise?.workId === 'string' && exercise.workId ? exercise.workId : null,
      typeof exercise?.status === 'string' ? exercise.status.slice(0, 16) : null,
      JSON.stringify(exercise),
      mirrorTimestamp(exercise?.startedAt, null),
      mirrorTimestamp(exercise?.finishedAt, null),
    ],
  );
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

/** One work's manifest (rebuilt from its row + draft rows), or null. */
export async function readWork(id) {
  const work = await query(
    `SELECT data FROM writers_room_works WHERE id = $1 AND deleted = FALSE`,
    [id],
  );
  if (!work.rows[0]) return null;
  const drafts = await query(
    `SELECT data FROM writers_room_draft_versions WHERE work_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return rowsToManifest(work.rows[0], drafts.rows);
}

/** Every live work id (non-deleted). */
export async function listWorkIds() {
  const { rows } = await query(
    `SELECT id FROM writers_room_works WHERE deleted = FALSE`,
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
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(manifest?.createdAt, now);
  const drafts = Array.isArray(manifest?.drafts) ? manifest.drafts : [];
  // The work row's `data` holds the manifest WITHOUT the drafts[] array — the
  // draft rows are authoritative, so embedding them too would duplicate (and
  // risk drifting from) the decomposed source of truth.
  const { drafts: _omit, ...workData } = manifest;
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO writers_room_works
         (id, folder_id, title, kind, status, active_draft_version_id,
          pipeline_series_id, pipeline_issue_id, cd_project_id, media_collection_id,
          data, created_at, updated_at, deleted, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,FALSE,NULL)
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
         deleted = FALSE,
         deleted_at = NULL`,
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
      ],
    );
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
  });
  return manifest;
}

/**
 * Hard-delete a work and its draft rows (the file backend rm -rf's the dir; the
 * DB backend mirrors that destructive delete rather than tombstoning, since
 * Writers Room is not federated so there are no peers to propagate a tombstone
 * to). local.js still rm's the on-disk .md bodies. Idempotent.
 */
export async function deleteWork(id) {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM writers_room_draft_versions WHERE work_id = $1`, [id]);
    await client.query(`DELETE FROM writers_room_works WHERE id = $1`, [id]);
  });
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
