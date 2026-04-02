import { request } from './apiCore.js';

// Calendar
export const getCalendarAccounts = () => request('/calendar/accounts');
export const createCalendarAccount = (data) => request('/calendar/accounts', { method: 'POST', body: JSON.stringify(data) });
export const updateCalendarAccount = (id, data) => request(`/calendar/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteCalendarAccount = (id) => request(`/calendar/accounts/${id}`, { method: 'DELETE' });
export const syncCalendarAccount = (accountId) => request(`/calendar/sync/${accountId}`, { method: 'POST' });
export const getCalendarSyncStatus = (accountId) => request(`/calendar/sync/${accountId}/status`);
export const getCalendarEvents = (params = {}) => {
  const str = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  return request(`/calendar/events${str ? `?${str}` : ''}`);
};
export const getCalendarTokenStatus = () => request('/calendar/debug/token-status');
export const testCalendarToken = (provider) => request('/calendar/debug/test-token', { method: 'POST', body: JSON.stringify({ provider }) });
export const clearCalendarToken = (provider) => request('/calendar/debug/clear-token', { method: 'POST', body: JSON.stringify({ provider }) });
export const updateSubcalendars = (accountId, data) => request(`/calendar/accounts/${accountId}/subcalendars`, { method: 'PUT', body: JSON.stringify(data) });
export const mcpSyncGoogleCalendar = (accountId) => request(`/calendar/sync/${accountId}/google`, { method: 'POST' });
export const mcpDiscoverCalendars = (accountId) => request(`/calendar/sync/${accountId}/discover`, { method: 'POST' });
export const getGoogleAuthStatus = () => request('/calendar/google/auth/status');
export const saveGoogleAuthCredentials = (data) => request('/calendar/google/auth/credentials', { method: 'POST', body: JSON.stringify(data) });
export const getGoogleAuthUrl = () => request('/calendar/google/auth/url');
export const clearGoogleAuth = () => request('/calendar/google/auth/clear', { method: 'POST' });
export const apiSyncGoogleCalendar = (accountId) => request(`/calendar/sync/${accountId}/api`, { method: 'POST' });
export const apiDiscoverCalendars = (accountId) => request(`/calendar/sync/${accountId}/discover-api`, { method: 'POST' });
export const startGoogleAutoConfig = () => request('/calendar/google/auto-configure/start', { method: 'POST' });
export const runGoogleAutoConfig = (email) => request('/calendar/google/auto-configure/run', { method: 'POST', body: JSON.stringify({ email }) });
export const getDailyReview = (date) => request(`/calendar/review/${date}`);
export const confirmDailyReviewEvent = (date, data) => request(`/calendar/review/${date}/confirm`, { method: 'POST', body: JSON.stringify(data) });
export const getDailyReviewHistory = (params = {}) => {
  const str = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return request(`/calendar/review/history${str ? `?${str}` : ''}`);
};
