import { request } from './apiCore.js';

// Running Agents (Process Management)
export const getRunningAgents = (options) => request('/agents', options);
export const getRunningAgentInfo = (pid) => request(`/agents/${pid}`);
export const killRunningAgent = (pid) => request(`/agents/${pid}`, { method: 'DELETE' });
// Legacy aliases
export const getAgents = getRunningAgents;
export const getAgentInfo = getRunningAgentInfo;
export const killAgent = killRunningAgent;

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

// CoS run event ledger (#4540) — diagnostics over the append-only lifecycle
// stream. All reads except `repairRunRecords`, which is the one write: it closes
// the run records the ledger proves are finished, and it is a POST because
// rewriting a run record is a mutation a user has to ask for.
const runEventQuery = (filters = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
};
export const getRunEvents = (filters = {}, options = {}) =>
  request(`/agents/activity/run-events${runEventQuery(filters)}`, options);
export const getRunEventStats = (options = {}) =>
  request('/agents/activity/run-events/stats', options);
export const getRunEventProjections = (filters = {}, options = {}) =>
  request(`/agents/activity/run-events/projections${runEventQuery(filters)}`, options);
export const getRunEventDiagnostic = (id, options = {}) =>
  request(`/agents/activity/run-events/run/${encodeURIComponent(id)}`, options);
export const getRunReconciliation = (filters = {}, options = {}) =>
  request(`/agents/activity/run-events/reconcile${runEventQuery(filters)}`, options);
export const repairRunRecords = (body = {}, options = {}) =>
  request('/agents/activity/run-events/reconcile', { method: 'POST', body: JSON.stringify(body), ...options });

// Persistent CoS mind — the cursor read is both the initial bounded snapshot
// and the reconnect backfill path. Writes carry caller-minted ids so retrying a
// timed-out request cannot duplicate a message or annotation.
export const getPersistentMind = (filters = {}, options = {}) =>
  request(`/cos/mind${runEventQuery(filters)}`, options);
export const getPersistentMindContext = (options = {}) => request('/cos/mind/context', options);
export const getPersistentMindTools = (options = {}) => request('/cos/mind/tools', options);
export const getCosToolCatalog = ({ scope = 'all', format = 'portos', intent, ...options } = {}) => {
  const params = new URLSearchParams({ scope, format });
  if (intent) params.set('intent', intent);
  return request(`/cos/tools?${params}`, options);
};
export const callCosTool = (call, options = {}) => request('/cos/tools/call', {
  method: 'POST',
  body: JSON.stringify(call),
  ...options,
  headers: { 'Idempotency-Key': call.requestId, ...(options.headers || {}) },
});
export const getCosToolCall = (requestId, options = {}) =>
  request(`/cos/tools/calls/${encodeURIComponent(requestId)}`, options);
export const getPersistentMindRuntime = (options = {}) => request('/cos/mind/runtime', options);
export const getPersistentMindVisibility = (options = {}) => {
  const { refresh, ...requestOptions } = options;
  return request(`/cos/mind/visibility${refresh ? '?refresh=true' : ''}`, requestOptions);
};
export const sendPersistentMindMessage = (body, options = {}) =>
  request('/cos/mind/messages', { method: 'POST', body: JSON.stringify(body), ...options });
export const uploadPersistentMindAttachment = (body, options = {}) =>
  request('/cos/mind/attachments', { method: 'POST', body: JSON.stringify(body), ...options });
