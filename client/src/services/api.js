import toast from 'react-hot-toast';

const API_BASE = '/api';

// Stable ID for the PortOS baseline app (mirrors server PORTOS_APP_ID)
export const PORTOS_APP_ID = 'portos-default';

async function request(endpoint, options = {}) {
  const { silent, ...fetchOptions } = options;
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers
    },
    ...fetchOptions
  };

  const response = await fetch(url, config);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    const errorMessage = error.error || `HTTP ${response.status}`;
    if (!silent) {
      // Platform unavailability is a warning, not an error
      if (error.code === 'PLATFORM_UNAVAILABLE') {
        toast(errorMessage, { icon: '⚠️' });
      } else {
        toast.error(errorMessage);
      }
    }
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
export const getSystemHealth = (options) => request('/health/system', options);

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
export const archiveApp = (id) => request(`/apps/${id}/archive`, { method: 'POST' });
export const unarchiveApp = (id) => request(`/apps/${id}/unarchive`, { method: 'POST' });
export const openAppInEditor = (id) => request(`/apps/${id}/open-editor`, { method: 'POST' });
export const openAppFolder = (id) => request(`/apps/${id}/open-folder`, { method: 'POST' });
export const refreshAppConfig = (id) => request(`/apps/${id}/refresh-config`, { method: 'POST' });
export const getAppStatus = (id) => request(`/apps/${id}/status`);
export const getAppTaskTypes = (id) => request(`/apps/${id}/task-types`);
export const updateAppTaskTypeOverride = (id, taskType, { enabled, interval } = {}) => request(`/apps/${id}/task-types/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled, interval })
});
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
export const getTemplates = () => request('/scaffold/templates');

export const getDirectories = (path = null) => {
  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/scaffold/directories${params}`);
};

export const scaffoldApp = (data) => request('/scaffold', {
  method: 'POST',
  body: JSON.stringify(data)
});

