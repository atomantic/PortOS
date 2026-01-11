import toast from 'react-hot-toast';

const API_BASE = '/api';

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };

  const response = await fetch(url, config);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    const errorMessage = error.error || `HTTP ${response.status}`;
    toast.error(errorMessage);
    throw new Error(errorMessage);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// Health
export const checkHealth = () => request('/health');

// Apps
export const getApps = () => request('/apps');
export const getApp = (id) => request(`/apps/${id}`);
export const createApp = (data) => request('/apps', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateApp = (id, data) => request(`/apps/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteApp = (id) => request(`/apps/${id}`, { method: 'DELETE' });

// App actions
export const startApp = (id) => request(`/apps/${id}/start`, { method: 'POST' });
export const stopApp = (id) => request(`/apps/${id}/stop`, { method: 'POST' });
export const restartApp = (id) => request(`/apps/${id}/restart`, { method: 'POST' });
export const openAppInEditor = (id) => request(`/apps/${id}/open-editor`, { method: 'POST' });
export const openAppFolder = (id) => request(`/apps/${id}/open-folder`, { method: 'POST' });
export const refreshAppConfig = (id) => request(`/apps/${id}/refresh-config`, { method: 'POST' });
export const getAppStatus = (id) => request(`/apps/${id}/status`);
export const getAppLogs = (id, lines = 100, processName) => {
  const params = new URLSearchParams({ lines: String(lines) });
  if (processName) params.set('process', processName);
  return request(`/apps/${id}/logs?${params}`);
};

// Ports
export const scanPorts = () => request('/ports/scan');
export const checkPorts = (ports) => request('/ports/check', {
  method: 'POST',
  body: JSON.stringify({ ports })
});
export const allocatePorts = (count = 1) => request('/ports/allocate', {
  method: 'POST',
  body: JSON.stringify({ count })
});

// Detect
export const detectRepo = (path) => request('/detect/repo', {
  method: 'POST',
  body: JSON.stringify({ path })
});

export const detectPort = (port) => request('/detect/port', {
  method: 'POST',
  body: JSON.stringify({ port })
});

export const detectPm2 = (name) => request('/detect/pm2', {
  method: 'POST',
  body: JSON.stringify({ name })
});

export const detectWithAi = (path, providerId) => request('/detect/ai', {
  method: 'POST',
  body: JSON.stringify({ path, providerId })
});

// Templates & Scaffold
export const getTemplates = () => request('/templates');

export const getDirectories = (path = null) => {
  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/directories${params}`);
};

export const scaffoldApp = (data) => request('/scaffold', {
  method: 'POST',
  body: JSON.stringify(data)
});

export const createFromTemplate = (data) => request('/templates/create', {
  method: 'POST',
  body: JSON.stringify(data)
});

// Providers
export const getProviders = () => request('/providers');
export const getActiveProvider = () => request('/providers/active');
export const setActiveProvider = (id) => request('/providers/active', {
  method: 'PUT',
  body: JSON.stringify({ id })
});
export const getProvider = (id) => request(`/providers/${id}`);
export const createProvider = (data) => request('/providers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateProvider = (id, data) => request(`/providers/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteProvider = (id) => request(`/providers/${id}`, { method: 'DELETE' });
export const testProvider = (id) => request(`/providers/${id}/test`, { method: 'POST' });
export const refreshProviderModels = (id) => request(`/providers/${id}/refresh-models`, { method: 'POST' });

// Runs
export const getRuns = (limit = 50, offset = 0, source = 'all') =>
  request(`/runs?limit=${limit}&offset=${offset}&source=${source}`);
export const createRun = (data) => request('/runs', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getRun = (id) => request(`/runs/${id}`);
export const getRunOutput = (id) => request(`/runs/${id}/output`);
export const getRunPrompt = (id) => request(`/runs/${id}/prompt`);
export const stopRun = (id) => request(`/runs/${id}/stop`, { method: 'POST' });
export const deleteRun = (id) => request(`/runs/${id}`, { method: 'DELETE' });
export const deleteFailedRuns = () => request('/runs?confirm=true', { method: 'DELETE' });

// History
export const getHistory = (options = {}) => {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.action) params.set('action', options.action);
  if (options.success !== undefined) params.set('success', options.success);
  return request(`/history?${params}`);
};
export const getHistoryStats = () => request('/history/stats');
export const getHistoryActions = () => request('/history/actions');
export const clearHistory = (olderThanDays) => request(
  olderThanDays ? `/history?olderThanDays=${olderThanDays}` : '/history',
  { method: 'DELETE' }
);
export const deleteHistoryEntry = (id) => request(`/history/${id}`, { method: 'DELETE' });

// Commands
export const executeCommand = (command, workspacePath) => request('/commands/execute', {
  method: 'POST',
  body: JSON.stringify({ command, workspacePath })
});
export const stopCommand = (id) => request(`/commands/${id}/stop`, { method: 'POST' });
export const getAllowedCommands = () => request('/commands/allowed');
export const getProcessesList = () => request('/commands/processes');

// Git
export const getGitInfo = (path) => request('/git/info', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getGitStatus = (path) => request('/git/status', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getGitDiff = (path, staged = false) => request('/git/diff', {
  method: 'POST',
  body: JSON.stringify({ path, staged })
});
export const getGitCommits = (path, limit = 10) => request('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ path, limit })
});
export const stageFiles = (path, files) => request('/git/stage', {
  method: 'POST',
  body: JSON.stringify({ path, files })
});
export const unstageFiles = (path, files) => request('/git/unstage', {
  method: 'POST',
  body: JSON.stringify({ path, files })
});
export const createCommit = (path, message) => request('/git/commit', {
  method: 'POST',
  body: JSON.stringify({ path, message })
});

// Usage
export const getUsage = () => request('/usage');
export const getUsageRaw = () => request('/usage/raw');
export const resetUsage = () => request('/usage', { method: 'DELETE' });

// Screenshots
export const uploadScreenshot = (base64Data, filename, mimeType) => request('/screenshots', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename, mimeType })
});

