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
export const createProvider = (data) => request('/providers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateProvider = (id, data, options = {}) => request(`/providers/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options,
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
// This is the LAZY read that may spawn `codex app-server` — call it only from an
// explicit user action (the Providers page's refresh). Render paths read the
// cached catalog off `codexModelCatalog` on the `GET /providers` payload instead
// (#6306), which spawns nothing.
// Resolves to { models, fetchedAt, error }. `models: null` means NEVER FETCHED
// and `[]` means fetched-and-empty; when `error` is set the list is the
// last-known-good one, so render that rather than emptying the picker.
export const getCodexModels = (options = {}) => {
  const { fresh = false, ...rest } = options;
  return request(`/providers/codex/models${fresh ? '?fresh=1' : ''}`, rest);
};

export const getFleetLlmHost = (options) => request('/providers/fleet-host', options);
export const revealFleetLlmHostKey = (options) => request('/providers/fleet-host/key', { method: 'POST', ...options });
export const getFleetPeerHosts = (options) => request('/providers/fleet-peer-hosts', options);
export const revealFleetPeerHostKey = (peerId, options) => request(`/providers/fleet-peer-hosts/${encodeURIComponent(peerId)}/key`, { method: 'POST', ...options });

// --- provider connection graph management (#6369) ----------------------------
// The MANAGEMENT surface, separate from the flat `/providers` execution list
// above. Every response here is credential-free: a connection reports whether
// it `hasCredentials`, never the secret, and no projection snapshot is exposed.

/**
 * Whether a failed management call means "this server has no management API"
 * rather than "the call failed".
 *
 * Only two answers count, and both are the server saying so explicitly: a 404
 * (an older build with no such route) and the graph's own
 * `PROVIDER_GRAPH_UNAVAILABLE` 503. A timeout, a 500 or an offline server is
 * NOT an unsupported server — treating it as one would quietly downgrade a
 * working install to the legacy view and hide a real outage.
 */
export const isManagementUnsupported = (error) =>
  error?.status === 404 || error?.code === 'PROVIDER_GRAPH_UNAVAILABLE';

/** The durable graph: connections, harness bindings and executable routes. */
export const getProviderManagementGraph = (options) => request('/providers/management', options);

/** What linking this binding onto another connection would change. Read-only. */
export const previewProviderBindingLink = (bindingId, body, options) => request(
  `/providers/bindings/${encodeURIComponent(bindingId)}/link/preview`,
  { method: 'POST', body: JSON.stringify(body), ...options },
);

/** Apply a reviewed link. Every revision named in `body` is re-checked server-side. */
export const linkProviderBinding = (bindingId, body, options) => request(
  `/providers/bindings/${encodeURIComponent(bindingId)}/link`,
  { method: 'POST', body: JSON.stringify(body), ...options },
);

/** Give this binding its own copy of the connection it shares. Route ids are kept. */
export const unlinkProviderBinding = (bindingId, body, options) => request(
  `/providers/bindings/${encodeURIComponent(bindingId)}/unlink`,
  { method: 'POST', body: JSON.stringify(body ?? {}), ...options },
);

/**
 * Edit one shared backend. `expectedRevision` is required; a 409
 * `PROVIDER_GRAPH_STALE_REVISION` means the row moved and the edit must be
 * re-made against a fresh read. Omit a credential key to preserve it, send
 * `null` to clear it — never send back the redacted placeholder.
 */
export const updateProviderConnection = (connectionId, body, options) => request(
  `/providers/connections/${encodeURIComponent(connectionId)}`,
  { method: 'PATCH', body: JSON.stringify(body), ...options },
);

/** Probe the shared model catalog once for every harness on this connection. */
export const refreshProviderConnectionModels = (connectionId, options) => request(
  `/providers/connections/${encodeURIComponent(connectionId)}/refresh-models`,
  { method: 'POST', ...options },
);

/** Edit a binding's label and the subset of the shared catalog it offers. */
export const updateProviderBinding = (bindingId, body, options) => request(
  `/providers/bindings/${encodeURIComponent(bindingId)}`,
  { method: 'PATCH', body: JSON.stringify(body), ...options },
);

/** Delete a connection no binding uses. Refused with a 409 while one still does. */
export const deleteProviderConnection = (connectionId, options) => request(
  `/providers/connections/${encodeURIComponent(connectionId)}`,
  { method: 'DELETE', ...options },
);

/**
 * Edit ONE route's mode overrides — args, timeout, effort, model pins.
 *
 * `expectedRevision` is the route's `settingsRevision` from the management
 * graph, a fingerprint of the values on disk: a 409 means somebody (or the
 * route editor in another tab) changed them and the edit must be re-made
 * against a fresh read. Connection-owned values and the `enabled` flag are not
 * reachable here — those stay on the connection and the route editor.
 */
export const updateProviderRouteSettings = (providerId, body, options) => request(
  `/providers/routes/${encodeURIComponent(providerId)}`,
  { method: 'PATCH', body: JSON.stringify(body), ...options },
);

/**
 * Edit ONE route's hand-authored canonical→executable model aliases.
 *
 * The correction surface for a `modelMap` a refresh could only fill with the
 * aliases it could verify. `null` for a key removes that override and is the
 * only thing that does — a refresh rewrites what it observed in a separate
 * column, so a correction survives it. `expectedRevision` is the route's
 * `modelAliasRevision` from the management graph; a 409 means the aliases moved
 * and the edit must be re-made against a fresh read.
 */
export const updateProviderRouteModelAliases = (providerId, body, options) => request(
  `/providers/routes/${encodeURIComponent(providerId)}/model-aliases`,
  { method: 'PATCH', body: JSON.stringify(body), ...options },
);
