import { request } from './apiCore.js';

// GitHub Repos
// `options` lets a caller suppress request()'s auto-toast with `{ silent: true }`
// when it already renders its own error UI.
export const getGitHubRepos = (options = {}) => request('/github/repos', options);
export const getGitHubStatus = (options = {}) => request('/github/status', options);
export const syncGitHubRepos = (options = {}) => request('/github/repos/sync', { method: 'POST', ...options });
export const updateGitHubRepo = (fullName, data, options = {}) =>
  request(`/github/repos/${encodeURIComponent(fullName)}`, { method: 'PUT', body: JSON.stringify(data), ...options });
export const archiveGitHubRepo = (fullName, options = {}) =>
  request(`/github/repos/${encodeURIComponent(fullName)}/archive`, { method: 'POST', ...options });
export const unarchiveGitHubRepo = (fullName, options = {}) =>
  request(`/github/repos/${encodeURIComponent(fullName)}/unarchive`, { method: 'POST', ...options });
export const getGitHubSecrets = (options = {}) => request('/github/secrets', options);
export const setGitHubSecret = (name, value, options = {}) =>
  request(`/github/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }), ...options });
export const syncGitHubSecret = (name, options = {}) =>
  request(`/github/secrets/${encodeURIComponent(name)}/sync`, { method: 'POST', ...options });

// GitHub accounts (github.com + Enterprise hosts) for the notifications manager.
export const getGitHubAccounts = (options = {}) => request('/github/accounts', options);
export const createGitHubAccount = (data, options = {}) =>
  request('/github/accounts', { method: 'POST', body: JSON.stringify(data), ...options });
export const updateGitHubAccount = (id, data, options = {}) =>
  request(`/github/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data), ...options });
export const deleteGitHubAccount = (id, options = {}) =>
  request(`/github/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
export const getGitHubAccountStatus = (id, options = {}) =>
  request(`/github/accounts/${encodeURIComponent(id)}/status`, options);

// Notifications inbox: rows are stored server-side; sync fetches fresh ones.
export const getGitHubNotifications = ({ accountId, view } = {}, options = {}) => {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (view) params.set('view', view);
  const qs = params.toString();
  return request(`/github/notifications${qs ? `?${qs}` : ''}`, options);
};
export const syncGitHubNotifications = (accountId = null, options = {}) =>
  request('/github/notifications/sync', { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}), ...options });
export const clearFinishedGitHubNotifications = (accountId = null, options = {}) =>
  request('/github/notifications/clear-finished', { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}), ...options });
export const applyGitHubNotificationAction = (accountId, threadId, action, options = {}) =>
  request(`/github/notifications/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}`, {
    method: 'POST', body: JSON.stringify({ action }), ...options,
  });
// `run` is this run's `{ provider, model, effort }` (null = Auto); omit it to
// use the agent rule's pin or the account's agent defaults.
export const resolveGitHubNotificationWithAgent = (accountId, threadId, run = null, options = {}) =>
  request(`/github/notifications/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}/agent`, {
    method: 'POST', body: JSON.stringify(run || {}), ...options,
  });
export const getGitHubDeploymentReview = (accountId, threadId, options = {}) =>
  request(`/github/notifications/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}/deployment`, options);
export const actOnGitHubNotificationPullRequest = (accountId, threadId, action, options = {}) =>
  request(`/github/notifications/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}/pull-request`, {
    method: 'POST', body: JSON.stringify(action), ...options,
  });
export const reviewGitHubDeployment = (accountId, threadId, review, options = {}) =>
  request(`/github/notifications/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}/deployment`, {
    method: 'POST', body: JSON.stringify(review), ...options,
  });
export const getGitHubNotification = (accountId, threadId, options = {}) =>
  request(`/github/notifications/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}`, options);

// Automations tab: the notification check's cadence and each account's last run.
export const getGitHubAutomations = (options = {}) => request('/github/automations', options);
export const setGitHubNotificationCadence = (cadence, options = {}) =>
  request('/github/automations/schedule', { method: 'PUT', body: JSON.stringify({ cadence }), ...options });
export const getGitHubAutomationActivity = (options = {}) => request('/github/automations/activity', options);
export const undoGitHubAutomationAction = (id, options = {}) =>
  request(`/github/automations/activity/${encodeURIComponent(id)}/undo`, { method: 'POST', ...options });
export const getGitHubLearnedRules = (options = {}) => request('/github/automations/rules', options);
export const deleteGitHubLearnedRule = (id, options = {}) =>
  request(`/github/automations/rules/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });

// Audit tab: 30-day subscription audit per account and the changes applied from it.
export const getGitHubAudit = (accountId, options = {}) => request(`/github/audit/${encodeURIComponent(accountId)}`, options);
export const runGitHubAudit = (accountId, options = {}) =>
  request(`/github/audit/${encodeURIComponent(accountId)}`, { method: 'POST', ...options });
export const applyGitHubAuditSuggestion = (accountId, suggestionId, options = {}) =>
  request(`/github/audit/${encodeURIComponent(accountId)}/apply`, { method: 'POST', body: JSON.stringify({ suggestionId }), ...options });
export const getGitHubAuditChanges = (options = {}) => request('/github/audit-changes', options);
export const undoGitHubAuditChange = (id, options = {}) =>
  request(`/github/audit-changes/${encodeURIComponent(id)}/undo`, { method: 'POST', ...options });
