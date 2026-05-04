// Tiny helpers shared by every Writers Room service module (local, evaluator,
// characters, settings). All four need the same iso-stamp + ServerError
// shorthands plus the work-id shape check; duplicating them turned into
// byte-for-byte drift risk.

import { ServerError } from '../../lib/errorHandler.js';

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
