import { request, API_BASE, throwApiError } from './apiCore.js';
import { downloadBlob } from '../lib/downloadBlob.js';

// Alerts
export const getAlertsSummary = (options) => request('/alerts/summary', options);

// Character sheet (age-based level / XP / HP / usage-derived skills + metrics grid).
// `skills: false` / `metrics: false` skip the server's domain stat fan-out for each derived
// registry — pass them from callers that only read the persisted fields or the level (e.g.
// the polling OpenWorld XP HUD badge). Both default on, so a caller that wants the whole
// sheet just calls getCharacter().
export const getCharacter = ({ skills = true, metrics = true, ...options } = {}) => {
  const params = new URLSearchParams();
  if (!skills) params.set('skills', '0');
  if (!metrics) params.set('metrics', '0');
  // `metrics=1` must go on the wire EXPLICITLY when skills are off, because the server infers
  // an absent `metrics` from `skills` (back-compat: a bare `?skills=0` predates the metrics
  // grid and means "cheap sheet"). Without this, `{ skills: false }` would silently drop the
  // metrics this wrapper's own default promises.
  else if (!skills) params.set('metrics', '1');
  const query = params.toString();
  return request(`/character${query ? `?${query}` : ''}`, options);
};

// Health
export const checkHealth = (options) => request('/system/health', options);
export const getSystemHealth = (options) => request('/system/health/details', options);
// Its own route, not a field on health/details — peers scrape that payload and
// persist it verbatim, and the build stamp must stay machine-local (#4694).
export const getSystemBuild = (options) => request('/system/build', options);
export const runSystemResourceReport = (options = {}) => request('/system-resources/report', {
  method: 'POST',
  ...options,
});
export const triageSystemResources = (payload, options = {}) => request('/system-resources/triage', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options,
});
export const getActiveProcessing = (options) => request('/system/processing', options);
export const getNetworkExposure = (options) => request('/network-exposure/status', options);
export const getCapabilities = (options) => request('/capabilities', options);
// Machine-local hardware facts used for UI fit and recommendation surfaces.
// This endpoint deliberately stays outside peer-synced health payloads.
export const getSystemCapabilities = (options) => request('/system/capabilities', options);
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
export const getInstanceFeatures = (options) => request('/settings/features', options);
export const getCredentialInventory = (options) => request('/settings/credentials', options);
export const updateInstanceFeature = (featureId, enabled, options = {}) => request(`/settings/features/${encodeURIComponent(featureId)}`, {
  method: 'PUT',
  body: JSON.stringify({ enabled }),
  ...options,
});
export const installEidoverseFeature = (worldsRepoUrl, options = {}) => request('/settings/features/eidoverse/install', {
  method: 'POST',
  body: JSON.stringify({ worldsRepoUrl }),
  ...options,
});
export const updateEidoverseWorldsSource = (worldsRepoUrl, options = {}) => request('/settings/features/eidoverse/source', {
  method: 'PUT',
  body: JSON.stringify({ worldsRepoUrl }),
  ...options,
});
export const startEidoverseHost = (options = {}) => request('/settings/features/eidoverse/host', {
  method: 'POST',
  ...options,
});
export const getEidoverseWorldStatus = (options) => request('/eidoverse/world/status', options);
export const getEidoverseWorldProjectionStatus = (options) => request('/eidoverse/world/projection/status', options);
export const updateEidoverseWorldConfig = (payload, options = {}) => request('/eidoverse/world/config', {
  method: 'PUT',
  body: JSON.stringify(payload),
  ...options,
});
export const projectEidoverseWorld = (options = {}) => request('/eidoverse/world/project', {
  method: 'POST',
  ...options,
});
export const updateSettings = (data, options) => request('/settings', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const getAiAssignments = (options) => request('/settings/ai-assignments', options);
// Local image/video models this instance could offer as a federated media
// provider — what the Sharing tab lets you pick from. Local-only inventory;
// the peer-facing status endpoint only ever reports already-shared models.
export const getMediaShareCandidates = (options) => request('/settings/media-share-candidates', options);

// API Access — the OpenAPI 3.0.3 spec for the public API surface (built from the
// exposed entries in apiAccess settings). Rendered by the API Access settings tab.
export const getOpenApiSpec = (options) => request('/api-docs/openapi.json', options);
export const getApiCatalog = (options) => request('/api-docs/catalog.json', options);
export const getSocketEventCatalog = (options) => request('/api-docs/events.json', options);
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

// Usage. `params` selects the cost-report window: { period } (7d|30d|90d|all)
// or { from, to } (YYYY-MM-DD).
export const getUsage = (params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== '')
  ).toString();
  return request(`/usage${qs ? `?${qs}` : ''}`);
};
export const getUsageBackfillStatus = (options = {}) => request('/usage/backfill', options);
// Monthly plan prices per provider family, used to compare subscription spend
// against the report's estimated API cost. `costs` is a partial patch: an
// omitted family keeps its stored price, `null` clears it. Reads come back with
// the report (`getUsage().subscriptionSavings`), so there is no getter here.
export const updateSubscriptionCosts = (costs, options = {}) =>
  request('/usage/subscriptions', { method: 'PUT', body: JSON.stringify({ costs }), ...options });
