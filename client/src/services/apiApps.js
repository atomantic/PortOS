import toast from '../components/ui/Toast';
import { request, API_BASE } from './apiCore.js';

// Apps
export const getApps = (options) => request('/apps', options);
export const getApp = (id) => request(`/apps/${id}`);
// Reverse lookup (#2991): sprite records whose publishBinding.appId targets this
// app. Read-only; the caller owns a .catch fallback, so default to silent.
export const getAppSpriteBindings = (id, options) =>
  request(`/apps/${id}/sprite-bindings`, { silent: true, ...options });
// Resolves what the app's `workTracker` field ('auto' or explicit) actually
// points to: { configured, resolved, host, forge, source }. Read-only — the
// caller (EditAppDrawer) owns its own .catch fallback, so default to silent.
export const getAppWorkTracker = (id, options) =>
  request(`/apps/${id}/work-tracker`, { silent: true, ...options });
// Effective Layered Intelligence config (self-improvement loop) for an app —
// stored partial merged over the shipped defaults. Read-only; saved through
// updateApp (the `layeredIntelligence` key routes to the merge helper server-
// side). Caller owns its own .catch fallback, so default to silent.
export const getAppLayeredIntelligence = (id, options) =>
  request(`/apps/${id}/layered-intelligence`, { silent: true, ...options });
// Read-only LI proposal-outcome dashboard data (#2689): merge-rate stats, the
// rejection-reason tally, and a capped recent list. The panel owns its own error
// UI, so default to silent.
export const getAppLayeredIntelligenceOutcomes = (id, options) =>
  request(`/apps/${id}/layered-intelligence/outcomes`, { silent: true, ...options });
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
// Vite Dev-UI host check / remediation. Read-only status check is silent (the
// detail view owns its own inline warning UI); the fix call's caller shows
// custom success/error toasts.
export const getAppViteHostStatus = (id, host) =>
  request(`/apps/${id}/vite-host-check?host=${encodeURIComponent(host || '')}`, { silent: true });
export const fixAppViteHosts = (id, body) => request(`/apps/${id}/fix-vite-hosts`, {
  method: 'POST',
  body: JSON.stringify(body),
  silent: true
});
export const archiveApp = (id) => request(`/apps/${id}/archive`, { method: 'POST' });
export const unarchiveApp = (id) => request(`/apps/${id}/unarchive`, { method: 'POST' });
export const openAppInEditor = (id) => request(`/apps/${id}/open-editor`, { method: 'POST' });
export const openAppInClaude = (id) => request(`/apps/${id}/open-claude`, { method: 'POST' });
export const openAppFolder = (id) => request(`/apps/${id}/open-folder`, { method: 'POST' });
export const refreshAppConfig = (id) => request(`/apps/${id}/refresh-config`, { method: 'POST' });
export const pullAndUpdateApp = (id) => request(`/apps/${id}/update`, { method: 'POST' });
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const buildApp = (id, options = {}) => request(`/apps/${id}/build`, { method: 'POST', ...options });
export const getAppStatus = (id) => request(`/apps/${id}/status`);
export const getAppTaskTypes = (id) => request(`/apps/${id}/task-types`);
export const toggleAllAppTaskTypes = (id, enabled, options = {}) => request(`/apps/${id}/task-types/all`, {
  method: 'PUT',
  body: JSON.stringify({ enabled }),
  ...options
});
// `intervalMs` / `providerId` / `model` are the per-app scheduling fields for
// handler-backed task types (layered-intelligence). Sent only when defined so
// existing callers (enabled/interval-only toggles) are unaffected.
export const updateAppTaskTypeOverride = (id, taskType, { enabled, interval, intervalMs, providerId, model, taskMetadata } = {}, options = {}) => request(`/apps/${id}/task-types/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled, interval, intervalMs, providerId, model, taskMetadata }),
  ...options
});
export const bulkUpdateAppTaskTypeOverride = (taskType, { enabled }, options = {}) => request(`/apps/bulk-task-type/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled }),
  ...options
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
export const getAppDocuments = (id, options) => request(`/apps/${id}/documents`, options);
export const getAppDocument = (id, filename) => request(`/apps/${id}/documents/${filename}`);
export const saveAppDocument = (id, filename, content, commitMessage) =>
  request(`/apps/${id}/documents/${filename}`, {
    method: 'PUT',
    body: JSON.stringify({ content, ...(commitMessage && { commitMessage }) })
  });
export const getAppAgents = (id, limit = 50) => request(`/apps/${id}/agents?limit=${limit}`);
