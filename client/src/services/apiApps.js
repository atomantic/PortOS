import toast from '../components/ui/Toast';
import { request, API_BASE } from './apiCore.js';

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
export const upgradeAppTls = (id, body) => request(`/apps/${id}/upgrade-tls`, {
  method: 'POST',
  body: JSON.stringify(body),
  silent: true  // caller shows custom toasts (ALREADY_EXISTS steers to overwrite button)
});

/**
 * Handle PortOS self-restart: show a loading toast, poll for server recovery, then reload.
 * Call this after restartApp() returns { selfRestart: true }.
 */
export function handleSelfRestart() {
  toast.loading('Restarting PortOS...', { id: 'self-restart', duration: Infinity });
  const poll = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const ok = await fetch(`${API_BASE}/system/health`).then(() => true).catch(() => false);
      if (ok) {
        toast.success('PortOS restarted successfully', { id: 'self-restart' });
        setTimeout(() => window.location.reload(), 1000);
        return;
      }
    }
    toast.error('PortOS restart timed out — try reloading manually', { id: 'self-restart' });
  };
  poll();
}
export const archiveApp = (id) => request(`/apps/${id}/archive`, { method: 'POST' });
export const unarchiveApp = (id) => request(`/apps/${id}/unarchive`, { method: 'POST' });
export const openAppInEditor = (id) => request(`/apps/${id}/open-editor`, { method: 'POST' });
export const openAppInClaude = (id) => request(`/apps/${id}/open-claude`, { method: 'POST' });
export const openAppFolder = (id) => request(`/apps/${id}/open-folder`, { method: 'POST' });
export const refreshAppConfig = (id) => request(`/apps/${id}/refresh-config`, { method: 'POST' });
export const pullAndUpdateApp = (id) => request(`/apps/${id}/update`, { method: 'POST' });
export const buildApp = (id) => request(`/apps/${id}/build`, { method: 'POST' });
export const getAppStatus = (id) => request(`/apps/${id}/status`);
export const getAppTaskTypes = (id) => request(`/apps/${id}/task-types`);
export const toggleAllAppTaskTypes = (id, enabled) => request(`/apps/${id}/task-types/all`, {
  method: 'PUT',
  body: JSON.stringify({ enabled })
});
export const updateAppTaskTypeOverride = (id, taskType, { enabled, interval, taskMetadata } = {}) => request(`/apps/${id}/task-types/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled, interval, taskMetadata })
});
export const bulkUpdateAppTaskTypeOverride = (taskType, { enabled }) => request(`/apps/bulk-task-type/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled })
});
export const detectAppIcons = () => request('/apps/detect-icons', { method: 'POST' });
export const detectAppIcon = (id) => request(`/apps/${id}/detect-icon`, { method: 'POST' });
export const getAppLogs = (id, lines = 100, processName) => {
  const params = new URLSearchParams({ lines: String(lines) });
  if (processName) params.set('process', processName);
  return request(`/apps/${id}/logs?${params}`);
};

export const installXcodeScripts = (id, scripts) => request(`/apps/${id}/xcode-scripts/install`, {
  method: 'POST',
  body: JSON.stringify({ scripts })
});
export const getAppDocuments = (id) => request(`/apps/${id}/documents`);
export const getAppDocument = (id, filename) => request(`/apps/${id}/documents/${filename}`);
export const saveAppDocument = (id, filename, content, commitMessage) =>
  request(`/apps/${id}/documents/${filename}`, {
    method: 'PUT',
    body: JSON.stringify({ content, ...(commitMessage && { commitMessage }) })
  });
export const getAppAgents = (id, limit = 50) => request(`/apps/${id}/agents?limit=${limit}`);
