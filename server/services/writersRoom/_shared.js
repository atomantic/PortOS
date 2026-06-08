// Tiny helpers shared by every Writers Room service module (local, evaluator,
// characters, settings). All four need the same iso-stamp + ServerError
// shorthands plus the work-id shape check; duplicating them turned into
// byte-for-byte drift risk.

import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';

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