export const createFromTemplate = (data) => request('/scaffold/templates/create', {
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
export const getSampleProviders = () => request('/providers/samples');
export const testProvider = (id) => request(`/providers/${id}/test`, { method: 'POST' });
export const refreshProviderModels = (id) => request(`/providers/${id}/refresh-models`, { method: 'POST' });

// Provider status (usage limits, availability)
export const getProviderStatuses = () => request('/providers/status');
export const getProviderStatus = (id) => request(`/providers/${id}/status`);
export const recoverProvider = (id) => request(`/providers/${id}/status/recover`, { method: 'POST' });

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
export const updateBranches = (path) => request('/git/update-branches', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const getBranchComparison = (path, base, head) => request('/git/branch-comparison', {
  method: 'POST',
  body: JSON.stringify({ path, base, head })
});
export const pushBranch = (path, branch) => request('/git/push', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const getBranches = (path) => request('/git/branches', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const checkoutBranch = (path, branch) => request('/git/checkout', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
});
export const pullBranch = (path) => request('/git/pull', {
  method: 'POST',
  body: JSON.stringify({ path })
});
export const syncBranch = (path, branch) => request('/git/sync', {
  method: 'POST',
  body: JSON.stringify({ path, branch })
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

// Attachments (generic file uploads for tasks)
export const uploadAttachment = (base64Data, filename) => request('/attachments', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename })
});
export const getAttachment = (filename) => request(`/attachments/${encodeURIComponent(filename)}`);
export const deleteAttachment = (filename) => request(`/attachments/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const listAttachments = () => request('/attachments');

// Uploads (general file storage)
export const uploadFile = (base64Data, filename) => request('/uploads', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename })
});
export const listUploads = () => request('/uploads');
export const getUploadUrl = (filename) => `/api/uploads/${encodeURIComponent(filename)}`;
export const deleteUpload = (filename) => request(`/uploads/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const deleteAllUploads = () => request('/uploads?confirm=true', { method: 'DELETE' });

// Running Agents (Process Management)
export const getRunningAgents = () => request('/agents');
export const getRunningAgentInfo = (pid) => request(`/agents/${pid}`);
export const killRunningAgent = (pid) => request(`/agents/${pid}`, { method: 'DELETE' });
// Legacy aliases
export const getAgents = getRunningAgents;
export const getAgentInfo = getRunningAgentInfo;
export const killAgent = killRunningAgent;

// Agent Personalities
export const getAgentPersonalities = (userId = null) => {
  const params = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  return request(`/agents/personalities${params}`);
};
export const getAgentPersonality = (id) => request(`/agents/personalities/${id}`);
export const createAgentPersonality = (data) => request('/agents/personalities', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAgentPersonality = (id, data) => request(`/agents/personalities/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteAgentPersonality = (id) => request(`/agents/personalities/${id}`, { method: 'DELETE' });
export const toggleAgentPersonality = (id, enabled) => request(`/agents/personalities/${id}/toggle`, {
  method: 'POST',
  body: JSON.stringify({ enabled })
});
export const generateAgentPersonality = (seedData, providerId, model) => request('/agents/personalities/generate', {
  method: 'POST',
  body: JSON.stringify({ seed: seedData, providerId, model })
});

// Platform Accounts
export const getPlatformAccounts = (agentId = null, platform = null) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (platform) params.set('platform', platform);
  const query = params.toString();
  return request(`/agents/accounts${query ? `?${query}` : ''}`);
};
export const getPlatformAccount = (id) => request(`/agents/accounts/${id}`);
export const createPlatformAccount = (data) => request('/agents/accounts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const registerPlatformAccount = (agentId, platform, name, description) => request('/agents/accounts', {
  method: 'POST',
  body: JSON.stringify({ agentId, platform, name, description })
});
export const deletePlatformAccount = (id) => request(`/agents/accounts/${id}`, { method: 'DELETE' });
export const testPlatformAccount = (id) => request(`/agents/accounts/${id}/test`, { method: 'POST' });
export const claimPlatformAccount = (id) => request(`/agents/accounts/${id}/claim`, { method: 'POST' });

// Automation Schedules
export const getAutomationSchedules = (agentId = null, accountId = null) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (accountId) params.set('accountId', accountId);
  const query = params.toString();
  return request(`/agents/schedules${query ? `?${query}` : ''}`);
};
export const getAutomationSchedule = (id) => request(`/agents/schedules/${id}`);
export const getScheduleStats = () => request('/agents/schedules/stats');
export const createAutomationSchedule = (data) => request('/agents/schedules', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAutomationSchedule = (id, data) => request(`/agents/schedules/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteAutomationSchedule = (id) => request(`/agents/schedules/${id}`, { method: 'DELETE' });
export const toggleAutomationSchedule = (id, enabled) => request(`/agents/schedules/${id}/toggle`, {
  method: 'POST',
  body: JSON.stringify({ enabled })
});
export const runAutomationScheduleNow = (id) => request(`/agents/schedules/${id}/run`, { method: 'POST' });

// Agent Tools
export const generateAgentPost = (agentId, accountId, submolt, providerId, model) => request('/agents/tools/generate-post', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, submolt, providerId, model })
});
export const generateAgentComment = (agentId, accountId, postId, parentId, providerId, model) => request('/agents/tools/generate-comment', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, postId, parentId, providerId, model })
});
export const publishAgentPost = (agentId, accountId, submolt, title, content) => request('/agents/tools/publish-post', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, submolt, title, content })
});
export const publishAgentComment = (agentId, accountId, postId, content, parentId) => request('/agents/tools/publish-comment', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, postId, content, parentId })
});
export const engageAgent = (agentId, accountId, maxComments, maxVotes) => request('/agents/tools/engage', {
  method: 'POST',
  body: JSON.stringify({ agentId, accountId, maxComments, maxVotes })
});
export const getAgentFeed = (accountId, sort, limit) => {
  const params = new URLSearchParams({ accountId });
  if (sort) params.set('sort', sort);
  if (limit) params.set('limit', limit);
  return request(`/agents/tools/feed?${params}`);
};
export const getAgentRelevantPosts = (agentId, accountId, maxResults) => {
  const params = new URLSearchParams({ agentId, accountId });
  if (maxResults) params.set('maxResults', maxResults);
  return request(`/agents/tools/relevant-posts?${params}`);
};
export const getAgentSubmolts = (accountId) => request(`/agents/tools/submolts?accountId=${accountId}`);
export const getAgentPost = (accountId, postId) => request(`/agents/tools/post/${postId}?accountId=${accountId}`);
export const getAgentRateLimits = (accountId) => request(`/agents/tools/rate-limits?accountId=${accountId}`);
export const getAgentPublished = (agentId, accountId, days = 7) =>
  request(`/agents/tools/published?agentId=${agentId}&accountId=${accountId}&days=${days}`);
