/**
 * Consumer-side discovery and selection for federated media providers.
 *
 * This module establishes the explicit per-peer allowlist and fail-closed
 * capacity preflight used by remote executors before they submit work.
 */

import { ServerError } from '../lib/errorHandler.js';
import {
  federatedMediaProviderStatusSchema,
  inspectFederatedMediaStatusFreshness,
} from '../lib/federatedMediaWire.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { readResponseJson } from '../lib/readResponseJson.js';

export const DEFAULT_FEDERATED_MEDIA_PEER_CONFIG = Object.freeze({
  enabled: false,
  audioModels: Object.freeze([]),
});

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const modelKey = ({ engine, modelId }) => `${engine}\u0000${modelId}`;

function sanitizeModels(models, { preserveUnknown = false } = {}) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const model of models) {
    if (!isRecord(model)) continue;
    const engine = typeof model.engine === 'string' ? model.engine.trim() : '';
    const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
    if (!engine || !modelId) continue;
    const key = modelKey({ engine, modelId });
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(preserveUnknown ? { ...model, engine, modelId } : { engine, modelId });
    if (sanitized.length === 100) break;
  }
  return sanitized;
}

export function normalizePeerMediaProviderConfig(peer) {
  const raw = peer?.mediaProvider;
  if (!isRecord(raw)) {
    return { ...DEFAULT_FEDERATED_MEDIA_PEER_CONFIG, audioModels: [] };
  }
  return {
    enabled: raw.enabled === true,
    audioModels: sanitizeModels(raw.audioModels),
  };
}

/**
 * Merge a validated client patch without dropping fields written by a newer
 * PortOS version. Known values are normalized; unknown object/model fields are
 * carried forward for rollback compatibility.
 */
export function mergePeerMediaProviderConfig(current, patch) {
  const base = isRecord(current) ? current : {};
  const incoming = isRecord(patch) ? patch : {};
  const merged = { ...base, ...incoming };
  return {
    ...merged,
    enabled: merged.enabled === true,
    audioModels: sanitizeModels(merged.audioModels, { preserveUnknown: true }),
  };
}

const checkedAt = (now) => new Date(now).toISOString();
const probeResult = (now, state, reason, snapshot = null, freshUntil = null) => ({
  checkedAt: checkedAt(now),
  state,
  reason,
  freshUntil,
  snapshot,
});

function responseState(response, body) {
  if (response.status === 404) return ['unsupported', 'wire-v1-not-supported'];
  if (response.status === 401 || response.status === 403) return ['unauthorized', body?.code || `http-${response.status}`];
  if (body?.code === 'MEDIA_PROVIDER_DISABLED') return ['disabled', body.code];
  return ['unavailable', body?.code || `http-${response.status || 'error'}`];
}

/**
 * Fetch and sanitize one opted-in peer's live status. All failures become a
 * typed local projection instead of escaping into the background probe loop.
 */
export async function probeFederatedMediaProvider(peer, { signal, now = Date.now() } = {}) {
  const config = normalizePeerMediaProviderConfig(peer);
  if (!config.enabled) return probeResult(now, 'disabled', 'not-configured');

  const outcome = await peerFetch(
    `${peerBaseUrl(peer)}/api/federation/media/v1/status`,
    { signal },
    peer,
  ).then((response) => ({ response }), (error) => ({ error }));
  if (outcome.error) {
    return probeResult(now, 'unreachable', outcome.error?.name === 'AbortError' ? 'timeout' : 'request-failed');
  }

  const body = await readResponseJson(outcome.response, { fallback: null, emptyValue: null }).catch(() => null);
  if (!outcome.response.ok) {
    const [state, reason] = responseState(outcome.response, body);
    return probeResult(now, state, reason);
  }

  const parsed = federatedMediaProviderStatusSchema.safeParse(body);
  if (!parsed.success) return probeResult(now, 'invalid', 'invalid-wire-response');

  const freshness = inspectFederatedMediaStatusFreshness(parsed.data, now);
  if (!freshness.fresh) {
    return probeResult(now, 'stale', freshness.reason, parsed.data, freshness.freshUntil);
  }

  const providerState = parsed.data.status === 'ready' && !parsed.data.queue.accepting
    ? 'busy'
    : parsed.data.status;
  return probeResult(
    now,
    providerState,
    providerState === 'ready' ? null : `provider-${providerState}`,
    parsed.data,
    freshness.freshUntil,
  );
}

