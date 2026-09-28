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
import { mutateProjectRecord } from './projects.js';
import {
  addExcerptNote,
  removeExcerptFromProject,
  removeExcerptNote,
  updateExcerptNote,
} from './excerpt.js';

/** Remove an excerpt and its rendered files. Refuses while its render is in flight. */
export async function deleteExcerpt(id, excerptId) {
  const { project, excerpt } = await mutateProjectRecord(id, (current) => removeExcerptFromProject(current, excerptId));
  await Promise.all([
    excerpt.filename ? unlink(safeUnder(PATHS.videos, excerpt.filename) || '').catch(() => {}) : null,
    excerpt.contactSheetFilename ? unlink(safeUnder(PATHS.videoThumbnails, excerpt.contactSheetFilename) || '').catch(() => {}) : null,
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
