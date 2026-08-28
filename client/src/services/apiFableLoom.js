import { request } from './apiCore.js';

const loomPath = (id, rest = '') => `/fableloom/${encodeURIComponent(id)}${rest}`;
const episodePath = (id, episodeId, rest = '') =>
  loomPath(id, `/episodes/${encodeURIComponent(episodeId)}${rest}`);
const nodePath = (id, episodeId, nodeId, rest = '') =>
  episodePath(id, episodeId, `/nodes/${encodeURIComponent(nodeId)}${rest}`);
const transitionPath = (id, episodeId, nodeId, transitionId) =>
  nodePath(id, episodeId, nodeId, `/transitions/${encodeURIComponent(transitionId)}`);

// `seriesId` scopes the index to one pipeline series' linked looms; every other
// key is passed through to `request` as fetch options (e.g. `{ silent: true }`).
export const listLooms = ({ seriesId, ...options } = {}) =>
  request(seriesId ? `/fableloom?seriesId=${encodeURIComponent(seriesId)}` : '/fableloom', options);
export const getLoom = (id, options = {}) => request(loomPath(id), options);

export const createLoom = (body, options = {}) => request('/fableloom', {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const updateLoom = (id, patch, options = {}) => request(loomPath(id), {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteLoom = (id, options = {}) => request(loomPath(id), {
  method: 'DELETE', ...options,
});

export const addLoomEpisode = (id, body, options = {}) => request(loomPath(id, '/episodes'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const updateLoomEpisode = (id, episodeId, patch, options = {}) => request(episodePath(id, episodeId), {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteLoomEpisode = (id, episodeId, options = {}) => request(episodePath(id, episodeId), {
  method: 'DELETE', ...options,
});
export const validateLoomEpisode = (id, episodeId, options = {}) =>
  request(episodePath(id, episodeId, '/validate'), options);

export const addLoomNode = (id, episodeId, body, options = {}) => request(episodePath(id, episodeId, '/nodes'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const updateLoomNode = (id, episodeId, nodeId, patch, options = {}) => request(nodePath(id, episodeId, nodeId), {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteLoomNode = (id, episodeId, nodeId, options = {}) => request(nodePath(id, episodeId, nodeId), {
  method: 'DELETE', ...options,
});

// One path out of a scene per call. `addLoomTransition` resolves to
// `{ loom, transition }` — the row carries its server-minted id, so the editor
// never has to reconcile ids back into locally-added rows. The node PATCH's
// whole-array `transitions` key still works for bulk replaces.
export const addLoomTransition = (id, episodeId, nodeId, body, options = {}) =>
  request(nodePath(id, episodeId, nodeId, '/transitions'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
export const updateLoomTransition = (id, episodeId, nodeId, transitionId, patch, options = {}) =>
  request(transitionPath(id, episodeId, nodeId, transitionId), {
    method: 'PATCH', body: JSON.stringify(patch), ...options,
  });
export const deleteLoomTransition = (id, episodeId, nodeId, transitionId, options = {}) =>
  request(transitionPath(id, episodeId, nodeId, transitionId), {
    method: 'DELETE', ...options,
  });

export const weaveLoomEpisode = (id, episodeId, body = {}, options = {}) => request(episodePath(id, episodeId, '/weave'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const branchLoomNode = (id, episodeId, nodeId, body = {}, options = {}) => request(nodePath(id, episodeId, nodeId, '/branch'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const reviewLoomEpisode = (id, episodeId, body = {}, options = {}) => request(episodePath(id, episodeId, '/review'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const feedbackLoomEpisode = (id, episodeId, body = {}, options = {}) => request(episodePath(id, episodeId, '/feedback'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const playLoomTurn = (id, episodeId, body, options = {}) => request(episodePath(id, episodeId, '/play'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
// One episode per call. The caller walks the episodes it needs rewritten — a
// whole-loom rewrite in one request ran long enough to hit a fetch timeout. The
// server pins the loom to the format once every episode is converted, so an
// interrupted walk never leaves the loom claiming a format its scenes are not in.
export const reformatLoomEpisode = (id, episodeId, body, options = {}) =>
  request(episodePath(id, episodeId, '/reformat'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
