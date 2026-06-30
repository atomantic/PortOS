import { request } from './apiCore.js';

// Music Video production mode (#1760). Director scene-board project CRUD + the
// offline beat/tempo/section analysis. `options` lets a caller suppress
// request()'s auto-toast with `{ silent: true }` when it owns its own error UI.

export const listMusicVideoProjects = (options = {}) => request('/music-video', options);
export const getMusicVideoProject = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}`, options);
export const createMusicVideoProject = (data, options = {}) => request('/music-video', {
  method: 'POST', body: JSON.stringify(data), ...options,
});
export const updateMusicVideoProject = (id, patch, options = {}) => request(`/music-video/${encodeURIComponent(id)}`, {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteMusicVideoProject = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}`, {
  method: 'DELETE', ...options,
});

// Run the offline analyzer on the project's audio and cache the result. Returns
// the updated project (with `audioAnalysis` populated).
export const analyzeMusicVideoProject = (id, options = {}) => request(`/music-video/${encodeURIComponent(id)}/analyze`, {
  method: 'POST', ...options,
});

// ---- Director scene board ----
export const addMusicVideoScene = (id, scene, options = {}) => request(`/music-video/${encodeURIComponent(id)}/scenes`, {
  method: 'POST', body: JSON.stringify(scene), ...options,
});
export const updateMusicVideoScene = (id, sceneId, patch, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'PATCH', body: JSON.stringify(patch), ...options,
  });
export const deleteMusicVideoScene = (id, sceneId, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}`, {
    method: 'DELETE', ...options,
  });
export const reorderMusicVideoScenes = (id, sceneIds, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/scenes/reorder`, {
    method: 'POST', body: JSON.stringify({ sceneIds }), ...options,
  });

// ---- Render (#1760, Phase 2) ----
// Kick off the master-bed render; resolves to { jobId }. Progress streams over
// the SSE URL below (subscribe with useSseProgress). cancel stops an in-flight job.
export const renderMusicVideoProject = (id, options = {}) =>
  request(`/music-video/${encodeURIComponent(id)}/render`, { method: 'POST', ...options });

// EventSource URL for a render job's progress stream (consumed by useSseProgress).
export const musicVideoRenderEventsUrl = (jobId) =>
  `/api/music-video/render/${encodeURIComponent(jobId)}/events`;

export const cancelMusicVideoRender = (jobId, options = {}) =>
  request(`/music-video/render/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', ...options });
