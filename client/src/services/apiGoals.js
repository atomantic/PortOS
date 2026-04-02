import { request } from './apiCore.js';

// Digital Twin - Identity & Goals
export const getIdentityStatus = () => request('/digital-twin/identity');
export const getCrossInsights = () => request('/digital-twin/identity/cross-insights');
export const getChronotype = () => request('/digital-twin/identity/chronotype');
export const getChronotypeEnergySchedule = () => request('/digital-twin/identity/chronotype/energy-schedule');
export const deriveChronotype = () => request('/digital-twin/identity/chronotype/derive', { method: 'POST' });
export const updateChronotypeBehavioral = (data) => request('/digital-twin/identity/chronotype', {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const getLongevity = () => request('/digital-twin/identity/longevity');
export const deriveLongevity = () => request('/digital-twin/identity/longevity/derive', { method: 'POST' });
export const getGoals = (options) => request('/digital-twin/identity/goals', options);
export const setBirthDate = (birthDate) => request('/digital-twin/identity/goals/birth-date', {
  method: 'PUT',
  body: JSON.stringify({ birthDate })
});
export const createGoal = (data) => request('/digital-twin/identity/goals', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateGoal = (id, data) => request(`/digital-twin/identity/goals/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteGoal = (id) => request(`/digital-twin/identity/goals/${id}`, { method: 'DELETE' });
export const getGoalsTree = () => request('/digital-twin/identity/goals/tree');
export const addGoalMilestone = (goalId, data) => request(`/digital-twin/identity/goals/${goalId}/milestones`, {
  method: 'POST',
  body: JSON.stringify(data)
});
export const completeGoalMilestone = (goalId, milestoneId) =>
  request(`/digital-twin/identity/goals/${goalId}/milestones/${milestoneId}/complete`, { method: 'PUT' });
export const linkGoalActivity = (goalId, data) => request(`/digital-twin/identity/goals/${goalId}/activities`, {
  method: 'POST',
  body: JSON.stringify(data)
});
export const unlinkGoalActivity = (goalId, activityName) =>
  request(`/digital-twin/identity/goals/${goalId}/activities/${encodeURIComponent(activityName)}`, { method: 'DELETE' });
export const addGoalProgress = (goalId, data) => request(`/digital-twin/identity/goals/${goalId}/progress`, {
  method: 'POST',
  body: JSON.stringify(data)
});
export const deleteGoalProgress = (goalId, entryId) =>
  request(`/digital-twin/identity/goals/${goalId}/progress/${entryId}`, { method: 'DELETE' });

// Goal Calendar linking
export const linkGoalCalendar = (goalId, data) => request(`/digital-twin/identity/goals/${goalId}/calendars`, { method: 'POST', body: JSON.stringify(data) });
export const unlinkGoalCalendar = (goalId, subcalendarId) => request(`/digital-twin/identity/goals/${goalId}/calendars/${encodeURIComponent(subcalendarId)}`, { method: 'DELETE' });
export const getGoalCalendarEvents = (goalId, params = {}) => {
  const str = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return request(`/digital-twin/identity/goals/${goalId}/calendar-events${str ? `?${str}` : ''}`);
};

// Goal Progress & Todos
export const updateGoalProgress = (goalId, value) => request(`/digital-twin/identity/goals/${goalId}/progress`, { method: 'PUT', body: JSON.stringify({ value }) });
export const addGoalTodo = (goalId, data) => request(`/digital-twin/identity/goals/${goalId}/todos`, { method: 'POST', body: JSON.stringify(data) });
export const updateGoalTodo = (goalId, todoId, data) => request(`/digital-twin/identity/goals/${goalId}/todos/${todoId}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteGoalTodo = (goalId, todoId) => request(`/digital-twin/identity/goals/${goalId}/todos/${todoId}`, { method: 'DELETE' });

// Goal AI Planning & Scheduling
export const generateGoalPhases = (goalId, options = {}) => request(`/digital-twin/identity/goals/${goalId}/generate-phases`, { method: 'POST', body: JSON.stringify(options) });
export const acceptGoalPhases = (goalId, phases) => request(`/digital-twin/identity/goals/${goalId}/accept-phases`, { method: 'POST', body: JSON.stringify({ phases }) });
export const organizeGoals = (options = {}) => request('/digital-twin/identity/goals/organize', { method: 'POST', body: JSON.stringify(options) });
export const applyGoalOrganization = (organization) => request('/digital-twin/identity/goals/organize/apply', { method: 'POST', body: JSON.stringify({ organization }) });
export const checkInGoal = (goalId, options = {}) => request(`/digital-twin/identity/goals/${goalId}/check-in`, { method: 'POST', body: JSON.stringify(options) });
export const scheduleGoalTimeBlocks = (goalId) => request(`/digital-twin/identity/goals/${goalId}/schedule`, { method: 'POST' });
export const removeGoalSchedule = (goalId) => request(`/digital-twin/identity/goals/${goalId}/schedule`, { method: 'DELETE' });
export const rescheduleGoalTimeBlocks = (goalId) => request(`/digital-twin/identity/goals/${goalId}/reschedule`, { method: 'POST' });
