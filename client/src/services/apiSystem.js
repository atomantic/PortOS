import { request } from './apiCore.js';

// Alerts
export const getAlertsSummary = (options) => request('/alerts/summary', options);

// Character sheet (D&D-style XP / level / HP — powers the CyberCity XP HUD badge)
export const getCharacter = (options) => request('/character', options);

// Health
export const checkHealth = (options) => request('/system/health', options);
export const getSystemHealth = (options) => request('/system/health/details', options);
export const getNetworkExposure = (options) => request('/network-exposure/status', options);
export const getCapabilities = (options) => request('/capabilities', options);
export const updateHealthThresholds = (thresholds, options = {}) => request('/system/health/thresholds', {
  method: 'PUT',
  body: JSON.stringify(thresholds),
  ...options
});

// Update
export const getUpdateStatus = () => request('/update/status');
export const checkForUpdate = () => request('/update/check', { method: 'POST' });
export const ignoreUpdateVersion = (version) => request('/update/ignore', {
  method: 'POST',
  body: JSON.stringify({ version })
});
export const clearIgnoredVersions = () => request('/update/ignore', { method: 'DELETE' });
export const executePortosUpdate = (opts) => {
  const body = opts && Object.keys(opts).length ? JSON.stringify(opts) : undefined;
  return request('/update/execute', body ? { method: 'POST', body } : { method: 'POST' });
};
export const syncPortosFork = (opts = {}, requestOpts = {}) => request('/update/sync-fork', {
  method: 'POST',
  body: JSON.stringify(opts),
  ...requestOpts
});

