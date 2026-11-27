/**
 * API reads and actions used by the always-mounted application shell.
 */

import { request, singleFlightRead } from './apiCore.js';

export const getShellBootstrap = (options) => request('/shell/bootstrap', options);

// Its own route, not a field on health/details — peers scrape that payload and
// persist it verbatim, and the build stamp must stay machine-local (#4694).
export const getSystemBuild = (options) => request('/system/build', options);

// Bounded activity snapshot (no GPU shell-out). Shared by the update banner
// and the live-activity widget; refreshed from `system:activity`, not a poll.
export const getSystemActivity = (options) => request('/system/activity', options);

export const getCapabilities = (options) => singleFlightRead('/capabilities', () => request('/capabilities', options), options);

// Update
export const getUpdateStatus = (options) => request('/update/status', options);

export const ignoreUpdateVersion = (version) => request('/update/ignore', {
  method: 'POST',
  body: JSON.stringify({ version })
});

// Settings
export const getSettings = (options) => singleFlightRead('/settings', () => request('/settings', options), options);

export const getInstanceFeatures = (options) => request('/settings/features', options);

// `enabled` accepts `null` — the tri-state override going back to "inherit" for
// a grouped feature (see instanceFeatureUpdateSchema on the server).
export const updateInstanceFeature = (featureId, enabled, options = {}) => request(`/settings/features/${encodeURIComponent(featureId)}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled }),
  ...options,
});

export const updateSettings = (data, options) => request('/settings', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});

// Notifications
export const getNotifications = (options = {}) => {
  const params = new URLSearchParams();
  if (options.type) params.set('type', options.type);
  if (options.unreadOnly) params.set('unreadOnly', 'true');
  if (options.limit) params.set('limit', options.limit);
  if (options.includeCount) params.set('includeCount', 'true');
  const read = () => request(`/notifications?${params}`);
  return options.coalesce ? singleFlightRead(`/notifications?${params}`, read) : read();
};

export const getNotificationCount = () => request('/notifications/count');

export const getNotificationSnapshot = async ({ limit, coalesce = false }) => {
  const result = await getNotifications({ limit, includeCount: true, coalesce });
  // Older servers ignore includeCount and return the original list.
  if (Array.isArray(result)) return { notifications: result, ...await getNotificationCount() };
  if (!Array.isArray(result?.notifications) || !Number.isInteger(result.count)) {
    throw new Error('Invalid notification snapshot');
  }
  return result;
};

export const markNotificationRead = (id) => request(`/notifications/${id}/read`, { method: 'POST' });

export const markAllNotificationsRead = () => request('/notifications/read-all', { method: 'POST' });

export const deleteNotification = (id) => request(`/notifications/${id}`, { method: 'DELETE' });

export const clearNotifications = () => request('/notifications', { method: 'DELETE' });

export const getSelfInstance = (options) => request('/instances/self', options);

export const getMaintenanceStatus = (options) => request('/system/maintenance', options);

// `lines` caps the transcript TAIL the server hydrates (server default: 1000
// lines / 512 KB). Pass it when the record is wanted for its metadata rather
// than its log.
export const getCosAgent = (id, { lines, ...options } = {}) =>
  request(`/cos/agents/${id}${lines ? `?lines=${lines}` : ''}`, options);

export const submitCosAgentFeedback = (id, feedback, options = {}) => request(`/cos/agents/${id}/feedback`, {
  method: 'POST',
  body: JSON.stringify(feedback),
  ...options
});
