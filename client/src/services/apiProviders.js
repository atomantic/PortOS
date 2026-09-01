import { request } from './apiCore.js';

// Providers
// `options` (e.g. { silent: true }) lets callers that own their own error UI
// suppress the helper's default error toast.
export const getProviders = (options) => request('/providers', options);
export const getActiveProvider = () => request('/providers/active');
export const setActiveProvider = (id) => request('/providers/active', {
  method: 'PUT',
  body: JSON.stringify({ id })
});
export const getProvider = (id) => request(`/providers/${id}`);
export const createProvider = (data) => request('/providers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateProvider = (id, data) => request(`/providers/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteProvider = (id) => request(`/providers/${id}`, { method: 'DELETE' });
export const getSampleProviders = () => request('/providers/samples');
export const testProvider = (id) => request(`/providers/${id}/test`, { method: 'POST' });
export const refreshProviderModels = (id, options) => request(`/providers/${id}/refresh-models`, { method: 'POST', ...options });
// Which provider runtimes (claude, codex, opencode, …) are runnable on this
// host, and which of them PortOS can install for you. Installs happen only
// after an explicit Providers-page click; the status payload carries booleans
// and labels only — never local executable paths.
export const getProviderRuntimes = (options) => request('/providers/runtimes', options);
// Per-provider requirements checklist for providers backed by a LOCAL daemon
// (llama.cpp, Ollama, LM Studio, MTPLX): is it installed, is it running, is it
// serving the model this provider asks for. Keyed by provider id; providers
// with no local dependency are absent from the map.
export const getProviderReadiness = (options) => request('/providers/readiness', options);
// The model-mismatch fix that moves the SERVER rather than the provider:
// llama.cpp serves one model per process under the `--alias` on its launch
// line, so PortOS can relaunch the weights it already has under the id this
// provider sends. The model id is re-derived server-side from the stored
// record — this call names only the provider.
export const serveProviderModel = (id, options) => request(
  `/providers/readiness/serve-model?provider=${encodeURIComponent(id)}`,
  { method: 'POST', ...options },
);

// Provider status (usage limits, availability)
export const getProviderStatuses = () => request('/providers/status');
export const getProviderStatus = (id) => request(`/providers/${id}/status`);
export const recoverProvider = (id, options) => request(`/providers/${id}/status/recover`, { method: 'POST', ...options });

// Codex / ChatGPT subscription account (#5589). The Codex app-server owns the
// credentials: these calls report and change SIGN-IN STATE only, and no
// response ever carries a token, an account id, or a credential path.
//
// `fresh` skips the server's short readiness TTL — use it for the poll that
// follows a sign-in, not for the page's idle refresh.
export const getCodexAccount = (options = {}) => {
  const { fresh = false, ...rest } = options;
  return request(`/providers/codex/account${fresh ? '?fresh=1' : ''}`, rest);
};
// Starts the ChatGPT OAuth flow and resolves to { login: { loginId, authUrl,
// verificationUrl, userCode, expiresAt } }. Only ever call this from an
// explicit user action — it opens a real sign-in.
export const startCodexLogin = (deviceCode = false, options) => request('/providers/codex/account/login', {
  method: 'POST',
  body: JSON.stringify({ deviceCode }),
  ...options,
});
// Abandons a sign-in this browser started. The id must be the one
// `startCodexLogin` returned; a stale tab's id is refused with a 409.
export const cancelCodexLogin = (loginId, options) => request('/providers/codex/account/login/cancel', {
  method: 'POST',
  body: JSON.stringify({ loginId }),
  ...options,
});
export const codexLogout = (options) => request('/providers/codex/account/logout', { method: 'POST', ...options });
// The models this subscription may run, from the app-server catalog (#5590).
// Not yet called from a component: the Providers-page picker that consumes it is
// #5591 (phase 3), which also ships the toggle that sets `textTransportEnabled`.
// Resolves to { models, fetchedAt, error }. `models: null` means NEVER FETCHED
// and `[]` means fetched-and-empty; when `error` is set the list is the
// last-known-good one, so render that rather than emptying the picker.
export const getCodexModels = (options = {}) => {
  const { fresh = false, ...rest } = options;
  return request(`/providers/codex/models${fresh ? '?fresh=1' : ''}`, rest);
};
