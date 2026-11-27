// Tiny helpers shared by every Writers Room service module (local, evaluator,
// characters, settings). All four need the same iso-stamp + ServerError
// shorthands plus the work-id shape check; duplicating them turned into
// byte-for-byte drift risk.

import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { createFileWriteQueue, createRecordWriteQueue } from '../../lib/fileWriteQueue.js';

// The one set of write queues for Writers Room records, shared by the local
// mutators (local.js), the sync merges (both store backends) and tombstone
// pruning (sync.js). A holder keeps its turn across the whole read/modify/write
// cycle, body files included, so a merge cannot land between a mutator's read
// and its whole-manifest write. The queues are not re-entrant: store leaf writes
// (writeWork, deleteFolder, …) stay unqueued. Acquire in this order: work →
// exercise/folder → backup publication lease.
export const queueWorkWrite = createRecordWriteQueue();
// One tail each, not per id: the file backend keeps every folder (and every
// exercise) in one JSON array, so writes to different ids also overlap.
export const queueFolderWrite = createFileWriteQueue();
export const queueExerciseWrite = createFileWriteQueue();

export const nowIso = () => new Date().toISOString();
export const badRequest = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
export const notFound = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });

// Work ids are minted as `wr-work-<uuid>`. Anything else may be an attempted
// path traversal via the on-disk `data/writers-room/works/<workId>/` layout
// — every service that interpolates workId into a filesystem path must
// guard with this regex first.
export const WORK_ID_RE = /^wr-work-[0-9a-f-]+$/i;
export const assertValidWorkId = (workId) => {
  if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) {
    throw badRequest('Invalid work id');
  }
};

export const DRAFT_ID_RE = /^wr-draft-[0-9a-f-]+$/i;

// Folder + exercise ids (`wr-folder-<uuid>` / `wr-ex-<uuid>`). Unlike works they
// are NOT interpolated into a filesystem path (their records live in a shared
// folders.json/exercises.json file or a single DB row), so these guard the
// federation sanitizers against a malformed/junk peer-supplied id rather than a
// path traversal — a record without a usable id is dropped before merge/persist.
export const FOLDER_ID_RE = /^wr-folder-[0-9a-f-]+$/i;
export const EXERCISE_ID_RE = /^wr-ex-[0-9a-f-]+$/i;

// On-disk path helpers. Resolved lazily (functions, not consts) so tests can
// swap PATHS.data via vi.mock without the module-load snapshot freezing them at
// import time. The DRAFT .md bodies live under works/<id>/drafts/ regardless of
// storage backend (file-primary) — local.js owns them; the file backend's JSON
// metadata files (folders.json, exercises.json, manifest.json) live alongside.
export const wrRoot = () => join(PATHS.data, 'writers-room');
export const wrFoldersFile = () => join(wrRoot(), 'folders.json');
export const wrExercisesFile = () => join(wrRoot(), 'exercises.json');
export const wrWorksDir = () => join(wrRoot(), 'works');
export const wrWorkDir = (workId) => {
  assertValidWorkId(workId);
  return join(wrWorksDir(), workId);
};
export const wrManifestPath = (workId) => join(wrWorkDir(workId), 'manifest.json');
export const wrDraftPath = (workId, draftId) => {
  if (!DRAFT_ID_RE.test(draftId)) throw badRequest('Invalid draft id');
  return join(wrWorkDir(workId), 'drafts', `${draftId}.md`);
};

export const WORK_SUMMARY_FIELDS = [
  'id', 'folderId', 'title', 'kind', 'status', 'activeDraftVersionId',
  'pipelineSeriesId', 'pipelineIssueId', 'createdAt', 'updatedAt',
];

export function summarizeWork(work, draftCount, wordCount) {
  const drafts = work.drafts || [];
  return {
    ...Object.fromEntries(WORK_SUMMARY_FIELDS.map(key => [key, work[key]])),
    pipelineSeriesId: work.pipelineSeriesId || null,
    pipelineIssueId: work.pipelineIssueId || null,
    draftCount: draftCount ?? drafts.length,
    wordCount: wordCount ?? drafts.find(draft => draft.id === work.activeDraftVersionId)?.wordCount ?? 0,
  };
}
