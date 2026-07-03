import { request } from './apiCore.js';

// Brain - Second Brain Feature
export const getBrainSummary = (options) => request('/brain/summary', options);
export const getBrainSettings = (options) => request('/brain/settings', options);
export const updateBrainSettings = (settings, options = {}) => request('/brain/settings', {
  method: 'PUT',
  body: JSON.stringify(settings),
  ...options
});

// Brain - Capture & Inbox
export const captureBrainThought = (text, providerOverride, modelOverride, { creative } = {}, options = {}) => request('/brain/capture', {
  method: 'POST',
  body: JSON.stringify({ text, providerOverride, modelOverride, creative }),
  ...options
});
export const getBrainInbox = (options = {}) => {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  // Forward request-level options (e.g. { silent: true }) so background pollers can opt out
  // of the default error toast. `silent` is the only request-level flag the helper reads;
  // the rest of `options` is query params handled above.
  return request(`/brain/inbox?${params}`, { silent: options.silent });
};
export const getBrainInboxEntry = (id) => request(`/brain/inbox/${id}`);
export const resolveBrainReview = (inboxLogId, destination, editedExtracted, options = {}) => request('/brain/review/resolve', {
  method: 'POST',
  body: JSON.stringify({ inboxLogId, destination, editedExtracted }),
  ...options
});
export const fixBrainClassification = (inboxLogId, newDestination, updatedFields, note, options = {}) => request('/brain/fix', {
  method: 'POST',
  body: JSON.stringify({ inboxLogId, newDestination, updatedFields, note }),
  ...options
});
export const retryBrainClassification = (id, providerOverride, modelOverride, options = {}) => request(`/brain/inbox/${id}/retry`, {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride }),
  ...options
});
export const updateBrainInboxEntry = (id, capturedText, options = {}) => request(`/brain/inbox/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ capturedText }),
  ...options
});
export const deleteBrainInboxEntry = (id, options = {}) => request(`/brain/inbox/${id}`, { method: 'DELETE', ...options });
export const markBrainInboxDone = (id, options = {}) => request(`/brain/inbox/${id}/done`, { method: 'POST', ...options });
// Stamp a batch of creative notes as consumed once their catalog ingest commits.
export const markBrainInboxSentToCatalog = (ids, options) => request('/brain/inbox/sent-to-catalog', {
  method: 'POST',
  body: JSON.stringify({ ids }),
  ...options
});

// Brain - People
export const getBrainPeople = () => request('/brain/people');
export const getBrainPerson = (id) => request(`/brain/people/${id}`);
export const createBrainPerson = (data, options = {}) => request('/brain/people', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainPerson = (id, data, options = {}) => request(`/brain/people/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainPerson = (id, options = {}) => request(`/brain/people/${id}`, { method: 'DELETE', ...options });

// Brain - Projects
export const getBrainProjects = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/projects?${params}`);
};
export const getBrainProject = (id) => request(`/brain/projects/${id}`);
export const createBrainProject = (data, options = {}) => request('/brain/projects', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainProject = (id, data, options = {}) => request(`/brain/projects/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainProject = (id, options = {}) => request(`/brain/projects/${id}`, { method: 'DELETE', ...options });

// Brain - Ideas
export const getBrainIdeas = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/ideas?${params}`);
};
export const getBrainIdea = (id) => request(`/brain/ideas/${id}`);
export const createBrainIdea = (data, options = {}) => request('/brain/ideas', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainIdea = (id, data, options = {}) => request(`/brain/ideas/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainIdea = (id, options = {}) => request(`/brain/ideas/${id}`, { method: 'DELETE', ...options });

// Brain - Admin
export const getBrainAdmin = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/admin?${params}`);
};
export const getBrainAdminItem = (id) => request(`/brain/admin/${id}`);
export const createBrainAdminItem = (data, options = {}) => request('/brain/admin', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainAdminItem = (id, data, options = {}) => request(`/brain/admin/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainAdminItem = (id, options = {}) => request(`/brain/admin/${id}`, { method: 'DELETE', ...options });

// Brain - Memories
export const getBrainMemories = () => request('/brain/memories');
export const getBrainMemory = (id) => request(`/brain/memories/${id}`);
export const createBrainMemory = (data, options = {}) => request('/brain/memories', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainMemory = (id, data, options = {}) => request(`/brain/memories/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainMemory = (id, options = {}) => request(`/brain/memories/${id}`, { method: 'DELETE', ...options });

// Brain - Third-party Imports
export const getBrainImportSources = () => request('/brain/import/sources');
export const previewChatgptImport = (data) => request('/brain/import/chatgpt/preview', {
  method: 'POST',
  body: JSON.stringify({ data })
});
export const runChatgptImport = (data, options = {}) => request('/brain/import/chatgpt', {
  method: 'POST',
  body: JSON.stringify({ data, ...options })
});
// Stream the whole export ZIP up via multipart — no JSON-body size cap, and the
// server extracts conversations + image/voice/file assets. `tags` is a comma-
// separated string; `skipEmpty` a boolean. request() detects the FormData body
// and lets the browser set the multipart boundary itself.
export const uploadChatgptZip = (file, { tags = '', skipEmpty = true, ...options } = {}) => {
  const formData = new FormData();
  formData.append('file', file);
  if (tags) formData.append('tags', tags);
  formData.append('skipEmpty', skipEmpty ? 'true' : 'false');
  return request('/brain/import/chatgpt/zip', { method: 'POST', body: formData, ...options });
};
export const getChatgptArchive = (name) =>
  request(`/brain/import/chatgpt/archive/${encodeURIComponent(name)}`);

// Brain - Digests & Reviews
export const getBrainLatestDigest = () => request('/brain/digest/latest');
export const getBrainDigests = (limit = 10) => request(`/brain/digests?limit=${limit}`);
export const runBrainDigest = (providerOverride, modelOverride, options = {}) => request('/brain/digest/run', {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride }),
  ...options
});
export const getBrainLatestReview = () => request('/brain/review/latest');
export const getBrainReviews = (limit = 10) => request(`/brain/reviews?limit=${limit}`);
export const runBrainReview = (providerOverride, modelOverride, options = {}) => request('/brain/review/run', {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride }),
  ...options
});

// Brain - Links
export const getBrainLinks = (options = {}) => {
  const params = new URLSearchParams();
  if (options.linkType) params.set('linkType', options.linkType);
  if (options.isGitHubRepo !== undefined) params.set('isGitHubRepo', options.isGitHubRepo);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  return request(`/brain/links?${params}`);
};
export const getBrainLink = (id) => request(`/brain/links/${id}`);
export const createBrainLink = (data) => request('/brain/links', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateBrainLink = (id, data, options = {}) => request(`/brain/links/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
// Batch reorder: apply a whole drag gesture's { id, bucketId, bucketOrder }
// changes in one atomic server write (avoids N concurrent PUTs racing the
// shared links store).
export const reorderBrainLinks = (updates, options = {}) => request('/brain/links/reorder', {
  method: 'POST',
  body: JSON.stringify({ updates }),
  ...options
});
export const deleteBrainLink = (id, options = {}) => request(`/brain/links/${id}`, { method: 'DELETE', ...options });
export const cloneBrainLink = (id, options = {}) => request(`/brain/links/${id}/clone`, { method: 'POST', ...options });
export const pullBrainLink = (id, options = {}) => request(`/brain/links/${id}/pull`, { method: 'POST', ...options });
export const openBrainLinkFolder = (id, options = {}) => request(`/brain/links/${id}/open-folder`, { method: 'POST', ...options });
export const scanBrainLink = (id, options = {}) => request(`/brain/links/${id}/scan`, { method: 'POST', ...options });

// Brain - Buckets (bookmark groups for links)
export const getBrainBuckets = (options = {}) => request('/brain/buckets', options);
export const createBrainBucket = (data, options = {}) => request('/brain/buckets', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateBrainBucket = (id, data, options = {}) => request(`/brain/buckets/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteBrainBucket = (id, options = {}) => request(`/brain/buckets/${id}`, { method: 'DELETE', ...options });
export const reorderBrainBuckets = (ids, options = {}) => request('/brain/buckets/reorder', {
  method: 'POST',
  body: JSON.stringify({ ids }),
  ...options
});

// Brain - Goals (identity system, read-only view for the graph detail panel)
export const getBrainGoal = (id) =>
  request('/digital-twin/identity/goals').then(data =>
    (data?.goals ?? []).find(g => g.id === id) ?? null
  );

// Brain - Journal entries (Daily Log)
export const getBrainJournalEntry = (date) =>
  request(`/brain/daily-log/${encodeURIComponent(date)}`).then(r => r?.entry ?? null);

// Brain - Graph. Bounded by design: no `focus` returns an overview of the
// most-connected nodes; a `focus` returns that node's neighborhood. The full
// graph is never returned (it crashes the browser at scale).
export const getBrainGraph = ({ focus, limit } = {}) => {
  const params = new URLSearchParams();
  if (focus) params.set('focus', focus);
  if (limit) params.set('limit', limit);
  const qs = params.toString();
  return request(`/brain/graph${qs ? `?${qs}` : ''}`);
};
// Lightweight {id,label,brainType} list of every node, for the search box.
export const getBrainGraphSearchIndex = () => request('/brain/graph/search-index');
// Count of active records missing an embedding (powers "Embed missing").
export const getEmbeddingsStatus = () => request('/brain/embeddings/status');

// Brain - Bridge Sync (brain data to CoS memory system).
// refresh:true re-embeds already-mapped records to heal memory entries that
// went stale before the per-record sync signal existed (issue #1080).
// onlyMissing:true is the cheap targeted backfill — embeds only records lacking
// an embedding, skipping everything healthy.
// `options` (e.g. { silent: true }) passes through to the request helper so a
// caller with its own error toast doesn't get a duplicate from the helper.
export const syncBrainData = ({ refresh = false, onlyMissing = false } = {}, options = {}) =>
  request('/brain/bridge-sync', { method: 'POST', body: JSON.stringify({ refresh, onlyMissing }), ...options });

// Brain - Daily Log
export const listDailyLogs = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  return request(`/brain/daily-log?${params}`);
};
export const getDailyLog = (date = 'today') => request(`/brain/daily-log/${encodeURIComponent(date)}`);
export const appendDailyLog = (date, text, source = 'text') => request(
  `/brain/daily-log/${encodeURIComponent(date)}/append`,
  { method: 'POST', body: JSON.stringify({ text, source }) }
);
export const updateDailyLog = (date, content) => request(
  `/brain/daily-log/${encodeURIComponent(date)}`,
  { method: 'PUT', body: JSON.stringify({ content }) }
);
export const deleteDailyLog = (date) => request(
  `/brain/daily-log/${encodeURIComponent(date)}`,
  { method: 'DELETE' }
);
export const getDailyLogSettings = () => request('/brain/daily-log/settings');
export const updateDailyLogSettings = (settings) => request('/brain/daily-log/settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const syncDailyLogsToObsidian = () => request('/brain/daily-log/sync-obsidian', { method: 'POST' });
