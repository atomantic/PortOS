import { request } from './apiCore.js';

// Alerts
export const getAlertsSummary = (options) => request('/alerts/summary', options);

// Health
export const checkHealth = () => request('/system/health');
export const getSystemHealth = (options) => request('/system/health/details', options);

// Update
export const getUpdateStatus = () => request('/update/status');
export const checkForUpdate = () => request('/update/check', { method: 'POST' });
export const ignoreUpdateVersion = (version) => request('/update/ignore', {
  method: 'POST',
  body: JSON.stringify({ version })
});
export const clearIgnoredVersions = () => request('/update/ignore', { method: 'DELETE' });
export const executePortosUpdate = () => request('/update/execute', { method: 'POST' });

// Settings
export const getSettings = () => request('/settings');
export const updateSettings = (data) => request('/settings', {
  method: 'PUT',
  body: JSON.stringify(data)
});

// Usage
export const getUsage = () => request('/usage');
export const getUsageRaw = () => request('/usage/raw');
export const resetUsage = () => request('/usage', { method: 'DELETE' });

// Backup
export const getBackupStatus = (options) => request('/backup/status', options);
export const triggerBackup = () => request('/backup/run', { method: 'POST' });
export const getBackupSnapshots = (options) => request('/backup/snapshots', options);
export const restoreBackup = (data) => request('/backup/restore', { method: 'POST', body: JSON.stringify(data) });

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
export const updateBrowserConfig = (config) => request('/browser/config', {
  method: 'PUT',
  body: JSON.stringify(config)
});
export const launchBrowser = () => request('/browser/launch', { method: 'POST' });
export const stopBrowser = () => request('/browser/stop', { method: 'POST' });
export const restartBrowser = () => request('/browser/restart', { method: 'POST' });
export const getBrowserHealth = () => request('/browser/health');
export const getBrowserProcess = () => request('/browser/process');
export const getBrowserPages = () => request('/browser/pages');
export const getBrowserVersion = () => request('/browser/version');
export const getBrowserLogs = (lines = 50) => request(`/browser/logs?lines=${lines}`);
export const getBrowserDownloads = () => request('/browser/downloads');
export const navigateBrowser = (url) => request('/browser/navigate', {
  method: 'POST',
  body: JSON.stringify({ url })
});

// Instances (Federation)
export const getInstances = () => request('/instances');
export const getSelfInstance = () => request('/instances/self');
export const updateSelfInstance = (data) => request('/instances/self', { method: 'PUT', body: JSON.stringify(data) });
export const addPeer = (data) => request('/instances/peers', { method: 'POST', body: JSON.stringify(data) });
export const updatePeer = (id, data) => request(`/instances/peers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const removePeer = (id) => request(`/instances/peers/${id}`, { method: 'DELETE' });
export const connectPeer = (id) => request(`/instances/peers/${id}/connect`, { method: 'POST' });
export const probePeer = (id) => request(`/instances/peers/${id}/probe`, { method: 'POST' });
export const queryPeer = (id, path) => request(`/instances/peers/${id}/query?path=${encodeURIComponent(path)}`);

// Image Generation
export const getImageGenStatus = () => request('/image-gen/status');
export const generateImage = (data) => request('/image-gen/generate', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const generateAvatar = (data) => request('/image-gen/avatar', {
  method: 'POST',
  body: JSON.stringify(data)
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

// JIRA
export const getJiraInstances = () => request('/jira/instances');
export const getJiraProjects = (instanceId) => request(`/jira/instances/${instanceId}/projects`);
export const getMySprintTickets = (instanceId, projectKey) => request(`/jira/instances/${instanceId}/my-sprint-tickets/${projectKey}`);
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