// Mark one federated instance as paying API rates (`usesSubscriptions: false`)
// or riding this install's subscriptions (`true`). The Across Instances
// combined total skips API-billed rows; the row itself stays listed.
export const updateUsageFleetBilling = ({ instanceId, usesSubscriptions }, options = {}) =>
  request('/usage/fleet-billing', {
    method: 'PUT',
    body: JSON.stringify({ instanceId, usesSubscriptions }),
    ...options,
  });
export const startUsageBackfill = (options = {}) => request('/usage/backfill', { method: 'POST', ...options });

// Subscription-quota status for every enabled provider family (claude, codex,
// agy, grok). Callers own their inline error UI — silent by default. `family`
// narrows the read to a single card (the usage page's per-card Refresh) so one
// provider's multi-second scrape isn't paid for all of them.
export const getProviderUsage = ({ refresh = false, family = null, ...options } = {}) => {
  const qs = new URLSearchParams();
  if (refresh) qs.set('refresh', '1');
  if (family) qs.set('family', family);
  const query = qs.toString();
  return request(`/usage/providers${query ? `?${query}` : ''}`, { silent: true, ...options });
};

// Backup
export const getBackupStatus = (options) => request('/backup/status', options);
export const triggerBackup = (options) => request('/backup/run', { method: 'POST', ...options });
export const getBackupSnapshots = (options) => request('/backup/snapshots', options);
export const restoreBackup = (data, options = {}) => request('/backup/restore', { method: 'POST', body: JSON.stringify(data), ...options });
export async function downloadBackupSnapshot(snapshotId) {
  // The server names the file the same way; deriving it here too lets the save
  // picker open BEFORE the fetch, while the click's transient user activation is
  // still valid. Waiting for response headers first — as this used to — routinely
  // outlives that window on a cold external drive, Chromium then refuses the
  // picker, and the download falls back to buffering a multi-gigabyte archive in
  // tab memory: exactly the case the streaming path exists to avoid.
  const filename = `portos-snapshot-${snapshotId}.tar.gz`;

  let writable = null;
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    // A dismissed picker is the user declining; it propagates as AbortError and
    // callers treat it as a cancel, not a failure. Any other picker error (an
    // unsupported context, say) falls through to the Blob path below.
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename });
      writable = await handle.createWritable();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    }
  }

  let writableAborted = false;
  const abortWritable = async () => {
    if (!writable || writableAborted) return;
    writableAborted = true;
    await writable.abort?.().catch(() => {});
  };

  try {
    const response = await fetch(`${API_BASE}/backup/snapshots/${encodeURIComponent(snapshotId)}/download`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      // The catch below closes the handle before propagating the API error, so
      // the picker doesn't leave a 0-byte file behind.
      await throwApiError(response);
    }

    if (writable && response.body?.pipeTo) {
      await response.body.pipeTo(writable);
    } else {
      // No File System Access API (Firefox, Safari): the Blob path is the only
      // one available, and it is why the server caps nothing — the browser
      // holds it all. Abort the unused picker stream before falling back.
      await abortWritable();
      downloadBlob(await response.blob(), filename);
    }
  } catch (error) {
    // Fetch, response parsing, and pipeTo can all fail after the picker has
    // created its stream. Abort it on every failure path so the destination is
    // immediately available for a retry.
    await abortWritable();
    throw error;
  }
  return { filename };
}
export const restoreDatabase = (data, options) => request('/backup/restore-db', { method: 'POST', body: JSON.stringify(data), ...options });

