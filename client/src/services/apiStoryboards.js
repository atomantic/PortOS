import { request } from './apiCore.js';

// Storyboards — the shared Create › Storyboards planning board (beats → panels,
// panel art as takes). Every write returns the whole sanitized board, so callers
// replace their local copy with the response instead of patching it.

const enc = encodeURIComponent;
const json = (method, body) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const listStoryboards = (options) => request('/storyboards', options);
export const getStoryboard = (id, options) => request(`/storyboards/${enc(id)}`, options);
export const createStoryboard = (data, options) => request('/storyboards', { ...json('POST', data), ...options });
export const updateStoryboard = (id, patch, options) =>
  request(`/storyboards/${enc(id)}`, { ...json('PATCH', patch), ...options });
export const deleteStoryboard = (id, options) => request(`/storyboards/${enc(id)}`, { method: 'DELETE', ...options });

// → { board, beatId }
export const addStoryboardBeat = (id, data, options) =>
  request(`/storyboards/${enc(id)}/beats`, { ...json('POST', data), ...options });
export const updateStoryboardBeat = (id, beatId, patch, options) =>
  request(`/storyboards/${enc(id)}/beats/${enc(beatId)}`, { ...json('PATCH', patch), ...options });
export const deleteStoryboardBeat = (id, beatId, options) =>
  request(`/storyboards/${enc(id)}/beats/${enc(beatId)}`, { method: 'DELETE', ...options });
export const moveStoryboardBeat = (id, beatId, index, options) =>
  request(`/storyboards/${enc(id)}/beats/${enc(beatId)}/move`, { ...json('POST', { index }), ...options });

// → { board, panelId }
export const addStoryboardPanel = (id, beatId, data, options) =>
  request(`/storyboards/${enc(id)}/beats/${enc(beatId)}/panels`, { ...json('POST', data), ...options });
export const updateStoryboardPanel = (id, panelId, patch, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}`, { ...json('PATCH', patch), ...options });
export const deleteStoryboardPanel = (id, panelId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}`, { method: 'DELETE', ...options });
// `{ index }` within its own beat, or `{ beatId, index }` to move across beats.
export const moveStoryboardPanel = (id, panelId, target, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/move`, { ...json('POST', target), ...options });

// take: `{ source, image }` for a gallery image or `{ source: 'sketch', sketchKey }`. → { board, takeId }
export const addStoryboardPanelTake = (id, panelId, take, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/takes`, { ...json('POST', take), ...options });
export const selectStoryboardPanelTake = (id, panelId, takeId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/takes/${enc(takeId)}/select`, { method: 'POST', ...options });
export const removeStoryboardPanelTake = (id, panelId, takeId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/takes/${enc(takeId)}`, { method: 'DELETE', ...options });

// Panel maker. `recipe: null` restores the board's default recipe.
export const updateStoryboardRecipe = (id, recipe, options) =>
  request(`/storyboards/${enc(id)}/recipe`, { ...json('PUT', { recipe }), ...options });
// → { linkedRefs: [{ refId, image, label }] } — the panel's catalog images.
export const getStoryboardPanelMake = (id, panelId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/make`, options);
// patch: `{ text }` (an LLM node's output), `{ excludedRefs }` or `{ extraRefs }`.
export const updateStoryboardPanelNode = (id, panelId, nodeId, patch, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/make/${enc(nodeId)}`, { ...json('PATCH', patch), ...options });
export const runStoryboardPanelNode = (id, panelId, nodeId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/make/${enc(nodeId)}/run`, { method: 'POST', ...options });

// Make empty panels. GET → { batch, panelCount, steps: [{ nodeId, title, type, model, frames }] }.
export const getStoryboardMakeEmpty = (id, options) => request(`/storyboards/${enc(id)}/make-empty`, options);
// → { batch } at once; `storyboard:make-batch` reports progress.
export const startStoryboardMakeEmpty = (id, options) =>
  request(`/storyboards/${enc(id)}/make-empty`, { method: 'POST', ...options });

// The saved recipe library, shared by every board. A load copies the graph onto a board.
export const listStoryboardRecipes = (options) => request('/storyboards/recipes', options);
export const saveStoryboardRecipe = (name, recipe, options) =>
  request('/storyboards/recipes', { ...json('POST', { name, recipe }), ...options });
export const deleteStoryboardRecipe = (recipeId, options) =>
  request(`/storyboards/recipes/${enc(recipeId)}`, { method: 'DELETE', ...options });

// Beats from a plot summary. extract → { board, beats, sentPrompt, promptAdditions }: the
// beats are a preview; the board keeps only the plot and LLM pick. add appends beats.
export const extractStoryboardBeats = (id, input, options) =>
  request(`/storyboards/${enc(id)}/beats/extract`, { ...json('POST', input), ...options });
export const addStoryboardBeats = (id, beats, options) =>
  request(`/storyboards/${enc(id)}/beats/add`, { ...json('POST', { beats }), ...options });

// A new board built from a music video's shots, linked to it → { board, project }.
export const makeStoryboardFromMusicVideo = (projectId, options) =>
  request(`/storyboards/from-music-video/${enc(projectId)}`, { method: 'POST', ...options });

// Fit to song: the video's shots written from its linked board, as previewed (lib/storyboardFit.js)
// → { project, shots, replaced }. 409 when the board changed since the preview or a shot is locked.
export const fitMusicVideoToStoryboard = (projectId, input, options) =>
  request(`/storyboards/fit-music-video/${enc(projectId)}`, { ...json('POST', input), ...options });

// A fitted shot and its panel: Update → { scene } (the panel's action as the shot's intent);
// panel art → { board } (the shot's still as the panel's selected take).
export const updateShotFromStoryboardPanel = (projectId, sceneId, options) =>
  request(`/storyboards/music-video/${enc(projectId)}/shots/${enc(sceneId)}/update-from-panel`, { method: 'POST', ...options });
export const sendShotStillToStoryboardPanel = (projectId, sceneId, options) =>
  request(`/storyboards/music-video/${enc(projectId)}/shots/${enc(sceneId)}/panel-art`, { method: 'POST', ...options });