export const deletePersistentMindAttachment = (attachmentId, options = {}) =>
  request(`/cos/mind/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE', ...options });
export const addPersistentMindAnnotation = (body, options = {}) =>
  request('/cos/mind/annotations', { method: 'POST', body: JSON.stringify(body), ...options });
export const startPersistentMind = (options = {}) => request('/cos/mind/start', { method: 'POST', ...options });
export const pausePersistentMind = (reason, options = {}) => request('/cos/mind/pause', {
  method: 'POST', body: JSON.stringify({ reason }), ...options,
});
export const resumePersistentMind = (options = {}) => request('/cos/mind/resume', { method: 'POST', ...options });
export const stopPersistentMind = (options = {}) => request('/cos/mind/stop', { method: 'POST', ...options });
export const acknowledgePersistentMindEvent = (eventId, id, options = {}) =>
  request(`/cos/mind/events/${encodeURIComponent(eventId)}/acknowledge`, {
    method: 'POST', body: JSON.stringify({ id }), ...options,
  });
export const promotePersistentMindEvent = (eventId, body, options = {}) =>
  request(`/cos/mind/events/${encodeURIComponent(eventId)}/promote`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });
export const createPersistentMindMemory = (body, options = {}) => request('/cos/mind/memories', {
  method: 'POST', body: JSON.stringify(body), ...options,
});
export const updatePersistentMindMemory = (memoryId, body, options = {}) => request(`/cos/mind/memories/${encodeURIComponent(memoryId)}`, {
  method: 'PUT', body: JSON.stringify(body), ...options,
});
export const cleanupPersistentMind = (body, options = {}) => request('/cos/mind/cleanup', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Chief of Staff
export const getCosStatus = () => request('/cos');
export const startCos = (options = {}) => request('/cos/start', { method: 'POST', ...options });
export const stopCos = (options = {}) => request('/cos/stop', { method: 'POST', ...options });
export const pauseCos = (reason, options = {}) => request('/cos/pause', {
  method: 'POST',
  body: JSON.stringify({ reason }),
  ...options,
});
export const resumeCos = (options = {}) => request('/cos/resume', { method: 'POST', ...options });
export const getCosConfig = (options) => request('/cos/config', options);
export const updateCosConfig = (config, options = {}) => request('/cos/config', {
  method: 'PUT',
  body: JSON.stringify(config),
  ...options
});
// Today's per-domain autonomy usage (#711) for the Domain Budgets panel.
export const getCosBudgetUsage = (options = {}) => request('/cos/budget-usage', options);
export const getCosTasks = (options) => request('/cos/tasks', options);
export const addCosTask = (task, options = {}) => request('/cos/tasks', {
  method: 'POST',
  body: JSON.stringify(task),
  ...options
});
// Queue a `/do:*` agent task for an app. `settings` carries the run options the
// Agent Operations drawer collects — provider/model/effort/simplify for every
// command, plus the `/do:next`-only target work item, issue author filter,
// reviewer list, and optional override context. Omit it for a bare "run with
// the app's configured defaults".
export const createSlashdoTask = (command, app, settings = {}, options = {}) => request('/cos/tasks/slashdo', {
  method: 'POST',
  body: JSON.stringify({ command, app, ...settings }),
  ...options
});
// Queue a CoS task to implement one specific JIRA ticket (sprint-board play button).
export const createJiraTicketTask = (app, ticketKey, options = {}) => request('/cos/tasks/jira-ticket', {
  method: 'POST',
  body: JSON.stringify({ app, ticketKey }),
  ...options
});
export const enhanceCosTaskPrompt = (data) => request('/cos/tasks/enhance', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateCosTask = (id, updates, options = {}) => request(`/cos/tasks/${id}`, {
  method: 'PUT',
  body: JSON.stringify(updates),
  ...options
});
export const deleteCosTask = (id, taskType = 'user', options = {}) => request(`/cos/tasks/${id}?type=${taskType}`, { method: 'DELETE', ...options });
export const reorderCosTasks = (taskIds, options = {}) => request('/cos/tasks/reorder', {
  method: 'POST',
  body: JSON.stringify({ taskIds }),
  ...options
});
export const approveCosTask = (id, options = {}) => request(`/cos/tasks/${id}/approve`, { method: 'POST', ...options });
// Resolve a parked challenge (#2441, #2471). `body` carries the manual verdict
// (`{ outcome: 'upheld' | 'escalated', note?, resolvedBy? }`) — `upheld` overturns
// the rejection (task → pending), `escalated` surfaces it for arbitration (→ blocked).
export const resolveCosTaskChallenge = (id, body, options = {}) => request(`/cos/tasks/${id}/challenge/resolve`, {
  method: 'POST',
  body: JSON.stringify(body),
  ...options
});
export const forceCosEvaluate = (options = {}) => request('/cos/evaluate', { method: 'POST', ...options });
export const forceSpawnTask = (taskId, options = {}) => request(`/cos/tasks/${taskId}/spawn`, { method: 'POST', ...options });
export const getCosHealth = () => request('/cos/health');
export const forceHealthCheck = (options = {}) => request('/cos/health/check', { method: 'POST', ...options });
export const getCosAgents = (options) => request('/cos/agents', options);
export const getCosAgentDates = () => request('/cos/agents/history');
export const getCosAgentsByDate = (date) => request(`/cos/agents/history/${date}`);
export const getCosAgent = (id) => request(`/cos/agents/${id}`);
export const terminateCosAgent = (id) => request(`/cos/agents/${id}/terminate`, { method: 'POST' });
export const pauseCosAgent = (id, reason, options = {}) => request(`/cos/agents/${id}/pause`, {
  method: 'POST',
  body: JSON.stringify({ reason }),
  ...options
});
// Resume a PAUSED agent: the server requeues that agent's own task on the branch
// and worktree its run left behind. `overrides` are the resume dialog's edits
// (extra context, provider/model/effort/app) — omit a field to keep the paused
// run's value.
export const resumeCosAgent = (id, overrides = {}, options = {}) => request(`/cos/agents/${id}/resume`, {
  method: 'POST',
  body: JSON.stringify(overrides),
  ...options
});
export const killCosAgent = (id, options = {}) => request(`/cos/agents/${id}/kill`, { method: 'POST', ...options });
export const getCosAgentStats = (id, options) => request(`/cos/agents/${id}/stats`, options);
export const getCosAgentPrompt = (id) => request(`/cos/agents/${id}/prompt`);
export const deleteCosAgent = (id, options = {}) => request(`/cos/agents/${id}`, { method: 'DELETE', ...options });
export const clearCompletedCosAgents = (options = {}) => request('/cos/agents/completed', { method: 'DELETE', ...options });
export const submitCosAgentFeedback = (id, feedback, options = {}) => request(`/cos/agents/${id}/feedback`, {
  method: 'POST',
  body: JSON.stringify(feedback),
  ...options
});
export const sendCosAgentBtw = (id, message, options = {}) => request(`/cos/agents/${id}/btw`, {
  method: 'POST',
  body: JSON.stringify({ message }),
  ...options
});
export const getCosFeedbackStats = (options = {}) => request('/cos/feedback/stats', options);
export const getCosReports = () => request('/cos/reports');
export const getCosTodayReport = () => request('/cos/reports/today');
export const getCosReport = (date) => request(`/cos/reports/${date}`);

// CoS Briefings
export const getCosBriefings = () => request('/cos/briefings');
export const getCosLatestBriefing = () => request('/cos/briefings/latest');
export const getCosBriefing = (date) => request(`/cos/briefings/${date}`);

// CoS Activity
export const getCosTodayActivity = () => request('/cos/activity/today');
// "While you were away" — agent runs since the client's last-visit marker.
// `since` is an ISO-8601 string; omit it to let the server fall back to 24h.
export const getCosWhileAwayActivity = (since, options) =>
  request(`/cos/activity/while-away${since ? `?since=${encodeURIComponent(since)}` : ''}`, options);

// CoS Learning
export const getCosLearning = () => request('/cos/learning');
export const getCosLearningDurations = () => request('/cos/learning/durations');
export const getCosLearningSkipped = () => request('/cos/learning/skipped');
export const getCosLearningPerformance = () => request('/cos/learning/performance');
export const getCosLearningRouting = () => request('/cos/learning/routing');
export const getCosLearningSummary = (options) => request('/cos/learning/summary', options);
export const getCosLearningConfidence = () => request('/cos/learning/confidence');
export const backfillCosLearning = () => request('/cos/learning/backfill', { method: 'POST' });
export const resetCosTaskTypeLearning = (taskType) => request(`/cos/learning/reset/${encodeURIComponent(taskType)}`, { method: 'POST' });
export const getDismissedCosRecommendations = () => request('/cos/learning/recommendations/dismissed');
export const dismissCosRecommendation = (id, snapshot) => request('/cos/learning/recommendations/dismiss', {
  method: 'POST',
  body: JSON.stringify({ id, snapshot })
});
export const restoreCosRecommendation = (id) => request('/cos/learning/recommendations/restore', {
  method: 'POST',
  body: JSON.stringify({ id })
});
export const clearDismissedCosRecommendations = () => request('/cos/learning/recommendations/clear-dismissed', { method: 'POST' });

// CoS Quick Task Templates
export const getCosTaskTemplates = () => request('/cos/templates');
export const getCosPopularTemplates = (limit = 5) => request(`/cos/templates/popular?limit=${limit}`);
export const getCosTemplateCategories = () => request('/cos/templates/categories');
export const createCosTaskTemplate = (data, options = {}) => request('/cos/templates', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const createCosTemplateFromTask = (task, templateName) => request('/cos/templates/from-task', {
  method: 'POST',
  body: JSON.stringify({ task, templateName })
});
export const applyCosTaskTemplate = (id) => request(`/cos/templates/${id}/use`, { method: 'POST' });
export const updateCosTaskTemplate = (id, data) => request(`/cos/templates/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteCosTaskTemplate = (id, options = {}) => request(`/cos/templates/${id}`, { method: 'DELETE', ...options });

// Weekly Digest
export const getCosWeeklyDigest = (weekId = null) => {
  if (weekId) return request(`/cos/digest/${weekId}`);
  return request('/cos/digest');
};
export const listCosWeeklyDigests = () => request('/cos/digest/list');
export const getCosWeekProgress = () => request('/cos/digest/progress');
export const getCosDigestText = async () => {
  const response = await fetch('/api/cos/digest/text');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};
export const generateCosDigest = (weekId = null) => request('/cos/digest/generate', {
  method: 'POST',
  body: JSON.stringify({ weekId })
});
export const compareCosWeeks = (week1, week2) => request(`/cos/digest/compare?week1=${week1}&week2=${week2}`);

// Productivity
export const getCosProductivity = () => request('/cos/productivity');
export const getCosProductivitySummary = () => request('/cos/productivity/summary');
export const recalculateCosProductivity = () => request('/cos/productivity/recalculate', { method: 'POST' });
export const getCosProductivityTrends = (days = 30) => request(`/cos/productivity/trends?days=${days}`);
export const getCosActivityCalendar = (weeks = 12, options) => request(`/cos/productivity/calendar?weeks=${weeks}`, options);
export const getCosQuickSummary = (options) => request('/cos/quick-summary', options);
export const getCosRecentTasks = (limit = 10, options) => request(`/cos/recent-tasks?limit=${limit}`, options);
export const getCosActionableInsights = (options) => request('/cos/actionable-insights', options);
export const getCosGoalProgress = () => request('/cos/goal-progress');
export const getCosGoalProgressSummary = (options) => request('/cos/goal-progress/summary', options);

// Auto-Fix Telemetry (issue #2328) — aggregated from persisted metadata.diagnostics
export const getAutoFixMetrics = (options) => request('/autofix/metrics', options);

// Decision Log
export const getCosDecisions = (limit = 20, type = null) => {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (type) params.append('type', type);
  return request(`/cos/decisions?${params}`);
};
export const getCosDecisionSummary = (options) => request('/cos/decisions/summary', options);
export const getCosDecisionPatterns = () => request('/cos/decisions/patterns');

// Task Schedule (Configurable Intervals)
export const getCosUpcomingTasks = (limit = 10, options) => request(`/cos/upcoming?limit=${limit}`, options);
export const getCosSchedule = () => request('/cos/schedule');
export const getCosScheduleIntervalTypes = () => request('/cos/schedule/interval-types');
export const getCosScheduleDueTasks = () => request('/cos/schedule/due');
export const getCosScheduleDueAppTasks = (appId) => request(`/cos/schedule/due/${appId}`);
// Unified task interval update
export const updateCosTaskInterval = (taskType, settings, options = {}) => request(`/cos/schedule/task/${taskType}`, {
  method: 'PUT',
  body: JSON.stringify(settings),
  ...options
});
// Deprecated aliases — delegate to unified endpoint
export const updateCosSelfImprovementInterval = (taskType, settings) => updateCosTaskInterval(taskType, settings);
export const updateCosAppImprovementInterval = (taskType, settings) => updateCosTaskInterval(taskType, settings);

export const triggerCosOnDemandTask = (taskType, appId = null, options = {}) => request('/cos/schedule/trigger', {
  method: 'POST',
  body: JSON.stringify({ taskType, appId }),
  ...options
});
export const getCosOnDemandRequests = () => request('/cos/schedule/on-demand');
export const resetCosTaskHistory = (taskType, appId = null, options = {}) => request('/cos/schedule/reset', {
  method: 'POST',
  body: JSON.stringify({ taskType, appId }),
  ...options
});
export const getCosScheduleTemplates = () => request('/cos/schedule/templates');
export const addCosScheduleTemplate = (template) => request('/cos/schedule/templates', {
  method: 'POST',
  body: JSON.stringify(template)
});
export const deleteCosScheduleTemplate = (templateId) => request(`/cos/schedule/templates/${templateId}`, { method: 'DELETE' });

// Autonomous Jobs
export const getCosJobs = (options = {}) => request('/cos/jobs', options);
export const getCosJobsDue = () => request('/cos/jobs/due');
export const getCosJobIntervals = () => request('/cos/jobs/intervals');
export const getCosJobAllowedCommands = () => request('/cos/jobs/allowed-commands');
export const getCosJob = (id, options = {}) => request(`/cos/jobs/${id}`, options);
export const createCosJob = (data, options = {}) => request('/cos/jobs', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateCosJob = (id, data, options = {}) => request(`/cos/jobs/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const toggleCosJob = (id, options = {}) => request(`/cos/jobs/${id}/toggle`, { method: 'POST', ...options });
export const triggerCosJob = (id, options = {}) => request(`/cos/jobs/${id}/trigger`, { method: 'POST', ...options });
export const deleteCosJob = (id, options = {}) => request(`/cos/jobs/${id}`, { method: 'DELETE', ...options });

// Workflow visualizer — canonical scheduled-task ordering across tasks + jobs
export const getCosWorkflow = (hours = 24) => request(`/cos/workflow?hours=${hours}`);

// Feature Agents
export const getFeatureAgents = () => request('/feature-agents');
export const getFeatureAgent = (id) => request(`/feature-agents/${id}`);
export const createFeatureAgent = (data, options = {}) => request('/feature-agents', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateFeatureAgent = (id, data, options = {}) => request(`/feature-agents/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteFeatureAgent = (id, options = {}) => request(`/feature-agents/${id}`, { method: 'DELETE', ...options });
export const startFeatureAgent = (id, options = {}) => request(`/feature-agents/${id}/start`, { method: 'POST', ...options });
export const pauseFeatureAgent = (id, options = {}) => request(`/feature-agents/${id}/pause`, { method: 'POST', ...options });
export const resumeFeatureAgent = (id, options = {}) => request(`/feature-agents/${id}/resume`, { method: 'POST', ...options });
export const triggerFeatureAgent = (id, options = {}) => request(`/feature-agents/${id}/trigger`, { method: 'POST', ...options });
export const stopFeatureAgent = (id, options = {}) => request(`/feature-agents/${id}/stop`, { method: 'POST', ...options });
export const getFeatureAgentRuns = (id, limit) => request(`/feature-agents/${id}/runs${limit ? `?limit=${limit}` : ''}`);
export const getFeatureAgentOutput = (id) => request(`/feature-agents/${id}/output`);
