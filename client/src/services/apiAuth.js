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

// Revokes every agent-labelled session in one call; the caller's browser
// session stays signed in. Resolves `{ ok, revoked }`.
export const revokeAllAgentSessions = (options) => request('/auth/sessions?label=agent', {
  method: 'DELETE',
  silent: true,
  ...options,
});

// Agent API key (Settings → Security): state only, never the token itself.
export const getAgentKeyStatus = (options) => request('/auth/agent-key', options);

export const setAgentKeyEnabled = (enabled) => request('/auth/agent-key', {
  method: 'PUT',
  body: JSON.stringify({ enabled }),
  silent: true,
});

export const rotateAgentKey = () => request('/auth/agent-key/rotate', {
  method: 'POST',
  silent: true,
});
