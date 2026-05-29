import { request } from './apiCore.js';

export const listCreativeDirectorProjects = () => request('/creative-director');
// Pass `{ slim: true }` to receive only the fields a polling consumer needs
// (status / per-scene status / finalVideoId / failureReason / updatedAt) —
// drops the `runs[]` history and the full treatment text. Useful
// for 4s-poll surfaces like the Pipeline EpisodeVideoStage.
export const getCreativeDirectorProject = (id, { slim = false } = {}) =>
  request(`/creative-director/${encodeURIComponent(id)}${slim ? '?slim=1' : ''}`);
export const createCreativeDirectorProject = (data) => request('/creative-director', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const updateCreativeDirectorProject = (id, patch) => request(`/creative-director/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});
export const startCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}/start`, {
  method: 'POST',
});
export const pauseCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}/pause`, {
  method: 'POST',
});
export const resumeCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}/resume`, {
  method: 'POST',
});
export const createSmokeTestCreativeDirectorProject = () => request('/creative-director/smoke-test', {
  method: 'POST',
});