export const checkAgentPosts = (agentId, accountId, days, maxReplies, maxUpvotes) =>
  request('/agents/tools/check-posts', {
    method: 'POST',
    body: JSON.stringify({ agentId, accountId, days, maxReplies, maxUpvotes })
  });

// Moltworld Tools
export const moltworldJoin = (accountId, x, y, thinking, say, sayTo, agentId) =>
  request('/agents/tools/moltworld/join', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, x, y, thinking, say, sayTo })
  });
export const moltworldBuild = (accountId, agentId, x, y, z, type, action) =>
  request('/agents/tools/moltworld/build', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, x, y, z, type, action })
  });
export const moltworldExplore = (accountId, agentId, x, y, thinking) =>
  request('/agents/tools/moltworld/explore', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, x, y, thinking })
  });
export const moltworldStatus = (accountId) =>
  request(`/agents/tools/moltworld/status?accountId=${accountId}`);
export const moltworldBalance = (accountId) =>
  request(`/agents/tools/moltworld/balance?accountId=${accountId}`);
export const moltworldRateLimits = (accountId) =>
  request(`/agents/tools/moltworld/rate-limits?accountId=${accountId}`);
export const moltworldThink = (accountId, thought, agentId) =>
  request('/agents/tools/moltworld/think', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, thought })
  });
export const moltworldSay = (accountId, message, sayTo, agentId) =>
  request('/agents/tools/moltworld/say', {
    method: 'POST',
    body: JSON.stringify({ accountId, agentId, message, ...(sayTo ? { sayTo } : {}) })
  });

// Moltworld Action Queue
export const moltworldGetQueue = (agentId) =>
  request(`/agents/tools/moltworld/queue/${agentId}`);
export const moltworldAddToQueue = (agentId, actionType, params, scheduledFor) =>
  request('/agents/tools/moltworld/queue', {
    method: 'POST',
    body: JSON.stringify({ agentId, actionType, params, scheduledFor })
  });
export const moltworldRemoveFromQueue = (id) =>
  request(`/agents/tools/moltworld/queue/${id}`, { method: 'DELETE' });

// Moltworld WebSocket Relay
export const moltworldWsConnect = (accountId) =>
  request('/agents/tools/moltworld/ws/connect', {
    method: 'POST',
    body: JSON.stringify({ accountId })
  });
export const moltworldWsDisconnect = () =>
  request('/agents/tools/moltworld/ws/disconnect', { method: 'POST' });
export const moltworldWsStatus = () =>
  request('/agents/tools/moltworld/ws/status');
export const moltworldWsMove = (x, y, thought) =>
  request('/agents/tools/moltworld/ws/move', {
    method: 'POST',
    body: JSON.stringify({ x, y, ...(thought ? { thought } : {}) })
  });
export const moltworldWsThink = (thought) =>
  request('/agents/tools/moltworld/ws/think', {
    method: 'POST',
    body: JSON.stringify({ thought })
  });
export const moltworldWsNearby = (radius) =>
  request('/agents/tools/moltworld/ws/nearby', {
    method: 'POST',
    body: JSON.stringify({ ...(radius ? { radius } : {}) })
  });
export const moltworldWsInteract = (to, payload) =>
  request('/agents/tools/moltworld/ws/interact', {
    method: 'POST',
    body: JSON.stringify({ to, payload })
  });

// Agent Drafts
export const getAgentDrafts = (agentId) => request(`/agents/tools/drafts?agentId=${agentId}`);
export const createAgentDraft = (data) => request('/agents/tools/drafts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAgentDraft = (agentId, draftId, data) => request(`/agents/tools/drafts/${draftId}?agentId=${agentId}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteAgentDraft = (agentId, draftId) => request(`/agents/tools/drafts/${draftId}?agentId=${agentId}`, {
  method: 'DELETE'
});

