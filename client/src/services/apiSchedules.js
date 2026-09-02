import { request } from './apiCore.js';

// Automation Schedules
export const getAutomationSchedules = (agentId = null, accountId = null, options = {}) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (accountId) params.set('accountId', accountId);
  const query = params.toString();
  return request(`/agents/schedules${query ? `?${query}` : ''}`, options);
};
export const getScheduleStats = (options = {}) => request('/agents/schedules/stats', options);
export const createAutomationSchedule = (data) => request('/agents/schedules', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const deleteAutomationSchedule = (id) => request(`/agents/schedules/${id}`, { method: 'DELETE' });
export const toggleAutomationSchedule = (id, enabled) => request(`/agents/schedules/${id}/toggle`, {
  method: 'POST',
  body: JSON.stringify({ enabled })
});
export const runAutomationScheduleNow = (id) => request(`/agents/schedules/${id}/run`, { method: 'POST' });
