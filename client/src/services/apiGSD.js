import { request } from './apiCore.js';

// GSD (Get Stuff Done) Integration
export const getGsdProjects = () => request('/cos/gsd/projects');
export const getGsdProject = (appId) => request(`/cos/gsd/projects/${appId}`);
export const getGsdConcerns = (appId) => request(`/cos/gsd/projects/${appId}/concerns`);
export const getGsdPhases = (appId) => request(`/cos/gsd/projects/${appId}/phases`);
export const getGsdPhase = (appId, phaseId) => request(`/cos/gsd/projects/${appId}/phases/${phaseId}`);
export const createGsdConcernTasks = (appId, data) => request(`/cos/gsd/projects/${appId}/concerns/tasks`, {
  method: 'POST',
  body: JSON.stringify(data)
});
export const triggerGsdPhaseAction = (appId, phaseId, action) => request(`/cos/gsd/projects/${appId}/phases/${phaseId}/action`, {
  method: 'POST',
  body: JSON.stringify({ action })
});
export const getGsdDocument = (appId, docName) => request(`/cos/gsd/projects/${appId}/documents/${docName}`);
export const saveGsdDocument = (appId, docName, content, commitMessage) => request(`/cos/gsd/projects/${appId}/documents/${docName}`, {
  method: 'PUT',
  body: JSON.stringify({ content, ...(commitMessage && { commitMessage }) })
});