// Agent Activity
export const getAgentActivities = (limit = 50, agentIds = null, action = null) => {
  const params = new URLSearchParams();
  params.set('limit', limit);
  if (agentIds) params.set('agentIds', agentIds.join(','));
  if (action) params.set('action', action);
  return request(`/agents/activity?${params}`);
};
export const getAgentActivityTimeline = (limit = 50, agentIds = null, before = null) => {
  const params = new URLSearchParams();
  params.set('limit', limit);
  if (agentIds) params.set('agentIds', agentIds.join(','));
  if (before) params.set('before', before);
  return request(`/agents/activity/timeline?${params}`);
};
export const getAgentActivityByAgent = (agentId, options = {}) => {
  const params = new URLSearchParams();
  if (options.date) params.set('date', options.date);
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.action) params.set('action', options.action);
  return request(`/agents/activity/agent/${agentId}?${params}`);
};
export const getAgentActivityStats = (agentId, days = 7) =>
  request(`/agents/activity/agent/${agentId}/stats?days=${days}`);

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
export const enhanceCosTaskPrompt = (data) => request('/cos/tasks/enhance', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateCosTask = (id, updates) => request(`/cos/tasks/${id}`, {
  method: 'PUT',
  body: JSON.stringify(updates)
});
export const deleteCosTask = (id, taskType = 'user') => request(`/cos/tasks/${id}?type=${taskType}`, { method: 'DELETE' });
export const reorderCosTasks = (taskIds) => request('/cos/tasks/reorder', {
  method: 'POST',
  body: JSON.stringify({ taskIds })
});
export const approveCosTask = (id) => request(`/cos/tasks/${id}/approve`, { method: 'POST' });
export const forceCosEvaluate = () => request('/cos/evaluate', { method: 'POST' });
export const getCosHealth = () => request('/cos/health');
export const forceHealthCheck = () => request('/cos/health/check', { method: 'POST' });
export const getCosAgents = () => request('/cos/agents');
export const getCosAgentDates = () => request('/cos/agents/history');
export const getCosAgentsByDate = (date) => request(`/cos/agents/history/${date}`);
export const getCosAgent = (id) => request(`/cos/agents/${id}`);
export const terminateCosAgent = (id) => request(`/cos/agents/${id}/terminate`, { method: 'POST' });
export const killCosAgent = (id) => request(`/cos/agents/${id}/kill`, { method: 'POST' });
export const getCosAgentStats = (id) => request(`/cos/agents/${id}/stats`);
export const deleteCosAgent = (id) => request(`/cos/agents/${id}`, { method: 'DELETE' });
export const clearCompletedCosAgents = () => request('/cos/agents/completed', { method: 'DELETE' });
export const submitCosAgentFeedback = (id, feedback) => request(`/cos/agents/${id}/feedback`, {
  method: 'POST',
  body: JSON.stringify(feedback)
});
export const getCosFeedbackStats = () => request('/cos/feedback/stats');
export const getCosReports = () => request('/cos/reports');
export const getCosTodayReport = () => request('/cos/reports/today');
export const getCosReport = (date) => request(`/cos/reports/${date}`);

// CoS Briefings
export const getCosBriefings = () => request('/cos/briefings');
export const getCosLatestBriefing = () => request('/cos/briefings/latest');
export const getCosBriefing = (date) => request(`/cos/briefings/${date}`);

// CoS Activity
export const getCosTodayActivity = () => request('/cos/activity/today');

// CoS Learning
export const getCosLearning = () => request('/cos/learning');
export const getCosLearningDurations = () => request('/cos/learning/durations');
export const getCosLearningSkipped = () => request('/cos/learning/skipped');
export const getCosLearningPerformance = () => request('/cos/learning/performance');
export const getCosLearningRouting = () => request('/cos/learning/routing');
export const getCosLearningSummary = (options) => request('/cos/learning/summary', options);
export const backfillCosLearning = () => request('/cos/learning/backfill', { method: 'POST' });
export const resetCosTaskTypeLearning = (taskType) => request(`/cos/learning/reset/${encodeURIComponent(taskType)}`, { method: 'POST' });

// CoS Quick Task Templates
export const getCosTaskTemplates = () => request('/cos/templates');
export const getCosPopularTemplates = (limit = 5) => request(`/cos/templates/popular?limit=${limit}`);
export const getCosTemplateCategories = () => request('/cos/templates/categories');
export const createCosTaskTemplate = (data) => request('/cos/templates', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const createCosTemplateFromTask = (task, templateName) => request('/cos/templates/from-task', {
  method: 'POST',
  body: JSON.stringify({ task, templateName })
});
export const useCosTaskTemplate = (id) => request(`/cos/templates/${id}/use`, { method: 'POST' });
export const updateCosTaskTemplate = (id, data) => request(`/cos/templates/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteCosTaskTemplate = (id) => request(`/cos/templates/${id}`, { method: 'DELETE' });

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

// Productivity & Streaks
export const getCosProductivity = () => request('/cos/productivity');
export const getCosProductivitySummary = () => request('/cos/productivity/summary');
export const recalculateCosProductivity = () => request('/cos/productivity/recalculate', { method: 'POST' });
export const getCosProductivityTrends = (days = 30) => request(`/cos/productivity/trends?days=${days}`);
export const getCosActivityCalendar = (weeks = 12, options) => request(`/cos/productivity/calendar?weeks=${weeks}`, options);
export const getCosQuickSummary = (options) => request('/cos/quick-summary', options);
export const getCosRecentTasks = (limit = 10, options) => request(`/cos/recent-tasks?limit=${limit}`, options);
export const getCosActionableInsights = () => request('/cos/actionable-insights');
export const getCosGoalProgress = () => request('/cos/goal-progress');
export const getCosGoalProgressSummary = (options) => request('/cos/goal-progress/summary', options);

// Decision Log
export const getCosDecisions = (limit = 20, type = null) => {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (type) params.append('type', type);
  return request(`/cos/decisions?${params}`);
};
export const getCosDecisionSummary = (options) => request('/cos/decisions/summary', options);
export const getCosDecisionPatterns = () => request('/cos/decisions/patterns');

// Task Schedule (Configurable Intervals)
export const getCosUpcomingTasks = (limit = 10) => request(`/cos/upcoming?limit=${limit}`);
export const getCosSchedule = () => request('/cos/schedule');
export const getCosScheduleIntervalTypes = () => request('/cos/schedule/interval-types');
export const getCosScheduleDueTasks = () => request('/cos/schedule/due');
export const getCosScheduleDueAppTasks = (appId) => request(`/cos/schedule/due/${appId}`);
// Unified task interval update
export const updateCosTaskInterval = (taskType, settings) => request(`/cos/schedule/task/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify(settings)
});
// Deprecated aliases — delegate to unified endpoint
export const updateCosSelfImprovementInterval = (taskType, settings) => updateCosTaskInterval(taskType, settings);
export const updateCosAppImprovementInterval = (taskType, settings) => updateCosTaskInterval(taskType, settings);

export const triggerCosOnDemandTask = (taskType, appId = null) => request('/cos/schedule/trigger', {
  method: 'POST',
  body: JSON.stringify({ taskType, appId })
});
export const getCosOnDemandRequests = () => request('/cos/schedule/on-demand');
export const resetCosTaskHistory = (taskType, appId = null) => request('/cos/schedule/reset', {
  method: 'POST',
  body: JSON.stringify({ taskType, appId })
});
export const getCosScheduleTemplates = () => request('/cos/schedule/templates');
export const addCosScheduleTemplate = (template) => request('/cos/schedule/templates', {
  method: 'POST',
  body: JSON.stringify(template)
});
export const deleteCosScheduleTemplate = (templateId) => request(`/cos/schedule/templates/${templateId}`, { method: 'DELETE' });

// Autonomous Jobs
export const getCosJobs = () => request('/cos/jobs');
export const getCosJobsDue = () => request('/cos/jobs/due');
export const getCosJobIntervals = () => request('/cos/jobs/intervals');
export const getCosJob = (id) => request(`/cos/jobs/${id}`);
export const createCosJob = (data) => request('/cos/jobs', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateCosJob = (id, data) => request(`/cos/jobs/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const toggleCosJob = (id) => request(`/cos/jobs/${id}/toggle`, { method: 'POST' });
export const triggerCosJob = (id) => request(`/cos/jobs/${id}/trigger`, { method: 'POST' });
export const deleteCosJob = (id) => request(`/cos/jobs/${id}`, { method: 'DELETE' });

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

// Media - Server media devices
export const getMediaDevices = () => request('/media/devices');
export const getMediaStatus = () => request('/media/status');
export const startMediaStream = (videoDeviceId, audioDeviceId, video = true, audio = true) => request('/media/start', {
  method: 'POST',
  body: JSON.stringify({ videoDeviceId, audioDeviceId, video, audio })
});
export const stopMediaStream = () => request('/media/stop', { method: 'POST' });

// Digital Twin - Status & Summary
export const getDigitalTwinStatus = () => request('/digital-twin');
export const getSoulStatus = getDigitalTwinStatus; // Alias for backwards compatibility

// Digital Twin - Documents
export const getDigitalTwinDocuments = () => request('/digital-twin/documents');
export const getSoulDocuments = getDigitalTwinDocuments;
export const getDigitalTwinDocument = (id) => request(`/digital-twin/documents/${id}`);
export const getSoulDocument = getDigitalTwinDocument;
export const createDigitalTwinDocument = (data) => request('/digital-twin/documents', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const createSoulDocument = createDigitalTwinDocument;
export const updateDigitalTwinDocument = (id, data) => request(`/digital-twin/documents/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const updateSoulDocument = updateDigitalTwinDocument;
export const deleteDigitalTwinDocument = (id) => request(`/digital-twin/documents/${id}`, { method: 'DELETE' });
export const deleteSoulDocument = deleteDigitalTwinDocument;

// Digital Twin - Testing
export const getDigitalTwinTests = () => request('/digital-twin/tests');
export const getSoulTests = getDigitalTwinTests;
export const runDigitalTwinTests = (providerId, model, testIds = null) => request('/digital-twin/tests/run', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, testIds })
});
export const runSoulTests = runDigitalTwinTests;
export const runDigitalTwinMultiTests = (providers, testIds = null) => request('/digital-twin/tests/run-multi', {
  method: 'POST',
  body: JSON.stringify({ providers, testIds })
});
export const runSoulMultiTests = runDigitalTwinMultiTests;
export const getDigitalTwinTestHistory = (limit = 10) => request(`/digital-twin/tests/history?limit=${limit}`);
export const getSoulTestHistory = getDigitalTwinTestHistory;

