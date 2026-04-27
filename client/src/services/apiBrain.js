import { request } from './apiCore.js';

// Brain - Second Brain Feature
export const getBrainSummary = () => request('/brain/summary');
export const getBrainSettings = () => request('/brain/settings');
export const updateBrainSettings = (settings) => request('/brain/settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});

// Brain - Capture & Inbox
export const captureBrainThought = (text, providerOverride, modelOverride) => request('/brain/capture', {
  method: 'POST',
  body: JSON.stringify({ text, providerOverride, modelOverride })
});
export const getBrainInbox = (options = {}) => {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  return request(`/brain/inbox?${params}`);
};
export const getBrainInboxEntry = (id) => request(`/brain/inbox/${id}`);
export const resolveBrainReview = (inboxLogId, destination, editedExtracted) => request('/brain/review/resolve', {
  method: 'POST',
  body: JSON.stringify({ inboxLogId, destination, editedExtracted })
});
export const fixBrainClassification = (inboxLogId, newDestination, updatedFields, note) => request('/brain/fix', {
  method: 'POST',
  body: JSON.stringify({ inboxLogId, newDestination, updatedFields, note })
});
export const retryBrainClassification = (id, providerOverride, modelOverride) => request(`/brain/inbox/${id}/retry`, {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride })
});
export const updateBrainInboxEntry = (id, capturedText) => request(`/brain/inbox/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ capturedText })
});
export const deleteBrainInboxEntry = (id) => request(`/brain/inbox/${id}`, { method: 'DELETE' });
export const markBrainInboxDone = (id) => request(`/brain/inbox/${id}/done`, { method: 'POST' });

// Brain - People
export const getBrainPeople = () => request('/brain/people');
export const getBrainPerson = (id) => request(`/brain/people/${id}`);
export const createBrainPerson = (data) => request('/brain/people', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateBrainPerson = (id, data) => request(`/brain/people/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteBrainPerson = (id) => request(`/brain/people/${id}`, { method: 'DELETE' });

// Brain - Projects
export const getBrainProjects = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/projects?${params}`);
};
export const getBrainProject = (id) => request(`/brain/projects/${id}`);
export const createBrainProject = (data) => request('/brain/projects', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateBrainProject = (id, data) => request(`/brain/projects/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteBrainProject = (id) => request(`/brain/projects/${id}`, { method: 'DELETE' });

// Brain - Ideas
export const getBrainIdeas = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/ideas?${params}`);
};
export const getBrainIdea = (id) => request(`/brain/ideas/${id}`);
export const createBrainIdea = (data) => request('/brain/ideas', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateBrainIdea = (id, data) => request(`/brain/ideas/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteBrainIdea = (id) => request(`/brain/ideas/${id}`, { method: 'DELETE' });

// Brain - Admin
export const getBrainAdmin = (filters) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  return request(`/brain/admin?${params}`);
};
export const getBrainAdminItem = (id) => request(`/brain/admin/${id}`);
export const createBrainAdminItem = (data) => request('/brain/admin', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateBrainAdminItem = (id, data) => request(`/brain/admin/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteBrainAdminItem = (id) => request(`/brain/admin/${id}`, { method: 'DELETE' });

// Brain - Memories
export const getBrainMemories = () => request('/brain/memories');
export const getBrainMemory = (id) => request(`/brain/memories/${id}`);
export const createBrainMemory = (data) => request('/brain/memories', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateBrainMemory = (id, data) => request(`/brain/memories/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteBrainMemory = (id) => request(`/brain/memories/${id}`, { method: 'DELETE' });

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

// Brain - Digests & Reviews
export const getBrainLatestDigest = () => request('/brain/digest/latest');
export const getBrainDigests = (limit = 10) => request(`/brain/digests?limit=${limit}`);
export const runBrainDigest = (providerOverride, modelOverride) => request('/brain/digest/run', {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride })
});
export const getBrainLatestReview = () => request('/brain/review/latest');
export const getBrainReviews = (limit = 10) => request(`/brain/reviews?limit=${limit}`);
export const runBrainReview = (providerOverride, modelOverride) => request('/brain/review/run', {
  method: 'POST',
  body: JSON.stringify({ providerOverride, modelOverride })
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
export const updateBrainLink = (id, data) => request(`/brain/links/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteBrainLink = (id) => request(`/brain/links/${id}`, { method: 'DELETE' });
export const cloneBrainLink = (id) => request(`/brain/links/${id}/clone`, { method: 'POST' });
export const pullBrainLink = (id) => request(`/brain/links/${id}/pull`, { method: 'POST' });
export const openBrainLinkFolder = (id) => request(`/brain/links/${id}/open-folder`, { method: 'POST' });

// Brain - Graph
export const getBrainGraph = () => request('/brain/graph');

// Brain - Bridge Sync (brain data to CoS memory system)
export const syncBrainData = () => request('/brain/bridge-sync', { method: 'POST' });

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