// Agents
export const getAgents = () => request('/agents');
export const getAgentInfo = (pid) => request(`/agents/${pid}`);
export const killAgent = (pid) => request(`/agents/${pid}`, { method: 'DELETE' });

// Chief of Staff
export const getCosStatus = () => request('/cos');
export const startCos = () => request('/cos/start', { method: 'POST' });
export const stopCos = () => request('/cos/stop', { method: 'POST' });
export const pauseCos = (reason) => request('/cos/pause', {
  method: 'POST',
  body: JSON.stringify({ reason })
});
export const resumeCos = () => request('/cos/resume', { method: 'POST' });
export const getCosConfig = () => request('/cos/config');
export const updateCosConfig = (config) => request('/cos/config', {
  method: 'PUT',
  body: JSON.stringify(config)
});
export const getCosTasks = () => request('/cos/tasks');
export const addCosTask = (task) => request('/cos/tasks', {
  method: 'POST',
  body: JSON.stringify(task)
});
export const updateCosTask = (id, updates) => request(`/cos/tasks/${id}`, {
  method: 'PUT',
  body: JSON.stringify(updates)
});
export const deleteCosTask = (id) => request(`/cos/tasks/${id}`, { method: 'DELETE' });
export const reorderCosTasks = (taskIds) => request('/cos/tasks/reorder', {
  method: 'POST',
  body: JSON.stringify({ taskIds })
});
export const approveCosTask = (id) => request(`/cos/tasks/${id}/approve`, { method: 'POST' });
export const forceCosEvaluate = () => request('/cos/evaluate', { method: 'POST' });
export const getCosHealth = () => request('/cos/health');
export const forceHealthCheck = () => request('/cos/health/check', { method: 'POST' });
export const getCosAgents = () => request('/cos/agents');
export const getCosAgent = (id) => request(`/cos/agents/${id}`);
export const terminateCosAgent = (id) => request(`/cos/agents/${id}/terminate`, { method: 'POST' });
export const killCosAgent = (id) => request(`/cos/agents/${id}/kill`, { method: 'POST' });
export const getCosAgentStats = (id) => request(`/cos/agents/${id}/stats`);
export const deleteCosAgent = (id) => request(`/cos/agents/${id}`, { method: 'DELETE' });
export const clearCompletedCosAgents = () => request('/cos/agents/completed', { method: 'DELETE' });
export const getCosReports = () => request('/cos/reports');
export const getCosTodayReport = () => request('/cos/reports/today');
export const getCosReport = (date) => request(`/cos/reports/${date}`);

// CoS Activity
export const getCosTodayActivity = () => request('/cos/activity/today');

// CoS Learning
export const getCosLearning = () => request('/cos/learning');
export const getCosLearningDurations = () => request('/cos/learning/durations');
export const getCosLearningSkipped = () => request('/cos/learning/skipped');
export const getCosLearningPerformance = () => request('/cos/learning/performance');
export const backfillCosLearning = () => request('/cos/learning/backfill', { method: 'POST' });

