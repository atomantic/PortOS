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

// Pipeline bridge: create a pipeline series + first issue from this work
// (transfers prose, bibles, and the latest script-analysis scenes). Idempotent
// — if the work is already linked, returns the existing series + issue
// (reused=true) unless { force: true } is passed.
export const promoteWritersRoomWorkToPipeline = (id, { force } = {}) =>
  request(`/writers-room/works/${enc(id)}/promote-to-pipeline`, {
    method: 'POST',
    body: JSON.stringify({ force }),
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

// Polish loop (#2173): autonomous cuts → revise → keep/revert, multi-pass.
// startWritersRoomPolish returns { runId, alreadyRunning, sseUrl }; subscribe to
// the sseUrl with useSseProgress for live per-cycle progress. Snapshots are the
// immutable revert points (the keep/revert gate + the manual revert control).
export const startWritersRoomPolish = (workId, opts = {}) =>
  request(`/writers-room/works/${enc(workId)}/polish/start`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });
export const cancelWritersRoomPolish = (workId) =>
  request(`/writers-room/works/${enc(workId)}/polish/cancel`, { method: 'POST' });
export const getWritersRoomPolishStatus = (workId) =>
  request(`/writers-room/works/${enc(workId)}/polish/status`);
export const listWritersRoomPolishSnapshots = (workId) =>
  request(`/writers-room/works/${enc(workId)}/polish/snapshots`);
export const getWritersRoomPolishSnapshot = (workId, snapshotId) =>
  request(`/writers-room/works/${enc(workId)}/polish/snapshots/${enc(snapshotId)}`);
export const revertWritersRoomPolishSnapshot = (workId, snapshotId) =>
  request(`/writers-room/works/${enc(workId)}/polish/revert`, {
    method: 'POST',
    body: JSON.stringify({ snapshotId }),
  });

// Live continuation (Phase 5): opt-in, debounced Creative Director feedback
// from the prose around the cursor. Returns { options, usage, budget }. The
// server gates on the per-work live-mode toggle (409) and daily budget (429);
// callers own their own error UI, so pass { silent: true } to avoid a double
// toast.
export const suggestWritersRoomContinuation = (workId, context, options) =>
  request(`/writers-room/works/${enc(workId)}/live-suggest`, {
    method: 'POST',
    body: JSON.stringify(context || {}),
    ...(options || {}),
  });
// Persist a scene→generated-image link on the analysis snapshot (and mirror it
// into the work's media collection). Returns { analysis, collectionId } — the
// analysis carries the merged sceneImages map so callers can update reactively.
// Pass { silent: true } when you own the error UI (e.g. a console.warn).
export const attachWritersRoomSceneImage = (workId, analysisId, payload, options) =>
  request(`/writers-room/works/${enc(workId)}/analysis/${enc(analysisId)}/scene-image`, {
    method: 'POST',
    body: JSON.stringify(payload),
    ...(options || {}),
  });

// Reserve one live render preview (Phase 5) against the per-work render budget.
// Call this BEFORE kicking off the render via the existing image-gen route —
// the server gates on the live-mode toggle (409) and the distinct daily render
// budget (429). Returns { renderUsage, renderBudget }. Callers own their own
// error UI, so pass { silent: true } to avoid a double toast.
export const reserveWritersRoomRenderPreview = (workId, options) =>
  request(`/writers-room/works/${enc(workId)}/live-render-preview`, {
    method: 'POST',
    ...(options || {}),
  });

// CD bridge (Phase 5): propose a Creative Director treatment from the cursor
// context. Draws on the SAME daily call budget as live continuation (both text
// calls); the server gates on the live-mode toggle (409) and that budget (429).
// Returns { proposal, usage, budget } — proposal is null when no usable
// treatment came back. Callers own their own error UI, so pass { silent: true }.
export const suggestWritersRoomCdBridge = (workId, context, options) =>
  request(`/writers-room/works/${enc(workId)}/cd-bridge/suggest`, {
    method: 'POST',
    body: JSON.stringify(context || {}),
    ...(options || {}),
  });

// Send a reviewed CD-bridge proposal into a NEW Creative Director project
// (non-destructive). Returns { project } — the seeded CD project with its
// treatment applied. Callers own their own error UI, so pass { silent: true }.
export const sendWritersRoomCdBridge = (workId, proposal, options) =>
  request(`/writers-room/works/${enc(workId)}/cd-bridge/send`, {
    method: 'POST',
    body: JSON.stringify({ proposal }),
    ...(options || {}),
  });

// Synced review (Phase 4): a read-model that maps prose segments ↔ script
// scenes ↔ generated media with provenance + stale detection. Derived on the
// server from the active draft's segment index and the `script` analysis
// snapshot — no separate persistence.
export const getWritersRoomSyncedReview = (workId, options) =>
  request(`/writers-room/works/${enc(workId)}/synced-review`, options);

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

// Places / world bible (editable, persists across analysis runs, drives
// scene image gen via slugline match in SceneCard)
export const listWritersRoomPlaces = (workId) =>
  request(`/writers-room/works/${enc(workId)}/places`);
export const createWritersRoomPlace = (workId, data) =>
  request(`/writers-room/works/${enc(workId)}/places`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const updateWritersRoomPlace = (workId, placeId, patch) =>
  request(`/writers-room/works/${enc(workId)}/places/${enc(placeId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
export const deleteWritersRoomPlace = (workId, placeId) =>
  request(`/writers-room/works/${enc(workId)}/places/${enc(placeId)}`, {
    method: 'DELETE',
  });

// Objects bible (editable; recurring symbolic / physical items extracted by
// the Adapt+Objects pass — letters, hats, keepsakes, McGuffins).
export const listWritersRoomObjects = (workId) =>
  request(`/writers-room/works/${enc(workId)}/objects`);
export const createWritersRoomObject = (workId, data) =>
  request(`/writers-room/works/${enc(workId)}/objects`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const updateWritersRoomObject = (workId, objectId, patch) =>
  request(`/writers-room/works/${enc(workId)}/objects/${enc(objectId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
export const deleteWritersRoomObject = (workId, objectId) =>
  request(`/writers-room/works/${enc(workId)}/objects/${enc(objectId)}`, {
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
