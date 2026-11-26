/** Builds the Blender film API for a Music Video or Code Animation route prefix. */
import { request } from './apiCore.js';

const blenderJson = (method, body, options) => ({ method, ...(body ? { body: JSON.stringify(body) } : {}), ...options });

export function createBlenderFilmApi(pathOf) {
  return {
    getMusicVideoBlender: (id, options = {}) => request(pathOf(id), options),
    // `settings` holds only the fields that changed; film option values go as `{ options: { key: value } }`
    // (null clears one back to the film's default).
    saveMusicVideoBlenderSettings: (id, settings, options = {}) => request(`${pathOf(id)}/settings`, blenderJson('PUT', settings, options)),
    createMusicVideoBlenderWorkspace: (id, body = { template: 'starter' }, options = {}) =>
      request(`${pathOf(id)}/workspace`, blenderJson('POST', body, options)),
    // { files: [{ path, bytes, mtime, text }] } for src/; binary assets are listed, never read.
    listMusicVideoBlenderFiles: (id, options = {}) => request(`${pathOf(id)}/files`, options),
    getMusicVideoBlenderFile: (id, path, options = {}) => request(`${pathOf(id)}/file?path=${encodeURIComponent(path)}`, options),
    saveMusicVideoBlenderFile: (id, { path, content }, options = {}) => request(`${pathOf(id)}/file`, blenderJson('PUT', { path, content }, options)),
    deleteMusicVideoBlenderFile: (id, path, options = {}) =>
      request(`${pathOf(id)}/file?path=${encodeURIComponent(path)}`, blenderJson('DELETE', null, options)),
    // 3D models copied from the library into src/models/: { models: [{ slug, kind, name, updateAvailable, sourceMissing, snippet }] }.
    listMusicVideoBlenderModels: (id, options = {}) => request(`${pathOf(id)}/models`, options),
    // Body: { kind: 'image-to-3d' | 'threejs', id, variant?, slug?, replace? } → 201 { model, snippet }; a taken slug is 409 unless replace.
    addMusicVideoBlenderModel: (id, body, options = {}) => request(`${pathOf(id)}/models`, blenderJson('POST', body, options)),
    // Re-copies one model from its library source → { model, snippet }; never runs by itself.
    updateMusicVideoBlenderModel: (id, slug, options = {}) => request(`${pathOf(id)}/models/${encodeURIComponent(slug)}/update`, blenderJson('POST', {}, options)),
    // Starts the film's describe step as a background job → 202 { job }; when it ends the shots are
    // mirrored to storyboard scenes. 409 MUSIC_VIDEO_BLENDER_SCENES_CONFLICT asks for `replaceScenes: true`.
    syncMusicVideoBlender: (id, body = {}, options = {}) => request(`${pathOf(id)}/sync`, blenderJson('POST', body, options)),
    // Body: { shotIds?, quality: 'still' | 'sheet' | 'preview' | 'final', times?, sheet?, force?, onlyStale? } → 202 { jobs, skipped }.
    renderMusicVideoBlender: (id, body, options = {}) => request(`${pathOf(id)}/render`, blenderJson('POST', body, options)),
    // What the workspace takes on disk: { sourceBytes, rendersBytes, frameBytes, frameFiles, clearableBytes, removedShots }.
    getMusicVideoBlenderUsage: (id, options = {}) => request(`${pathOf(id)}/usage`, options),
    // Removes the frames of finished renders (their videos stay) → { freedBytes, usage }.
    clearMusicVideoBlenderFrames: (id, options = {}) => request(`${pathOf(id)}/frames/clear`, blenderJson('POST', null, options)),
    cancelMusicVideoBlenderJob: (id, jobId, options = {}) =>
      request(`${pathOf(id)}/jobs/${encodeURIComponent(jobId)}/cancel`, blenderJson('POST', null, options)),
    cancelMusicVideoBlenderJobs: (id, options = {}) => request(`${pathOf(id)}/cancel`, blenderJson('POST', null, options)),
    // Body: { quality: 'preview' | 'final', animatic?, filmLook? } → 202 { job }.
    assembleMusicVideoBlenderCut: (id, body, options = {}) => request(`${pathOf(id)}/cut`, blenderJson('POST', body, options)),
    saveMusicVideoBlenderShotNote: (id, shotId, body, options = {}) =>
      request(`${pathOf(id)}/shots/${encodeURIComponent(shotId)}/note`, blenderJson('PUT', body, options)),
    // Replaces a shot's motion references (timing-only clips, at most three) → the film state.
    // Body: { references: [{ id?, filename, inSec, outSec, speed, note }] }.
    saveMusicVideoBlenderMotionReferences: (id, shotId, references, options = {}) =>
      request(`${pathOf(id)}/shots/${encodeURIComponent(shotId)}/motion-references`, blenderJson('PUT', { references }, options)),
    // Tiles one reference on a contact sheet's grid (`sheet`: its media path; omitted, the newest) → { file, path, every, columns, tiles, available }.
    makeMusicVideoBlenderMotionStrip: (id, shotId, refId, body = {}, options = {}) =>
      request(`${pathOf(id)}/shots/${encodeURIComponent(shotId)}/motion-references/${encodeURIComponent(refId)}/strip`, blenderJson('POST', body, options)),
    openMusicVideoBlenderShot: (id, shotId, options = {}) =>
      request(`${pathOf(id)}/shots/${encodeURIComponent(shotId)}/open`, blenderJson('POST', null, options)),
    // A file under the workspace's renders/ folder (shot video, frame, still, cut), for a media element's src.
    musicVideoBlenderMediaUrl: (id, path) => `/api${pathOf(id)}/media?path=${encodeURIComponent(path)}`,
    // A job's log, read as text through the same media route.
    getMusicVideoBlenderLog: (id, path, options = {}) =>
      request(`${pathOf(id)}/media?path=${encodeURIComponent(path)}`, { responseType: 'text', ...options }),
  };
}
