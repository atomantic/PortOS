import { request } from './apiCore.js';
import socket from './socket.js';
import toast from '../components/ui/Toast';

// Providers
let generation = 0;
let snapshot = null;
let expiresAt = 0;
let pending = null;

const invalidateProviders = () => {
  generation += 1;
  snapshot = null;
  pending = null;
  expiresAt = 0;
};
let listenersInstalled = false;
const listenForProviderChanges = () => {
  if (listenersInstalled) return;
  socket.on('providers:changed', invalidateProviders);
  socket.on('connect', invalidateProviders);
  listenersInstalled = true;
};

// Chained onto each mutation's own `request('/providers…')` call (rather than
// wrapping `request` in a path-taking helper) so every mutation path stays a
// literal the client↔server route-parity scan can check.
const invalidateAfter = (result) => {
  invalidateProviders();
  return result;
};

// The shared request has no caller's signal: aborting one picker must not
// cancel another. Toasting remains per caller, including mixed silent callers.
export const getProviders = (options = {}) => {
  listenForProviderChanges();
  const { fresh = false, signal, silent = false, ...rest } = options;
  if (fresh) invalidateProviders();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (!snapshot || Date.now() >= expiresAt) {
    if (!pending) {
      const readGeneration = generation;
      const read = request('/providers', { ...rest, silent: true }).then(data => {
        if (readGeneration === generation) {
          snapshot = data;
          expiresAt = Date.now() + 60_000;
        }
        return data;
      }).finally(() => { if (pending === read) pending = null; });
      pending = read;
    }
  }
  const read = snapshot && Date.now() < expiresAt ? Promise.resolve(snapshot) : pending;
  const detached = signal ? Promise.race([
    read,
    new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      read.finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    }),
  ]) : read;
  return detached.then(data => structuredClone(data), error => {
    if (!silent && error?.name !== 'AbortError' && error?.code !== 'AUTH_REQUIRED') toast.error(error.message);
    throw error;
  });
};
export const getActiveProvider = () => request('/providers/active');
export const setActiveProvider = (id) => request('/providers/active', {
  method: 'PUT',
  body: JSON.stringify({ id })
}).then(invalidateAfter);
export const createProvider = (data) => request('/providers', {
  method: 'POST',
  body: JSON.stringify(data)
}).then(invalidateAfter);
export const updateProvider = (id, data, options = {}) => request(`/providers/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options,
}).then(invalidateAfter);
export const deleteProvider = (id) => request(`/providers/${id}`, { method: 'DELETE' }).then(invalidateAfter);
// Mint the TUI half of an existing CLI provider's harness. No body: the sibling
// is built from the stored record plus the harness recipe's interactive argv,
// so the connection details never get retyped (and never get retyped WRONG,
// which would leave two unrelated routes instead of one CLI / TUI card).
export const addProviderTuiMode = (id, options = {}) => request(`/providers/${id}/modes/tui`, {
  method: 'POST',
  ...options,
}).then(invalidateAfter);
export const getSampleProviders = () => request('/providers/samples');
// The composition catalog (#7564/#7566): harnesses with enablement, service
// instances, bootstrap apps, per-harness (and per-model) effort ladders, the
// harness/service compatibility map, and the sanitized presets — everything
// `useProviderCatalog` composes a preset-first picker and the compose popover
// over. `GET /providers` above stays presets-only for every existing
// `useProviderModels` consumer.
export const getProviderCatalog = (options) => request('/providers/catalog', options);
// Presets (#7565): "Convert to derived preset" stamps a legacy record with the
// service it already runs on — refused (409) when re-deriving it would change
// how it runs.
export const deriveProviderPreset = (id, options = {}) => request(`/providers/${encodeURIComponent(id)}/derive`, {
  method: 'POST',
  ...options,
}).then(invalidateAfter);
// "Save as preset" (#7565/#7566): the compose popover's own wrapper — turn the
// composite id (plus the model/effort the user picked while composing) into a
// stored, enabled derived preset. A 400 names the composite's own ineligibility
// code/reason; never a stored record that cannot run.
export const createProviderPreset = (body, options) => request('/providers/presets', {
  method: 'POST',
  body: JSON.stringify(body),
  ...options,
}).then(invalidateAfter);
export const testProvider = (id) => request(`/providers/${id}/test`, { method: 'POST' });

// --- the composed axes the AI Providers page manages (#7567, epic #7561) -----
// Harness enablement (the read rides the composition catalog above), services
// (instances of a definition: plan + credential + catalog), and
// credential-bootstrap apps. Every response is credential-free: a service
// reports `hasCredentials` / `credentialSource`, never a value. Nothing here
// contacts a provider except the explicit catalog refresh — listing, creating
// and toggling are local reads and writes.

/** The user's word on one harness. `direct` cannot be switched off; the server refuses it. */
export const setProviderHarnessEnabled = (harnessId, enabled, options) => request(
  `/providers/harnesses/${encodeURIComponent(harnessId)}`,
  { method: 'PUT', body: JSON.stringify({ enabled }), ...options },
).then(invalidateAfter);

/** The credential-bootstrap table, keyed by slug — command lines included, for the editor. */
export const getProviderBootstraps = (options) => request('/providers/bootstraps', options);
/** Replace the whole table. Saving never spawns anything. */
export const saveProviderBootstraps = (bootstraps, options) => request('/providers/bootstraps', {
  method: 'PUT', body: JSON.stringify({ bootstraps }), ...options,
}).then(invalidateAfter);

/** Every `SERVICE_DEFINITIONS` row an "Add service" flow may instantiate. */
export const getProviderServiceDefinitions = (options) => request('/providers/service-definitions', options);
/** Every service instance, sanitized. */
export const getProviderServices = (options) => request('/providers/services', options);
/** Create an instance from a definition. Nothing is probed; the catalog starts `unknown`. */
export const createProviderService = (body, options) => request('/providers/services', {
  method: 'POST', body: JSON.stringify(body), ...options,
}).then(invalidateAfter);
/**
 * Edit one instance: label, endpoints, credential, plan, enabled. `expectedRevision`
 * is required; a 409 means the row moved. Omit a credential key to preserve it,
 * send `null` to clear it — never send back the redacted placeholder.
 */
export const updateProviderService = (slug, body, options) => request(
  `/providers/services/${encodeURIComponent(slug)}`,
  { method: 'PATCH', body: JSON.stringify(body), ...options },
).then(invalidateAfter);
/** Delete an instance no preset uses. Refused with a 409 while one still does. */
export const deleteProviderService = (slug, options) => request(
  `/providers/services/${encodeURIComponent(slug)}`,
  { method: 'DELETE', ...options },
).then(invalidateAfter);
/** List the instance's models through its definition's strategy — an explicit discovery request. */
export const refreshProviderServiceCatalog = (slug, options) => request(
  `/providers/services/${encodeURIComponent(slug)}/refresh-catalog`,
  { method: 'POST', ...options },
).then(invalidateAfter);
export const refreshProviderModels = (id, options) => request(`/providers/${id}/refresh-models`, { method: 'POST', ...options }).then(invalidateAfter);
// Stored model pins naming a model their provider no longer lists (#7315).
// Derived on read, so it reflects a pin cleared a moment ago without a refresh.
export const getModelPinWarnings = (options) => request('/providers/model-pins', options);
// Clear ONE stale pin back to "inherit". PortOS never rewrites a user's pin on
// its own — it surfaces the retirement and this is the user's one-click undo.
export const clearModelPin = (pinId, options) => request('/providers/model-pins/clear', {
  method: 'POST',
  body: JSON.stringify({ pinId }),
  ...options,
}).then(invalidateAfter);

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
export const getFleetLlmHostUsage = (options) => request('/providers/fleet-host/usage', options);
export const stopFleetLlmHost = (options) => request('/providers/fleet-host/stop', { method: 'POST', ...options });
export const getFleetPeerHosts = (options) => request('/providers/fleet-peer-hosts', options);
export const revealFleetPeerHostKey = (peerId, options) => request(`/providers/fleet-peer-hosts/${encodeURIComponent(peerId)}/key`, { method: 'POST', ...options });
