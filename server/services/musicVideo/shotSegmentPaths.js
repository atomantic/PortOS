// Where a project's shot segments live. A leaf so coldOpen.js can place its
// audio there without importing shotSegments.js, which imports coldOpen.js.
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';

export const SHOT_SEGMENT_DIR = 'music-video-segments';

const safeProjectId = (projectId) => {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new ServerError('Invalid project id', { status: 400, code: 'VALIDATION_ERROR' });
  return projectId;
};

export const shotSegmentDir = (projectId) => join(PATHS.data, SHOT_SEGMENT_DIR, safeProjectId(projectId));