// Data Manager
export const getDataOverview = () => request('/data');
export const getDataCategory = (key) => request(`/data/${key}`);
export const archiveDataCategory = (key, opts) => request(`/data/${key}/archive`, { method: 'POST', body: JSON.stringify(opts || {}) });
export const purgeDataCategory = (key, opts, options = {}) => request(`/data/${key}`, {
  method: 'DELETE',
  body: JSON.stringify(opts || {}),
  ...options,
});
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
export const markNotificationRead = (id) => request(`/notifications/${id}/read`, { method: 'POST' });
export const markAllNotificationsRead = () => request('/notifications/read-all', { method: 'POST' });
export const deleteNotification = (id) => request(`/notifications/${id}`, { method: 'DELETE' });
export const clearNotifications = () => request('/notifications', { method: 'DELETE' });

// Telegram
export const getTelegramStatus = () => request('/telegram/status');
export const updateTelegramConfig = (data, options) => request('/telegram/config', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteTelegramConfig = (options) => request('/telegram/config', { method: 'DELETE', ...options });
export const testTelegram = (message, options) => request('/telegram/test', {
  method: 'POST',
  body: JSON.stringify({ message }),
  ...options
});
export const updateTelegramForwardTypes = (forwardTypes, options) => request('/telegram/forward-types', {
  method: 'PUT',
  body: JSON.stringify({ forwardTypes }),
  ...options
});
export const updateTelegramMethod = (method, options) => request('/telegram/method', {
  method: 'PUT',
  body: JSON.stringify({ method }),
  ...options
});

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
export const getBrowserLogs = (lines = 50) => request(`/browser/logs?lines=${lines}`);
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
// Federated instances a CoS task may be pinned to (#4520): id/name/isSelf only.
export const getAssignableInstances = (options) => request('/instances/assignable', options);
export const updateSelfInstance = (data) => request('/instances/self', { method: 'PUT', body: JSON.stringify(data) });
export const addPeer = (data) => request('/instances/peers', { method: 'POST', body: JSON.stringify(data) });
export const updatePeer = (id, data) => request(`/instances/peers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const removePeer = (id) => request(`/instances/peers/${id}`, { method: 'DELETE' });
export const connectPeer = (id) => request(`/instances/peers/${id}/connect`, { method: 'POST' });
export const reciprocatePeer = (id, options) => request(`/instances/peers/${id}/reciprocate`, { method: 'POST', ...options });
export const probePeer = (id) => request(`/instances/peers/${id}/probe`, { method: 'POST' });
export const syncPeer = (id, options) => request(`/instances/peers/${id}/sync`, { method: 'POST', ...options });
export const getPeerFullSyncCoverage = (id, options) => request(`/instances/peers/${id}/full-sync-coverage`, options);
export const getTailnetInfo = () => request('/instances/tailnet-suffix');
export const provisionTailnetCert = () => request('/instances/provision-cert', { method: 'POST' });

// Image Generation
export const getImageGenStatus = (mode, modelId) => {
  const params = new URLSearchParams();
  if (mode) params.set('mode', mode);
  if (modelId) params.set('modelId', modelId);
  const query = params.toString();
  return request(`/image-gen/status${query ? `?${query}` : ''}`);
};
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
export const getToolsList = (options) => request('/tools', options);
export const registerTool = (data, options) => request('/tools', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateTool = (id, data, options) => request(`/tools/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});

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

// Insights
export const getInsightThemes = () => request('/insights/themes');
export const refreshInsightThemes = (providerId, model, options = {}) => request('/insights/themes/refresh', {
  method: 'POST',
  body: JSON.stringify({ providerId, model }),
  ...options
});
export const getInsightNarrative = () => request('/insights/narrative');
export const refreshInsightNarrative = (providerId, model, options = {}) => request('/insights/narrative/refresh', {
  method: 'POST',
  body: JSON.stringify({ providerId, model }),
  ...options
});

// Goal effectiveness scorecard (#2157)
export const getGoalScorecard = () => request('/insights/goal-scorecard');
export const computeGoalScorecard = (weekStart) => request('/insights/goal-scorecard/compute', {
  method: 'POST',
  body: JSON.stringify(weekStart ? { weekStart } : {})
});
export const refreshGoalScorecardNarrative = (providerId, model) => request('/insights/goal-scorecard/narrative', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const getGoalScorecardRules = () => request('/insights/goal-scorecard/rules');
export const saveGoalScorecardRules = (overrides) => request('/insights/goal-scorecard/rules', {
  method: 'PUT',
  body: JSON.stringify(overrides ?? {})
});
export const getGoalScorecardSettings = () => request('/insights/goal-scorecard/settings');
export const updateGoalScorecardSettings = (partial) => request('/insights/goal-scorecard/settings', {
  method: 'PUT',
  body: JSON.stringify(partial ?? {})
});
