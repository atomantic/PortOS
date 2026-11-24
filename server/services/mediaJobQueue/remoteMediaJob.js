/**
 * The one definition of "is this queued job rendering on a federated peer?".
 *
 * It lives in its own module rather than in `index.js` so the light consumers —
 * the public projection (`sanitizeJob.js`), route handlers — can ask the
 * question without dragging the whole queue (its timers, persistence, and
 * event emitters) into their module graph. Every caller must use this predicate
 * instead of testing `params.remoteMedia` inline: an inline test silently drops
 * the kind gate below.
 */

import { loadMediaRuntimeModule } from '../bootHookRegistry.js';

// The federatable kinds and the adapter each one dispatches to, in one map so
// the two cannot drift apart. Kinds are listed explicitly rather than inferred
// from the marker alone: a 'training' job has no federated contract, so a marker
// on one is corrupt state that must keep taking the local path, not a routing
// instruction.
export const REMOTE_MEDIA_MODULES = {
  audio: () => loadMediaRuntimeModule('audioRemote'),
  image: () => loadMediaRuntimeModule('imageRemote'),
  video: () => loadMediaRuntimeModule('videoRemote'),
};

// Presence, not truthiness of individual nested fields, selects the remote
// adapter. Persisted queue state is user-editable; a malformed marker must fail
// closed in the kind's remote module rather than accidentally falling through to
// a local engine with a remote-only model id.
export const isRemoteMediaJob = (job) =>
  Object.hasOwn(REMOTE_MEDIA_MODULES, job?.kind ?? '') && job.params?.remoteMedia !== undefined;
