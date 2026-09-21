import { request } from './apiCore.js';

// Public — no token required. Callers use this to decide whether to render
// the login gate at all.
export const getAuthStatus = (options) => request('/auth/status', options);

export const getPasswordRiskStatus = (options) => request('/auth/password-risk', options);

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

// Lists live sessions (label + expiresAt only) for Settings → Security.
export const listAuthSessions = (options) => request('/auth/sessions', options);

// Revokes one session by its opaque id — e.g. the agent's loopback
// credential — without signing the caller's own browser session out.
export const revokeAuthSession = (id, options) => request(`/auth/sessions/${encodeURIComponent(id)}`, {
  method: 'DELETE',
  silent: true,
  ...options,
});