const rejectSelection = (message, code, status = 503, reason) => {
  throw new ServerError(message, {
    status,
    code,
    ...(reason ? { context: { reason } } : {}),
  });
};

/**
 * Enforce the local user's explicit peer/model choice against a fresh status.
 * The provider still rechecks admission on submit; this advisory preflight
 * prevents arbitrary peer routing and known-bad work from leaving this node.
 */
export function assertFederatedMediaProviderSelection(peer, selection, probe, { now = Date.now() } = {}) {
  if (!peer || peer.enabled === false) {
    rejectSelection('Selected media provider peer is disabled', 'MEDIA_PROVIDER_PEER_DISABLED', 409);
  }
  const config = normalizePeerMediaProviderConfig(peer);
  if (!config.enabled) {
    rejectSelection('Peer is not enabled as a media provider', 'MEDIA_PROVIDER_NOT_CONFIGURED', 409);
  }
  if (selection?.kind !== 'audio' || typeof selection.engine !== 'string' || typeof selection.modelId !== 'string') {
    rejectSelection('Only an explicit audio engine and model can be selected', 'MEDIA_PROVIDER_SELECTION_INVALID', 400);
  }
  const requested = { engine: selection.engine.trim(), modelId: selection.modelId.trim() };
  if (!requested.engine || !requested.modelId
    || !config.audioModels.some((model) => modelKey(model) === modelKey(requested))) {
    rejectSelection('Requested model is not allowlisted for this peer', 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', 403);
  }

  if (probe?.state === 'stale') {
    rejectSelection('Media provider capacity is stale', 'MEDIA_PROVIDER_STATUS_STALE', 503, probe.reason);
  }
  if (probe?.state === 'busy') {
    rejectSelection('Media provider is at capacity', 'MEDIA_PROVIDER_BUSY', 429, probe.reason);
  }
  if (probe?.state !== 'ready' || !probe.snapshot) {
    rejectSelection('Media provider is unavailable', 'MEDIA_PROVIDER_UNAVAILABLE', 503, probe?.reason || 'status-unknown');
  }
  const parsedSnapshot = federatedMediaProviderStatusSchema.safeParse(probe.snapshot);
  if (!parsedSnapshot.success) {
    rejectSelection('Media provider status is invalid', 'MEDIA_PROVIDER_UNAVAILABLE', 503, 'invalid-wire-response');
  }
  const snapshot = parsedSnapshot.data;
  if (snapshot.status === 'busy') {
    rejectSelection('Media provider is at capacity', 'MEDIA_PROVIDER_BUSY', 429, 'provider-busy');
  }
  if (snapshot.status !== 'ready') {
    rejectSelection('Media provider is unavailable', 'MEDIA_PROVIDER_UNAVAILABLE', 503, 'provider-unavailable');
  }
  const freshness = inspectFederatedMediaStatusFreshness(snapshot, now);
  if (!freshness.fresh) {
    rejectSelection('Media provider capacity is stale', 'MEDIA_PROVIDER_STATUS_STALE', 503, freshness.reason);
  }
  if (!snapshot.queue.accepting) {
    rejectSelection('Media provider is at capacity', 'MEDIA_PROVIDER_BUSY', 429, 'queue-full');
  }

  const capability = snapshot.capabilities.find((candidate) =>
    candidate.kind === 'audio'
    && candidate.engine === requested.engine
    && candidate.modelId === requested.modelId,
  );
  if (!capability || !capability.ready
    || (capability.cudaRequired && capability.cudaState !== 'available')) {
    rejectSelection(
      'Selected media provider model is unavailable',
      'MEDIA_PROVIDER_MODEL_UNAVAILABLE',
      503,
      capability?.unavailableReason || 'capability-unavailable',
    );
  }
  return { peer, capability, status: snapshot };
}

export async function resolveFederatedMediaProvider(peer, selection, options = {}) {
  const probe = await probeFederatedMediaProvider(peer, options);
  return assertFederatedMediaProviderSelection(peer, selection, probe, options);
}
