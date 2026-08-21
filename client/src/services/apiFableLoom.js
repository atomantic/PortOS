import { request } from './apiCore.js';

const loomPath = (id, rest = '') => `/fableloom/${encodeURIComponent(id)}${rest}`;
const episodePath = (id, episodeId, rest = '') =>
  loomPath(id, `/episodes/${encodeURIComponent(episodeId)}${rest}`);
const nodePath = (id, episodeId, nodeId, rest = '') =>
  episodePath(id, episodeId, `/nodes/${encodeURIComponent(nodeId)}${rest}`);

export const listLooms = (options = {}) => request('/fableloom', options);
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

export const weaveLoomEpisode = (id, episodeId, body = {}, options = {}) => request(episodePath(id, episodeId, '/weave'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const branchLoomNode = (id, episodeId, nodeId, body = {}, options = {}) => request(nodePath(id, episodeId, nodeId, '/branch'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const reviewLoomEpisode = (id, episodeId, body = {}, options = {}) => request(episodePath(id, episodeId, '/review'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const playLoomTurn = (id, episodeId, body, options = {}) => request(episodePath(id, episodeId, '/play'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const reformatLoom = (id, body, options = {}) => request(loomPath(id, '/reformat'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
