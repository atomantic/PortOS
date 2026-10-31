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
// body: `{ takeId, note }` → the board once the corrected frames are queued.
// Draw a panel: the recipe rewrites its prompt and queues one frame, which becomes its art.
export const drawStoryboardPanel = (id, panelId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/draw`, { ...json('POST', {}), ...options });
export const correctStoryboardPanel = (id, panelId, body, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/correct`, { ...json('POST', body), ...options });

// Make empty panels. GET → { batch, panelCount, steps: [{ nodeId, title, type, model, frames }] }.
export const getStoryboardMakeEmpty = (id, options) => request(`/storyboards/${enc(id)}/make-empty`, options);
// → { batch } at once; `storyboard:make-batch` reports progress. `body`:
// { redraw, selectNew } redraws every panel instead of only the empty ones.
export const startStoryboardMakeEmpty = (id, body = {}, options) =>
  request(`/storyboards/${enc(id)}/make-empty`, { ...json('POST', body), ...options });
// Regroup a music video's linked board into one beat per song section.
export const groupStoryboardBySong = (projectId, options) =>
  request(`/storyboards/group-by-song/${enc(projectId)}`, { ...json('POST', {}), ...options });

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

// Sync shots: one shot per panel at the panel's own time (lib/storyboardShotSync.js), then kept
// in sync after each board edit → { project, counts }. 409 when the board or shots changed since the preview.
export const syncMusicVideoShots = (projectId, input, options) =>
  request(`/storyboards/sync-music-video/${enc(projectId)}`, { ...json('POST', input), ...options });
// Keep the shots in sync after each board edit (on syncs once), or stop → { project, counts? }.
export const setMusicVideoShotSync = (projectId, on, options) =>
  request(`/storyboards/sync-music-video/${enc(projectId)}/auto`, { ...json('PUT', { on }), ...options });

// A fitted shot and its panel: Update → { scene } (the panel's action as the shot's intent);
// panel art → { board } (the shot's still as the panel's selected take).
export const updateShotFromStoryboardPanel = (projectId, sceneId, options) =>
  request(`/storyboards/music-video/${enc(projectId)}/shots/${enc(sceneId)}/update-from-panel`, { method: 'POST', ...options });
export const sendShotStillToStoryboardPanel = (projectId, sceneId, options) =>
  request(`/storyboards/music-video/${enc(projectId)}/shots/${enc(sceneId)}/panel-art`, { method: 'POST', ...options });

// A Video (Creative Director) draft from a board: the draft drawer's choices, its shots the
// panels as previewed (lib/storyboardVideo.js) → { project }. 409 when the board changed since.
export const startVideoFromStoryboard = (id, input, options) =>
  request(`/storyboards/${enc(id)}/video`, { ...json('POST', input), ...options });

// A new board from one FableLoom episode path (`via`: the transition ids picked at forks) → board.
// Use as scene / shot art: the panel's selected image goes back to its FableLoom scene or
// pipeline shot → { board, target }.
export const makeStoryboardFromFableLoom = (loomId, episodeId, via, options) =>
  request(`/storyboards/from-fableloom/${enc(loomId)}/${enc(episodeId)}`, { ...json('POST', { via }), ...options });
export const sendStoryboardPanelToFableLoom = (id, panelId, options) =>
  request(`/storyboards/${enc(id)}/panels/${enc(panelId)}/scene-art`, { method: 'POST', ...options });

// Open in storyboard editor (Series Pipeline): the issue's linked board, made from its
// storyboard scenes the first time → { boardId, created }.
export const openStoryboardForPipelineIssue = (issueId, options) =>
  request(`/storyboards/from-pipeline/${enc(issueId)}`, { method: 'POST', ...options });

// The linked board's edits waiting for the issue's shots → { boardId, locked, changed: [{ sceneId, shotId, panelId, fields }] }.
export const getPipelineStoryboardChanges = (issueId, options) =>
  request(`/storyboards/pipeline/${enc(issueId)}/changes`, options);

// Update: copy edited panels (all, or one shot's) to their shots → { updated, issue, boardId, locked, changed }.
export const updatePipelineShotsFromBoard = (issueId, shotId, options) =>
  request(`/storyboards/pipeline/${enc(issueId)}/update-from-board`, { ...json('POST', shotId ? { shotId } : {}), ...options });
