import { request } from './apiCore.js';

const enc = encodeURIComponent;

// Folders
export const listWritersRoomFolders = () => request('/writers-room/folders');
export const createWritersRoomFolder = (data) => request('/writers-room/folders', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const deleteWritersRoomFolder = (id) => request(`/writers-room/folders/${enc(id)}`, {
  method: 'DELETE',
});

// Works
export const listWritersRoomWorks = () => request('/writers-room/works');
export const createWritersRoomWork = (data) => request('/writers-room/works', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const getWritersRoomWork = (id) => request(`/writers-room/works/${enc(id)}`);
export const updateWritersRoomWork = (id, patch) => request(`/writers-room/works/${enc(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deleteWritersRoomWork = (id) => request(`/writers-room/works/${enc(id)}`, {
  method: 'DELETE',
});

// Drafts
export const saveWritersRoomDraft = (id, body) => request(`/writers-room/works/${enc(id)}/draft`, {
  method: 'PUT',
  body: JSON.stringify({ body }),
});
export const snapshotWritersRoomDraft = (id, label) => request(`/writers-room/works/${enc(id)}/versions`, {
  method: 'POST',
  body: JSON.stringify(label ? { label } : {}),
});
export const setWritersRoomActiveDraft = (id, draftId) => request(`/writers-room/works/${enc(id)}/versions/${enc(draftId)}`, {
  method: 'PATCH',
});

// Analysis (AI passes — evaluate / format / script)
export const listWritersRoomAnalyses = (workId) =>
  request(`/writers-room/works/${enc(workId)}/analysis`);
export const runWritersRoomAnalysis = (workId, data) =>
  request(`/writers-room/works/${enc(workId)}/analysis`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const getWritersRoomAnalysis = (workId, analysisId) =>
  request(`/writers-room/works/${enc(workId)}/analysis/${enc(analysisId)}`);
export const attachWritersRoomSceneImage = (workId, analysisId, payload) =>
  request(`/writers-room/works/${enc(workId)}/analysis/${enc(analysisId)}/scene-image`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

// Characters (editable bible — separate from immutable analysis snapshots)
export const listWritersRoomCharacters = (workId) =>
  request(`/writers-room/works/${enc(workId)}/characters`);
export const createWritersRoomCharacter = (workId, data) =>
  request(`/writers-room/works/${enc(workId)}/characters`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const updateWritersRoomCharacter = (workId, characterId, patch) =>
  request(`/writers-room/works/${enc(workId)}/characters/${enc(characterId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
export const deleteWritersRoomCharacter = (workId, characterId) =>
  request(`/writers-room/works/${enc(workId)}/characters/${enc(characterId)}`, {
    method: 'DELETE',
  });

// Settings / world bible (editable, persists across analysis runs, drives
// scene image gen via slugline match in SceneCard)
export const listWritersRoomSettings = (workId) =>
  request(`/writers-room/works/${enc(workId)}/settings`);
export const createWritersRoomSetting = (workId, data) =>
  request(`/writers-room/works/${enc(workId)}/settings`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const updateWritersRoomSetting = (workId, settingId, patch) =>
  request(`/writers-room/works/${enc(workId)}/settings/${enc(settingId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
export const deleteWritersRoomSetting = (workId, settingId) =>
  request(`/writers-room/works/${enc(workId)}/settings/${enc(settingId)}`, {
    method: 'DELETE',
  });

// Exercises
export const listWritersRoomExercises = (workId) => {
  const qs = workId ? `?workId=${enc(workId)}` : '';
  return request(`/writers-room/exercises${qs}`);
};
export const createWritersRoomExercise = (data) => request('/writers-room/exercises', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const finishWritersRoomExercise = (id, data) => request(`/writers-room/exercises/${enc(id)}/finish`, {
  method: 'POST',
  body: JSON.stringify(data || {}),
});
export const discardWritersRoomExercise = (id) => request(`/writers-room/exercises/${enc(id)}/discard`, {
  method: 'POST',
});
