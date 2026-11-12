import { request } from './apiCore.js';

const blenderPath = (id) => `/code-animation/films/${encodeURIComponent(id)}/blender`;
const blenderJson = (method, body, options) => ({ method, ...(body ? { body: JSON.stringify(body) } : {}), ...options });
export const getMusicVideoBlender = (id, options = {}) => request(blenderPath(id), options);
// `settings` holds only the fields that changed; film option values go as `{ options: { key: value } }`
// (null clears one back to the film's default).
export const saveMusicVideoBlenderSettings = (id, settings, options = {}) => request(`${blenderPath(id)}/settings`, blenderJson('PUT', settings, options));
export const createMusicVideoBlenderWorkspace = (id, body = { template: 'starter' }, options = {}) =>
  request(`${blenderPath(id)}/workspace`, blenderJson('POST', body, options));
// { files: [{ path, bytes, mtime, text }] } for src/; binary assets are listed, never read.
export const listMusicVideoBlenderFiles = (id, options = {}) => request(`${blenderPath(id)}/files`, options);
export const getMusicVideoBlenderFile = (id, path, options = {}) => request(`${blenderPath(id)}/file?path=${encodeURIComponent(path)}`, options);
export const saveMusicVideoBlenderFile = (id, { path, content }, options = {}) => request(`${blenderPath(id)}/file`, blenderJson('PUT', { path, content }, options));
export const deleteMusicVideoBlenderFile = (id, path, options = {}) =>
  request(`${blenderPath(id)}/file?path=${encodeURIComponent(path)}`, blenderJson('DELETE', null, options));
// Starts the film's describe step as a background job → 202 { job }; when it ends the shots are
// mirrored to storyboard scenes. 409 MUSIC_VIDEO_BLENDER_SCENES_CONFLICT asks for `replaceScenes: true`.
export const syncMusicVideoBlender = (id, body = {}, options = {}) => request(`${blenderPath(id)}/sync`, blenderJson('POST', body, options));
// Body: { shotIds?, quality: 'still' | 'preview' | 'final', times?, force?, onlyStale? } → 202 { jobs, skipped }.
export const renderMusicVideoBlender = (id, body, options = {}) => request(`${blenderPath(id)}/render`, blenderJson('POST', body, options));
// What the workspace takes on disk: { sourceBytes, rendersBytes, frameBytes, frameFiles, clearableBytes, removedShots }.
export const getMusicVideoBlenderUsage = (id, options = {}) => request(`${blenderPath(id)}/usage`, options);
// Removes the frames of finished renders (their videos stay) → { freedBytes, usage }.
export const clearMusicVideoBlenderFrames = (id, options = {}) => request(`${blenderPath(id)}/frames/clear`, blenderJson('POST', null, options));
export const cancelMusicVideoBlenderJob = (id, jobId, options = {}) =>
  request(`${blenderPath(id)}/jobs/${encodeURIComponent(jobId)}/cancel`, blenderJson('POST', null, options));
export const cancelMusicVideoBlenderJobs = (id, options = {}) => request(`${blenderPath(id)}/cancel`, blenderJson('POST', null, options));
// Body: { quality: 'preview' | 'final', animatic?, filmLook? } → 202 { job }.
export const assembleMusicVideoBlenderCut = (id, body, options = {}) => request(`${blenderPath(id)}/cut`, blenderJson('POST', body, options));
export const saveMusicVideoBlenderShotNote = (id, shotId, body, options = {}) =>
  request(`${blenderPath(id)}/shots/${encodeURIComponent(shotId)}/note`, blenderJson('PUT', body, options));
export const openMusicVideoBlenderShot = (id, shotId, options = {}) =>
  request(`${blenderPath(id)}/shots/${encodeURIComponent(shotId)}/open`, blenderJson('POST', null, options));
// A file under the workspace's renders/ folder (shot video, frame, still, cut), for a media element's src.
export const musicVideoBlenderMediaUrl = (id, path) => `/api${blenderPath(id)}/media?path=${encodeURIComponent(path)}`;
// A job's log, read as text through the same media route.
export const getMusicVideoBlenderLog = (id, path, options = {}) =>
  request(`${blenderPath(id)}/media?path=${encodeURIComponent(path)}`, { responseType: 'text', ...options });


export const createFilm = (input, options) => request('/code-animation/films', { method: 'POST', body: JSON.stringify(input), ...options });
export const patchFilm = (id, input, options) => request(`/code-animation/films/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input), ...options });
export const attachAudio = (id, input, options) => request(`/code-animation/films/${encodeURIComponent(id)}/audio`, { method: 'POST', body: JSON.stringify(input), ...options });
