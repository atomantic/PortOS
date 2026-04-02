import { request } from './apiCore.js';

// Running Agents (Process Management)
export const getRunningAgents = () => request('/agents');
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
export const forceSpawnTask = (taskId) => request(`/cos/tasks/${taskId}/spawn`, { method: 'POST' });
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
export const sendCosAgentBtw = (id, message) => request(`/cos/agents/${id}/btw`, {
  method: 'POST',
  body: JSON.stringify({ message })
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
export const getCosLearningConfidence = () => request('/cos/learning/confidence');
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
export const getCosJobAllowedCommands = () => request('/cos/jobs/allowed-commands');
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

// Feature Agents
export const getFeatureAgents = () => request('/feature-agents');
export const getFeatureAgent = (id) => request(`/feature-agents/${id}`);
export const createFeatureAgent = (data) => request('/feature-agents', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateFeatureAgent = (id, data) => request(`/feature-agents/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteFeatureAgent = (id) => request(`/feature-agents/${id}`, { method: 'DELETE' });
export const startFeatureAgent = (id) => request(`/feature-agents/${id}/start`, { method: 'POST' });
export const pauseFeatureAgent = (id) => request(`/feature-agents/${id}/pause`, { method: 'POST' });
export const resumeFeatureAgent = (id) => request(`/feature-agents/${id}/resume`, { method: 'POST' });
export const triggerFeatureAgent = (id) => request(`/feature-agents/${id}/trigger`, { method: 'POST' });
export const stopFeatureAgent = (id) => request(`/feature-agents/${id}/stop`, { method: 'POST' });
export const getFeatureAgentRuns = (id, limit) => request(`/feature-agents/${id}/runs${limit ? `?limit=${limit}` : ''}`);
export const getFeatureAgentOutput = (id) => request(`/feature-agents/${id}/output`);
