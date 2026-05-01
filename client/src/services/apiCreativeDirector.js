import { request } from './apiCore.js';

export const listCreativeDirectorProjects = () => request('/creative-director');
export const getCreativeDirectorProject = (id) => request(`/creative-director/${encodeURIComponent(id)}`);
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
