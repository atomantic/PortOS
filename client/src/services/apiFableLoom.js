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

export const generateLoomSeriesPlan = (id, body = {}, options = {}) => request(loomPath(id, '/plan/generate'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const reviewLoomSeriesPlan = (id, body = {}, options = {}) => request(loomPath(id, '/plan/review'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const feedbackLoomSeriesPlan = (id, body, options = {}) => request(loomPath(id, '/plan/feedback'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const reviewLoomTeleplay = (id, body = {}, options = {}) => request(loomPath(id, '/review-teleplay'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const remediateLoomEditorial = (id, body = {}, options = {}) => request(loomPath(id, '/editorial/remediate'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const reviewLoomPlaythroughs = (id, body = {}, options = {}) => request(loomPath(id, '/playtest'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const startLoomEditorialAutopilot = (id, body = {}, options = {}) =>
  request(loomPath(id, '/editorial/autopilot/start'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
export const getLoomEditorialAutopilotStatus = (id, options = {}) =>
  request(loomPath(id, '/editorial/autopilot/status'), options);
export const getLoomEditorialAutopilotRun = (id, runId, options = {}) =>
  request(loomPath(id, `/editorial/autopilot/${encodeURIComponent(runId)}`), options);
export const cancelLoomEditorialAutopilot = (id, runId, options = {}) =>
  request(loomPath(id, `/editorial/autopilot/${encodeURIComponent(runId)}/cancel`), {
    method: 'POST', body: JSON.stringify({}), ...options,
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
export const generateLoomEpisodeOutline = (id, episodeId, body = {}, options = {}) =>
  request(episodePath(id, episodeId, '/outline/generate'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
export const validateLoomEpisodeOutline = (id, episodeId, options = {}) =>
  request(episodePath(id, episodeId, '/outline/validate'), {
    method: 'POST', body: JSON.stringify({}), ...options,
  });
export const reviewLoomEpisodeOutline = (id, episodeId, body = {}, options = {}) =>
  request(episodePath(id, episodeId, '/outline/review'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
export const validateLoomSeriesOutlines = (id, options = {}) =>
  request(loomPath(id, '/outlines/validate'), options);

export const addLoomNode = (id, episodeId, body, options = {}) => request(episodePath(id, episodeId, '/nodes'), {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const updateLoomNode = (id, episodeId, nodeId, patch, options = {}) => request(nodePath(id, episodeId, nodeId), {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteLoomNode = (id, episodeId, nodeId, options = {}) => request(nodePath(id, episodeId, nodeId), {
  method: 'DELETE', ...options,
});

export const startLoomFalVideo = (id, episodeId, nodeId, body, options = {}) =>
  request(nodePath(id, episodeId, nodeId, '/fal-video'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

export const getLoomFalVideo = (id, episodeId, nodeId, jobId, options = {}) =>
  request(nodePath(id, episodeId, nodeId, `/fal-video/${encodeURIComponent(jobId)}`), options);

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

export const preflightHostedLoomSession = (id, episodeId, options = {}) =>
  request(episodePath(id, episodeId, '/sessions/preflight'), {
    method: 'POST', body: JSON.stringify({}), ...options,
  });

export const createHostedLoomSession = (id, episodeId, body = {}, options = {}) =>
  request(episodePath(id, episodeId, '/sessions/host'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

export const updateHostedLoomSession = (sessionId, patch = {}, options = {}) =>
  request(`/fableloom/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', body: JSON.stringify(patch), ...options,
  });

export const endHostedLoomSession = (sessionId, options = {}) =>
  request(`/fableloom/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE', ...options,
  });

export const planLoomEpisodeProduction = (id, episodeId, body = {}, options = {}) =>
  request(episodePath(id, episodeId, '/production/plan'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

export const startLoomEpisodeProductionBatch = (id, episodeId, body = {}, options = {}) =>
  request(episodePath(id, episodeId, '/production/batch'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

export const getLoomEpisodeProductionBatch = (id, episodeId, runId, options = {}) =>
  request(episodePath(id, episodeId, `/production/batch/${encodeURIComponent(runId)}`), options);

export const cancelLoomEpisodeProductionBatch = (id, episodeId, runId, options = {}) =>
  request(episodePath(id, episodeId, `/production/batch/${encodeURIComponent(runId)}/cancel`), {
    method: 'POST', body: JSON.stringify({}), ...options,
  });

export const resumeLoomEpisodeProductionBatch = (id, episodeId, runId, options = {}) =>
  request(episodePath(id, episodeId, `/production/batch/${encodeURIComponent(runId)}/resume`), {
    method: 'POST', body: JSON.stringify({}), ...options,
  });

export const reviewLoomEpisodeContinuity = (id, episodeId, body = {}, options = {}) =>
  request(episodePath(id, episodeId, '/continuity/review'), {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