// Settings
export const getSettings = (options) => request('/settings', options);
export const updateSettings = (data, options) => request('/settings', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const getAiAssignments = (options) => request('/settings/ai-assignments', options);

// API Access — the OpenAPI 3.1 spec for the public API surface (built from the
// exposed entries in apiAccess settings). Rendered by the API Access settings tab.
export const getOpenApiSpec = (options) => request('/api-docs/openapi.json', options);
export const updateAiAssignment = (id, data, options) => request(`/settings/ai-assignments/${encodeURIComponent(id)}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});

const isPlainObject = (v) =>
  v != null && typeof v === 'object' && !Array.isArray(v);

// PUT /api/settings shallow-merges top-level keys only — patching
// `{ imageGen: { local: { pythonPath } } }` directly clobbers the rest of
// `imageGen`. patchSettingsSlice fetches current settings, walks to the slice
// at a dotted path, shallow-merges `partial` into it, and PUTs the rebuilt
// top-level key so sibling subkeys survive. `options` flows through to the
// final updateSettings (e.g. `{ silent: true }`).
//
// Non-object values along the path (a hand-edited settings.json with an
// unexpected primitive/array at a slice or parent) are treated as absent so
// they don't spread into character-indexed or numeric-indexed keys.
export const patchSettingsSlice = async (slicePath, partial, options = {}) => {
  if (typeof slicePath !== 'string' || !slicePath) {
    throw new Error('patchSettingsSlice: slicePath required');
  }
  if (!isPlainObject(partial)) {
    throw new Error('patchSettingsSlice: partial must be a plain object');
  }
  const segments = slicePath.split('.');
  if (!segments.every(Boolean)) {
    throw new Error('patchSettingsSlice: slicePath has empty segments');
  }
  const current = await getSettings({ silent: true }).catch(() => ({}));
  let existing = current;
  for (const seg of segments) existing = existing?.[seg];
  let updated = { ...(isPlainObject(existing) ? existing : {}), ...partial };
  for (let i = segments.length - 1; i > 0; i--) {
    let parent = current;
    for (let j = 0; j < i; j++) parent = parent?.[segments[j]];
    updated = { ...(isPlainObject(parent) ? parent : {}), [segments[i]]: updated };
  }
  return updateSettings({ [segments[0]]: updated }, options);
};

// Usage
export const getUsage = () => request('/usage');
export const getUsageRaw = () => request('/usage/raw');
export const resetUsage = () => request('/usage', { method: 'DELETE' });

// Backup
export const getBackupStatus = (options) => request('/backup/status', options);
export const triggerBackup = (options) => request('/backup/run', { method: 'POST', ...options });
export const getBackupSnapshots = (options) => request('/backup/snapshots', options);
export const restoreBackup = (data, options = {}) => request('/backup/restore', { method: 'POST', body: JSON.stringify(data), ...options });
export const restoreDatabase = (data, options) => request('/backup/restore-db', { method: 'POST', body: JSON.stringify(data), ...options });

// Data Manager
export const getDataOverview = () => request('/data');
export const getDataCategory = (key) => request(`/data/${key}`);
export const archiveDataCategory = (key, opts) => request(`/data/${key}/archive`, { method: 'POST', body: JSON.stringify(opts || {}) });
export const purgeDataCategory = (key, opts) => request(`/data/${key}`, { method: 'DELETE', body: JSON.stringify(opts || {}) });
export const getDataBackups = () => request('/data/backups');
export const deleteDataBackup = (filename) => request(`/data/backups/${filename}`, { method: 'DELETE' });

// Notifications
export const getNotifications = (options = {}) => {
  const params = new URLSearchParams();
  if (options.type) params.set('type', options.type);
  if (options.unreadOnly) params.set('unreadOnly', 'true');
  if (options.limit) params.set('limit', options.limit);
  return request(`/notifications?${params}`);
};
export const getNotificationCount = () => request('/notifications/count');
export const getNotificationCounts = () => request('/notifications/counts');
export const markNotificationRead = (id) => request(`/notifications/${id}/read`, { method: 'POST' });
export const markAllNotificationsRead = () => request('/notifications/read-all', { method: 'POST' });
export const deleteNotification = (id) => request(`/notifications/${id}`, { method: 'DELETE' });
export const clearNotifications = () => request('/notifications', { method: 'DELETE' });

// Telegram
export const getTelegramStatus = () => request('/telegram/status');
export const updateTelegramConfig = (data) => request('/telegram/config', {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteTelegramConfig = () => request('/telegram/config', { method: 'DELETE' });
export const testTelegram = (message) => request('/telegram/test', {
  method: 'POST',
  body: JSON.stringify({ message })
});
export const updateTelegramForwardTypes = (forwardTypes) => request('/telegram/forward-types', {
  method: 'PUT',
  body: JSON.stringify({ forwardTypes })
});
export const updateTelegramMethod = (method) => request('/telegram/method', {
  method: 'PUT',
  body: JSON.stringify({ method })
});
export const reloadTelegramBridge = () => request('/telegram/bridge/reload', { method: 'POST' });

// Browser - CDP browser management
export const getBrowserStatus = () => request('/browser');
export const getBrowserConfig = () => request('/browser/config');
export const updateBrowserConfig = (config, options = {}) => request('/browser/config', {
  method: 'PUT',
  body: JSON.stringify(config),
  ...options
});
export const launchBrowser = (options = {}) => request('/browser/launch', { method: 'POST', ...options });
export const stopBrowser = (options = {}) => request('/browser/stop', { method: 'POST', ...options });
export const restartBrowser = (options = {}) => request('/browser/restart', { method: 'POST', ...options });
export const getBrowserHealth = () => request('/browser/health');
export const getBrowserProcess = () => request('/browser/process');
export const getBrowserPages = () => request('/browser/pages');
export const getBrowserVersion = () => request('/browser/version');
export const getBrowserLogs = (lines = 50) => request(`/browser/logs?lines=${lines}`);
export const getBrowserDownloads = () => request('/browser/downloads');
export const deleteBrowserDownload = (name, options = {}) =>
  request(`/browser/downloads/${encodeURIComponent(name)}`, { method: 'DELETE', ...options });
export const browserDownloadUrl = (name) =>
  `/api/browser/downloads/${encodeURIComponent(name)}`;
export const navigateBrowser = (url, options = {}) => request('/browser/navigate', {
  method: 'POST',
  body: JSON.stringify({ url }),
  ...options
});

// Instances (Federation)
export const getInstances = (options) => request('/instances', options);
export const getSelfInstance = (options) => request('/instances/self', options);
export const updateSelfInstance = (data) => request('/instances/self', { method: 'PUT', body: JSON.stringify(data) });
export const addPeer = (data) => request('/instances/peers', { method: 'POST', body: JSON.stringify(data) });
export const updatePeer = (id, data) => request(`/instances/peers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const removePeer = (id) => request(`/instances/peers/${id}`, { method: 'DELETE' });
export const connectPeer = (id) => request(`/instances/peers/${id}/connect`, { method: 'POST' });
export const reciprocatePeer = (id, options) => request(`/instances/peers/${id}/reciprocate`, { method: 'POST', ...options });
export const probePeer = (id) => request(`/instances/peers/${id}/probe`, { method: 'POST' });
export const syncPeer = (id, options) => request(`/instances/peers/${id}/sync`, { method: 'POST', ...options });
export const getPeerFullSyncCoverage = (id, options) => request(`/instances/peers/${id}/full-sync-coverage`, options);
export const queryPeer = (id, path) => request(`/instances/peers/${id}/query?path=${encodeURIComponent(path)}`);
export const getTailnetInfo = () => request('/instances/tailnet-suffix');
export const provisionTailnetCert = () => request('/instances/provision-cert', { method: 'POST' });

// Image Generation
export const getImageGenStatus = (mode) => request(`/image-gen/status${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`);
export const generateImage = (data, options = {}) => request('/image-gen/generate', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
// Curated style presets — code-static on the server, so cache the in-flight
// promise and reuse it for the lifetime of the page. Eliminates the repeat
// fetch when the user navigates ImageGen → VideoGen → Writers Room.
let stylePresetsPromise = null;
export const listImageStylePresets = () => {
  if (!stylePresetsPromise) {
    stylePresetsPromise = request('/image-gen/style-presets').catch((err) => {
      stylePresetsPromise = null;
      throw err;
    });
  }
  return stylePresetsPromise;
};
export const generateAvatar = (data, options = {}) => request('/image-gen/avatar', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
// Save an uploaded image into the gallery (`/data/images/`) and get back its
// `{ filename, path }`. Use this (not the generic `uploadFile`) when the stored
// URL must sync to peers — the `image` asset path only ships `/data/images/<f>`.
export const uploadGalleryImage = (base64Data, options = {}) => request('/image-gen/upload', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data }),
  ...options,
});

// Tools Registry
export const getToolsList = () => request('/tools');
export const getEnabledTools = () => request('/tools/enabled');
export const registerTool = (data) => request('/tools', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateTool = (id, data) => request(`/tools/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteTool = (id) => request(`/tools/${id}`, { method: 'DELETE' });

// DataDog
export const getDatadogInstances = () => request('/datadog/instances');
export const searchDatadogErrors = (instanceId, serviceName, environment, fromTime, options) =>
  request(`/datadog/instances/${instanceId}/search-errors`, {
    method: 'POST',
    body: JSON.stringify({ serviceName, environment, fromTime }),
    ...options
  });

// JIRA
export const getJiraInstances = () => request('/jira/instances');
export const getJiraProjects = (instanceId, options) => request(`/jira/instances/${instanceId}/projects`, options);
export const getJiraBoards = (instanceId, projectKey, options) =>
  request(`/jira/instances/${instanceId}/projects/${encodeURIComponent(projectKey)}/boards`, options);
export const getJiraBoardSprints = (instanceId, boardId, options) =>
  request(`/jira/instances/${instanceId}/boards/${encodeURIComponent(boardId)}/sprints`, options);
export const searchJiraEpics = (instanceId, projectKey, query, options) =>
  request(`/jira/instances/${instanceId}/projects/${encodeURIComponent(projectKey)}/epics?q=${encodeURIComponent(query || '')}`, options);
export const getJiraIssue = (instanceId, issueKey, options) =>
  request(`/jira/instances/${instanceId}/issues/${encodeURIComponent(issueKey)}`, options);
export const getMySprintTickets = (instanceId, projectKey, options) => request(`/jira/instances/${instanceId}/my-sprint-tickets/${projectKey}`, options);
export const getJiraBoardColumns = (instanceId, projectKey, boardId, options) =>
  request(`/jira/instances/${instanceId}/board-columns/${projectKey}${boardId ? `?boardId=${encodeURIComponent(boardId)}` : ''}`, options);
export const getJiraTicketTransitions = (instanceId, ticketId, options) => request(`/jira/instances/${instanceId}/tickets/${ticketId}/transitions`, options);
export const transitionJiraTicket = (instanceId, ticketId, transitionId, options) => request(`/jira/instances/${instanceId}/tickets/${ticketId}/transition`, {
  method: 'POST',
  body: JSON.stringify({ transitionId }),
  ...options
});

// JIRA Status Reports
export const getJiraReports = () => request('/jira/reports');
export const generateJiraReport = (appId) => request('/jira/reports/generate', {
  method: 'POST',
  body: JSON.stringify(appId ? { appId } : {})
});
export const getJiraReport = (appId, date) => request(`/jira/reports/${appId}/${date}`);
export const getLatestJiraReport = (appId) => request(`/jira/reports/${appId}/latest`);

// PM2 Standardization
export const analyzeStandardization = (repoPath, providerId) => request('/standardize/analyze', {
  method: 'POST',
  body: JSON.stringify({ repoPath, providerId })
});
export const analyzeStandardizationByApp = (appId, providerId) => request('/standardize/analyze', {
  method: 'POST',
  body: JSON.stringify({ appId, providerId })
});
export const applyStandardization = (repoPath, plan) => request('/standardize/apply', {
  method: 'POST',
  body: JSON.stringify({ repoPath, plan })
});
export const applyStandardizationByApp = (appId, plan) => request('/standardize/apply', {
  method: 'POST',
  body: JSON.stringify({ appId, plan })
});
export const getStandardizeTemplate = () => request('/standardize/template');
export const createGitBackup = (repoPath) => request('/standardize/backup', {
  method: 'POST',
  body: JSON.stringify({ repoPath })
});

// Insights
export const getInsightThemes = () => request('/insights/themes');
export const refreshInsightThemes = (providerId, model) => request('/insights/themes/refresh', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const getInsightNarrative = () => request('/insights/narrative');
export const refreshInsightNarrative = (providerId, model) => request('/insights/narrative/refresh', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});

// Media - Server media devices
export const getMediaDevices = () => request('/media/devices');
export const getMediaStatus = () => request('/media/status');
export const startMediaStream = (videoDeviceId, audioDeviceId, video = true, audio = true) => request('/media/start', {
  method: 'POST',
  body: JSON.stringify({ videoDeviceId, audioDeviceId, video, audio })
});
export const stopMediaStream = () => request('/media/stop', { method: 'POST' });
