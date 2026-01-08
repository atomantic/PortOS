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

// CoS Learning
export const getCosLearning = () => request('/cos/learning');
export const getCosLearningDurations = () => request('/cos/learning/durations');
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
