import { request } from './apiCore.js';

// Automation Schedules
export const getAutomationSchedules = (agentId = null, accountId = null) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (accountId) params.set('accountId', accountId);
  const query = params.toString();
  return request(`/agents/schedules${query ? `?${query}` : ''}`);
};
export const getAutomationSchedule = (id) => request(`/agents/schedules/${id}`);
export const getScheduleStats = () => request('/agents/schedules/stats');
export const createAutomationSchedule = (data) => request('/agents/schedules', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAutomationSchedule = (id, data) => request(`/agents/schedules/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteAutomationSchedule = (id) => request(`/agents/schedules/${id}`, { method: 'DELETE' });
export const toggleAutomationSchedule = (id, enabled) => request(`/agents/schedules/${id}/toggle`, {
  method: 'POST',
  body: JSON.stringify({ enabled })
});
export const runAutomationScheduleNow = (id) => request(`/agents/schedules/${id}/run`, { method: 'POST' });