// Digital Twin - Enrichment
export const getDigitalTwinEnrichCategories = () => request('/digital-twin/enrich/categories');
export const getSoulEnrichCategories = getDigitalTwinEnrichCategories;
export const getDigitalTwinEnrichProgress = () => request('/digital-twin/enrich/progress');
export const getSoulEnrichProgress = getDigitalTwinEnrichProgress;
export const getDigitalTwinEnrichQuestion = (category, providerOverride, modelOverride, skipIndices) => request('/digital-twin/enrich/question', {
  method: 'POST',
  body: JSON.stringify({ category, providerOverride, modelOverride, ...(skipIndices?.length ? { skipIndices } : {}) })
});
export const getSoulEnrichQuestion = getDigitalTwinEnrichQuestion;
export const submitDigitalTwinEnrichAnswer = (data) => request('/digital-twin/enrich/answer', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const submitSoulEnrichAnswer = submitDigitalTwinEnrichAnswer;

// Digital Twin - Export
export const getDigitalTwinExportFormats = () => request('/digital-twin/export/formats');
export const getSoulExportFormats = getDigitalTwinExportFormats;
export const exportDigitalTwin = (format, documentIds = null, includeDisabled = false) => request('/digital-twin/export', {
  method: 'POST',
  body: JSON.stringify({ format, documentIds, includeDisabled })
});
export const exportSoul = exportDigitalTwin;

// Digital Twin - Settings
export const getDigitalTwinSettings = () => request('/digital-twin/settings');
export const getSoulSettings = getDigitalTwinSettings;
export const updateDigitalTwinSettings = (settings) => request('/digital-twin/settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const updateSoulSettings = updateDigitalTwinSettings;

// Digital Twin - Validation & Analysis
export const getDigitalTwinCompleteness = () => request('/digital-twin/validate/completeness');
export const getSoulCompleteness = getDigitalTwinCompleteness;
export const detectDigitalTwinContradictions = (providerId, model) => request('/digital-twin/validate/contradictions', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const detectSoulContradictions = detectDigitalTwinContradictions;
export const generateDigitalTwinTests = (providerId, model) => request('/digital-twin/tests/generate', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const generateSoulTests = generateDigitalTwinTests;
export const analyzeWritingSamples = (samples, providerId, model) => request('/digital-twin/analyze-writing', {
  method: 'POST',
  body: JSON.stringify({ samples, providerId, model })
});

// Digital Twin - List-based Enrichment
export const analyzeEnrichmentList = (category, items, providerId, model) => request('/digital-twin/enrich/analyze-list', {
  method: 'POST',
  body: JSON.stringify({ category, items, providerId, model })
});
export const saveEnrichmentList = (category, content, items) => request('/digital-twin/enrich/save-list', {
  method: 'POST',
  body: JSON.stringify({ category, content, items })
});
export const getEnrichmentListItems = (category) => request(`/digital-twin/enrich/list-items/${category}`);

// --- Digital Twin Traits & Confidence (Phase 1 & 2) ---
export const getDigitalTwinTraits = () => request('/digital-twin/traits');
export const analyzeDigitalTwinTraits = (providerId, model, forceReanalyze = false) => request('/digital-twin/traits/analyze', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, forceReanalyze })
});
export const updateDigitalTwinTraits = (updates) => request('/digital-twin/traits', {
  method: 'PUT',
  body: JSON.stringify(updates)
});
export const getDigitalTwinConfidence = () => request('/digital-twin/confidence');
export const calculateDigitalTwinConfidence = (providerId, model) => request('/digital-twin/confidence/calculate', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const getDigitalTwinGaps = () => request('/digital-twin/gaps');

// --- Digital Twin External Import (Phase 4) ---
export const getDigitalTwinImportSources = () => request('/digital-twin/import/sources');
export const analyzeDigitalTwinImport = (source, data, providerId, model) => request('/digital-twin/import/analyze', {
  method: 'POST',
  body: JSON.stringify({ source, data, providerId, model })
});
export const saveDigitalTwinImport = (source, suggestedDoc) => request('/digital-twin/import/save', {
  method: 'POST',
  body: JSON.stringify({ source, suggestedDoc })
});

// Digital Twin - Taste Questionnaire
export const getTasteProfile = () => request('/digital-twin/taste');
export const getTasteSections = () => request('/digital-twin/taste/sections');
export const getTasteNextQuestion = (section) => request(`/digital-twin/taste/${section}/next`);
export const submitTasteAnswer = (section, questionId, answer) => request('/digital-twin/taste/answer', {
  method: 'POST',
  body: JSON.stringify({ section, questionId, answer })
});
export const getTasteSectionResponses = (section) => request(`/digital-twin/taste/${section}/responses`);
export const generateTasteSummary = (providerId, model, section) => request('/digital-twin/taste/summary', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, ...(section ? { section } : {}) })
});
export const resetTasteSection = (section) => request(`/digital-twin/taste/${section}`, {
  method: 'DELETE'
});