// CoS Scripts
export const getCosScripts = () => request('/cos/scripts');
export const getCosScript = (id) => request(`/cos/scripts/${id}`);
export const createCosScript = (data) => request('/cos/scripts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateCosScript = (id, data) => request(`/cos/scripts/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteCosScript = (id) => request(`/cos/scripts/${id}`, { method: 'DELETE' });
export const runCosScript = (id) => request(`/cos/scripts/${id}/run`, { method: 'POST' });
export const getCosScriptRuns = (id) => request(`/cos/scripts/${id}/runs`);
export const getCosScriptPresets = () => request('/cos/scripts/presets');

// Weekly Digest
export const getCosWeeklyDigest = (weekId = null) => {
  if (weekId) return request(`/cos/digest/${weekId}`);
  return request('/cos/digest');
};
export const listCosWeeklyDigests = () => request('/cos/digest/list');
export const getCosWeekProgress = () => request('/cos/digest/progress');
export const getCosDigestText = async () => {
  const response = await fetch('/api/cos/digest/text');
  return response.text();
};
export const generateCosDigest = (weekId = null) => request('/cos/digest/generate', {
  method: 'POST',
  body: JSON.stringify({ weekId })
});
export const compareCosWeeks = (week1, week2) => request(`/cos/digest/compare?week1=${week1}&week2=${week2}`);

// Task Schedule (Configurable Intervals)
export const getCosSchedule = () => request('/cos/schedule');
export const getCosScheduleIntervalTypes = () => request('/cos/schedule/interval-types');
export const getCosScheduleDueTasks = () => request('/cos/schedule/due');
export const getCosScheduleDueAppTasks = (appId) => request(`/cos/schedule/due/${appId}`);
export const updateCosSelfImprovementInterval = (taskType, settings) => request(`/cos/schedule/self-improvement/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const updateCosAppImprovementInterval = (taskType, settings) => request(`/cos/schedule/app-improvement/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const triggerCosOnDemandTask = (taskType, category = 'selfImprovement', appId = null) => request('/cos/schedule/trigger', {
  method: 'POST',
  body: JSON.stringify({ taskType, category, appId })
});
export const getCosOnDemandRequests = () => request('/cos/schedule/on-demand');
export const resetCosTaskHistory = (taskType, category = 'selfImprovement', appId = null) => request('/cos/schedule/reset', {
  method: 'POST',
  body: JSON.stringify({ taskType, category, appId })
});
export const getCosScheduleTemplates = () => request('/cos/schedule/templates');
export const addCosScheduleTemplate = (template) => request('/cos/schedule/templates', {
  method: 'POST',
  body: JSON.stringify(template)
});
export const deleteCosScheduleTemplate = (templateId) => request(`/cos/schedule/templates/${templateId}`, { method: 'DELETE' });

// Memory
export const getMemories = (options = {}) => {
  const params = new URLSearchParams();
  if (options.types) params.set('types', options.types.join(','));
  if (options.categories) params.set('categories', options.categories.join(','));
  if (options.tags) params.set('tags', options.tags.join(','));
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.sortBy) params.set('sortBy', options.sortBy);
  if (options.sortOrder) params.set('sortOrder', options.sortOrder);
  return request(`/memory?${params}`);
};
export const getMemory = (id) => request(`/memory/${id}`);
export const createMemory = (data) => request('/memory', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateMemory = (id, data) => request(`/memory/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteMemory = (id, hard = false) => request(`/memory/${id}?hard=${hard}`, { method: 'DELETE' });
export const searchMemories = (query, options = {}) => request('/memory/search', {
  method: 'POST',
  body: JSON.stringify({ query, ...options })
});
export const getMemoryCategories = () => request('/memory/categories');
export const getMemoryTags = () => request('/memory/tags');
export const getMemoryTimeline = (options = {}) => {
  const params = new URLSearchParams();
  if (options.startDate) params.set('startDate', options.startDate);
  if (options.endDate) params.set('endDate', options.endDate);
  if (options.types) params.set('types', options.types.join(','));
  if (options.limit) params.set('limit', options.limit);
  return request(`/memory/timeline?${params}`);
};
export const getMemoryGraph = () => request('/memory/graph');
export const getMemoryStats = () => request('/memory/stats');
export const getRelatedMemories = (id, limit = 10) => request(`/memory/${id}/related?limit=${limit}`);
export const linkMemories = (sourceId, targetId) => request('/memory/link', {
  method: 'POST',
  body: JSON.stringify({ sourceId, targetId })
});
export const consolidateMemories = (options = {}) => request('/memory/consolidate', {
  method: 'POST',
  body: JSON.stringify(options)
});
export const getEmbeddingStatus = () => request('/memory/embeddings/status');
export const approveMemory = (id) => request(`/memory/${id}/approve`, { method: 'POST' });
export const rejectMemory = (id) => request(`/memory/${id}/reject`, { method: 'POST' });

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
export const getBrainIdeas = () => request('/brain/ideas');
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

// Media - Server media devices
export const getMediaDevices = () => request('/media/devices');
export const getMediaStatus = () => request('/media/status');
export const startMediaStream = (videoDeviceId, audioDeviceId, video = true, audio = true) => request('/media/start', {
  method: 'POST',
  body: JSON.stringify({ videoDeviceId, audioDeviceId, video, audio })
});
export const stopMediaStream = () => request('/media/stop', { method: 'POST' });

// Default export for simplified imports
export default {
  get: (endpoint, options) => request(endpoint, { method: 'GET', ...options }),
  post: (endpoint, body, options) => request(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    ...options
  }),
  put: (endpoint, body, options) => request(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
    ...options
  }),
  delete: (endpoint, options) => request(endpoint, { method: 'DELETE', ...options })
};
