// Where a project's shot segments live, and their removal with the project. A
// leaf so coldOpen.js can place its audio there and the project store can drop
// a deleted project's cache without importing shotSegments.js, which imports
// both of them.
import { rm } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';

export const SHOT_SEGMENT_DIR = 'music-video-segments';

const safeProjectId = (projectId) => {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new ServerError('Invalid project id', { status: 400, code: 'VALIDATION_ERROR' });
  return projectId;
};

export const shotSegmentDir = (projectId) => join(PATHS.data, SHOT_SEGMENT_DIR, safeProjectId(projectId));

// Shots whose completed renders still await segment pruning, per project (shotSegments.js cleanupAfterShot).
export const pendingShotCleanup = new Map();

/** Remove a project's whole segment cache (the project was deleted). */
export const removeProjectSegments = (projectId) => {
  pendingShotCleanup.delete(projectId);
  return rm(shotSegmentDir(projectId), { recursive: true, force: true });
};
