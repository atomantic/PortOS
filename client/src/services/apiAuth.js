import { request } from './apiCore.js';

// Public — no token required. Callers use this to decide whether to render
// the login gate at all.
export const getAuthStatus = (options) => request('/auth/status', options);

export const loginWithPassword = (password) => request('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ password }),
  silent: true,
});

export const setAuthPassword = ({ newPassword, currentPassword }) => request('/auth/password', {
  method: 'POST',
  body: JSON.stringify({ newPassword, ...(currentPassword ? { currentPassword } : {}) }),
  silent: true,
});

export const clearAuthPassword = ({ currentPassword }) => request('/auth/password', {
  method: 'DELETE',
  body: JSON.stringify({ currentPassword }),
  silent: true,
});
