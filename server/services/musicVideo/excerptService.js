/**
 * Music Video — draft excerpt CRUD (#8986): review-note edits and excerpt
 * deletion over the pure transforms in `excerpt.js`. Kickoff/cancel of the
 * ffmpeg render itself lives in `excerptRender.js` — this file only touches
 * the persisted record plus the render's output files.
 *
 * Every write goes through `mutateProjectRecord`, so it runs against the
 * freshest record under the backend's write serialization (mirrors
 * treatmentService.js).
 */

import { unlink } from 'fs/promises';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { listProjects, mutateProjectRecord } from './projects.js';
import {
  addExcerptNote,
  removeExcerptFromProject,
  removeExcerptNote,
  updateExcerptNote,
} from './excerpt.js';

// A clone carries its source project's `excerpts` over verbatim (the review
// notes survive the clone, #8986 acceptance) — including the ORIGINAL's
// filename/contactSheetFilename, since a clone never duplicates the actual
// rendered bytes. Two projects can therefore point at the same on-disk file;
// deleting one project's excerpt must not unlink it out from under the other.
async function stillReferenced(filename) {
  if (!filename) return false;
  const projects = await listProjects();
  return projects.some((p) => (p.excerpts || []).some((e) => e.filename === filename || e.contactSheetFilename === filename));
}

async function unlinkIfUnreferenced(root, filename) {
  if (!filename || await stillReferenced(filename)) return;
  await unlink(safeUnder(root, filename) || '').catch(() => {});
}

/** Remove an excerpt and its rendered files (only once no other project still references them). Refuses while its render is in flight. */
export async function deleteExcerpt(id, excerptId) {
  const { project, excerpt } = await mutateProjectRecord(id, (current) => removeExcerptFromProject(current, excerptId));
  await Promise.all([
    unlinkIfUnreferenced(PATHS.videos, excerpt.filename),
    unlinkIfUnreferenced(PATHS.videoThumbnails, excerpt.contactSheetFilename),
  ]);
  return project;
}

/** Add a timecoded review note to an excerpt. */
export async function addReviewNote(id, excerptId, input) {
  const { project, note } = await mutateProjectRecord(id, (current) => addExcerptNote(current, excerptId, input));
  return { project, note };
}

/** Edit a review note's text, timecode, and/or verdict. */
export async function editReviewNote(id, excerptId, noteId, patch) {
  const { project, note } = await mutateProjectRecord(id, (current) => updateExcerptNote(current, excerptId, noteId, patch));
  return { project, note };
}

/** Remove a review note. */
export async function deleteReviewNote(id, excerptId, noteId) {
  const { project } = await mutateProjectRecord(id, (current) => ({ project: removeExcerptNote(current, excerptId, noteId) }));
  return project;
}
