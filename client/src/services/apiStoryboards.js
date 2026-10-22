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
