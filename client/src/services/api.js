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
    throw new Error(error.error || `HTTP ${response.status}`);
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

// Logs
export const getProcesses = () => request('/logs/processes');
export const getProcessLogs = (processName, lines = 100) =>
  request(`/logs/${encodeURIComponent(processName)}?lines=${lines}`);

/**
 * Create SSE connection for streaming logs
 * @param {string} processName - PM2 process name
 * @param {number} lines - Initial lines to fetch
 * @param {function} onMessage - Callback for each log line
 * @param {function} onError - Error callback
 * @returns {function} Cleanup function to close connection
 */
export const streamLogs = (processName, lines, onMessage, onError) => {
  const url = `/api/logs/${encodeURIComponent(processName)}?follow=true&lines=${lines}`;
  const eventSource = new EventSource(url);

  eventSource.addEventListener('stdout', (e) => {
    const data = JSON.parse(e.data);
    onMessage({ ...data, type: 'stdout' });
  });

  eventSource.addEventListener('stderr', (e) => {
    const data = JSON.parse(e.data);
    onMessage({ ...data, type: 'stderr' });
  });

  eventSource.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    onMessage({ type: 'connected', ...data });
  });

  eventSource.addEventListener('error', (e) => {
    onError?.(e);
  });

  eventSource.addEventListener('close', () => {
    eventSource.close();
  });

  return () => eventSource.close();
};

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
export const getRuns = (limit = 50, offset = 0) =>
  request(`/runs?limit=${limit}&offset=${offset}`);
export const createRun = (data) => request('/runs', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getRun = (id) => request(`/runs/${id}`);
export const getRunOutput = (id) => request(`/runs/${id}/output`);
export const stopRun = (id) => request(`/runs/${id}/stop`, { method: 'POST' });
export const deleteRun = (id) => request(`/runs/${id}`, { method: 'DELETE' });

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