// Digital Twin - Autobiography
export const getAutobiographyStats = () => request('/digital-twin/autobiography');
export const getAutobiographyConfig = () => request('/digital-twin/autobiography/config');
export const updateAutobiographyConfig = (config) => request('/digital-twin/autobiography/config', {
  method: 'PUT',
  body: JSON.stringify(config)
});
export const getAutobiographyThemes = () => request('/digital-twin/autobiography/themes');
export const getAutobiographyPrompt = (exclude) =>
  request(`/digital-twin/autobiography/prompt${exclude ? `?exclude=${exclude}` : ''}`);
export const getAutobiographyPromptById = (id) => request(`/digital-twin/autobiography/prompt/${id}`);
export const getAutobiographyStories = (theme = null) =>
  request(`/digital-twin/autobiography/stories${theme ? `?theme=${theme}` : ''}`);
export const saveAutobiographyStory = (promptId, content) => request('/digital-twin/autobiography/stories', {
  method: 'POST',
  body: JSON.stringify({ promptId, content })
});
export const updateAutobiographyStory = (id, content) => request(`/digital-twin/autobiography/stories/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ content })
});
export const deleteAutobiographyStory = (id) => request(`/digital-twin/autobiography/stories/${id}`, {
  method: 'DELETE'
});
export const triggerAutobiographyPrompt = () => request('/digital-twin/autobiography/trigger', {
  method: 'POST'
});

// Digital Twin - Assessment Analyzer
export const analyzeAssessment = (content, providerId, model) =>
  request('/digital-twin/interview/analyze', {
    method: 'POST',
    body: JSON.stringify({ content, providerId, model })
  });

// Digital Twin - Social Accounts
export const getSocialAccounts = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/digital-twin/social-accounts${qs ? `?${qs}` : ''}`);
};
export const getSocialAccountPlatforms = () => request('/digital-twin/social-accounts/platforms');
export const getSocialAccountStats = () => request('/digital-twin/social-accounts/stats');
export const getSocialAccount = (id) => request(`/digital-twin/social-accounts/${id}`);
export const createSocialAccount = (data) => request('/digital-twin/social-accounts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const createSocialAccountsBulk = (accounts) => request('/digital-twin/social-accounts/bulk', {
  method: 'POST',
  body: JSON.stringify({ accounts })
});
export const updateSocialAccount = (id, data) => request(`/digital-twin/social-accounts/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteSocialAccount = (id) => request(`/digital-twin/social-accounts/${id}`, {
  method: 'DELETE'
});

// Digital Twin - Genome
export const getGenomeSummary = () => request('/digital-twin/genome');
export const uploadGenomeFile = (content, filename) => request('/digital-twin/genome/upload', {
  method: 'POST',
  body: JSON.stringify({ content, filename })
});
export const scanGenomeMarkers = () => request('/digital-twin/genome/scan', { method: 'POST' });
export const searchGenomeSNP = (rsid) => request('/digital-twin/genome/search', {
  method: 'POST',
  body: JSON.stringify({ rsid })
});
export const saveGenomeMarker = (data) => request('/digital-twin/genome/markers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateGenomeMarkerNotes = (id, notes) => request(`/digital-twin/genome/markers/${id}/notes`, {
  method: 'PUT',
  body: JSON.stringify({ notes })
});
export const deleteGenomeMarker = (id) => request(`/digital-twin/genome/markers/${id}`, { method: 'DELETE' });
export const deleteGenomeData = () => request('/digital-twin/genome', { method: 'DELETE' });

// Digital Twin - Genome ClinVar
export const getClinvarStatus = () => request('/digital-twin/genome/clinvar/status');
export const syncClinvar = () => request('/digital-twin/genome/clinvar/sync', { method: 'POST' });
export const scanClinvar = () => request('/digital-twin/genome/clinvar/scan', { method: 'POST' });
export const deleteClinvar = () => request('/digital-twin/genome/clinvar', { method: 'DELETE' });

// Digital Twin - Epigenetic Lifestyle Tracking
export const getEpigeneticInterventions = () => request('/digital-twin/genome/epigenetic');
export const getEpigeneticRecommendations = (categories = []) =>
  request(`/digital-twin/genome/epigenetic/recommendations${categories.length ? `?categories=${categories.join(',')}` : ''}`);
export const getEpigeneticCompliance = (days = 30) =>
  request(`/digital-twin/genome/epigenetic/compliance?days=${days}`);
export const addEpigeneticIntervention = (data) => request('/digital-twin/genome/epigenetic', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const logEpigeneticEntry = (id, entry) => request(`/digital-twin/genome/epigenetic/${id}/log`, {
  method: 'POST',
  body: JSON.stringify(entry)
});
export const updateEpigeneticIntervention = (id, updates) => request(`/digital-twin/genome/epigenetic/${id}`, {
  method: 'PUT',
  body: JSON.stringify(updates)
});
export const deleteEpigeneticIntervention = (id) => request(`/digital-twin/genome/epigenetic/${id}`, {
  method: 'DELETE'
});

// JIRA
export const getJiraInstances = () => request('/jira/instances');
export const getJiraProjects = (instanceId) => request(`/jira/instances/${instanceId}/projects`);
export const getMySprintTickets = (instanceId, projectKey) => request(`/jira/instances/${instanceId}/my-sprint-tickets/${projectKey}`);

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
