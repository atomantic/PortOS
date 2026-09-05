/** Human-approved local routes and one-shot self-wake requests. No inference. */
import { canonicalStringify } from '../lib/objects.js';
import { sha256Text } from '../lib/fileUtils.js';
import { localRuntimeForProvider, normalizeOpenAiBaseUrl } from '../lib/localProviderRuntime.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { normalizePersistentMindState } from '../lib/persistentMind.js';
import {
  normalizePersistentMindThinkingPresets,
  persistentMindThinkingRequestSchema,
  PERSISTENT_MIND_THINKING_LIMITS,
} from '../lib/persistentMindThinkingPresets.js';
import { loadState, saveState, withStateLock } from './cosState.js';
import { resolvePersistentMindThinkingSession } from './persistentMindProfile.js';
import { appendMindEvent } from './agentRunEventLog.js';

// A direct local API transport has no account-backed CLI fallback. Remove all
// display/model identity heuristics before asking the shared runtime resolver.
function localGrant(selection, provider) {
  if (provider?.type !== 'api' || !provider.endpoint || provider.apiKey || provider.apiKeyEnvVar
      || provider.gatewayBacked || provider.orcarouterBacked
      || Object.keys(provider.envVars || {}).length) return null;
  const url = URL.parse(provider.endpoint);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const runtime = localRuntimeForProvider({ ...provider, id: '', name: '', defaultModel: '', command: '' });
  if (!runtime || runtime.endpoint !== normalizeOpenAiBaseUrl(provider.endpoint)) return null;
  return sha256Text(canonicalStringify({
    selection, name: provider.name || '', type: provider.type,
    endpoint: provider.endpoint, runtime: runtime.kind, apiFormat: provider.apiFormat || '',
  }));
}

async function eligible(config) {
  const rows = [];
  for (const selection of normalizePersistentMindThinkingPresets(config?.persistentMindThinkingPresets).presets) {
    const route = await resolvePersistentMindThinkingSession({ presetId: selection.id, selection, config });
    const grant = route.ok ? localGrant(selection, route.provider) : null;
    if (grant) rows.push({ selection, grant, route });
  }
  return rows;
}

/** Called ONLY by the human config update path, never by semantic actions. */
export async function approvePersistentMindThinkingPresets(config, ids) {
  const rows = await eligible(config);
  return Object.fromEntries(rows.filter(({ selection }) => ids.includes(selection.id))
    .map(({ selection, grant }) => [selection.id, grant]));
}

export async function resolvePersistentMindSelfThinkingRequest({ request, config }) {
  const grants = normalizePersistentMindCapabilities(config?.persistentMindCapabilities);
  const refused = { ok: false, requiresResubmission: true, error: 'Local thinking request was revoked or its approved route changed' };
  if (!request || !grants.chooseThinkingPreset || !grants.thinkingPresetAllowlist.includes(request.selection.id)
      || grants.thinkingPresetGrants[request.selection.id] !== request.grant) return refused;
  const route = await resolvePersistentMindThinkingSession({ presetId: request.selection.id, selection: request.selection, config });
  if (!route.ok) return { ...route, requiresResubmission: true };
  return localGrant(request.selection, route.provider) === request.grant ? route : refused;
}

export async function getPersistentMindThinkingRequestCatalog({ human = false } = {}) {
  const root = await loadState();
  const mind = normalizePersistentMindState(root.persistentMind);
  const grants = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  const rows = await eligible(root.config);
  return {
    enabled: grants.chooseThinkingPreset,
    presets: rows.filter(({ selection, grant }) => human || (grants.chooseThinkingPreset
      && grants.thinkingPresetAllowlist.includes(selection.id) && grants.thinkingPresetGrants[selection.id] === grant))
      .map(({ selection }) => selection),
    current: mind.activeTurn ? { providerId: mind.activeTurn.providerId, model: mind.activeTurn.model, effort: mind.activeTurn.effort } : null,
    default: root.config?.persistentMindProfile ? {
      providerId: root.config.persistentMindProfile.providerId, model: root.config.persistentMindProfile.model,
      effort: root.config.persistentMindProfile.effort,
    } : null,
    limits: PERSISTENT_MIND_THINKING_LIMITS,
    pending: mind.thinkingRequests.pending ? publicRequest(mind.thinkingRequests.pending) : null,
    recent: mind.thinkingRequests.history.map(publicRequest),
    explanation: 'Next self-directed wake only; current turn and default remain unchanged. One pending or active request, three per rolling 24 hours, 30 minutes apart. Cancellation and failure do not refund allowance.',
  };
}

const publicRequest = ({ requestId, at, reason, selection, outcome = 'pending' }) => ({ requestId, at, reason, outcome, presetId: selection.id, label: selection.label });

export async function requestPersistentMindThinkingPreset(args, { turnId, requestId, signal } = {}) {
  const parsed = persistentMindThinkingRequestSchema.parse(args);
  return withStateLock(async () => {
    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    const fail = (error) => ({ ok: false, error });
    if (signal?.aborted || !turnId || !requestId || mind.activeTurn?.id !== turnId || !mind.started || !mind.enabled) return fail('Request requires the active mind turn');
    const prior = mind.thinkingRequests.history.find((entry) => entry.requestId === requestId);
    if (prior) return prior.selection.id === parsed.presetId && prior.reason === parsed.reason
      ? { ok: true, duplicate: true, request: publicRequest(prior) } : fail('Request id already used');
    if (mind.thinkingRequests.pending || mind.activeTurn.wake?.thinkingRequest) return fail('A local thinking request is already pending or active');
    const now = Date.now();
    const recent = mind.thinkingRequests.history.filter((entry) => Date.parse(entry.admittedAt || entry.at) > now - PERSISTENT_MIND_THINKING_LIMITS.rollingWindowMs);
    if (recent.length >= PERSISTENT_MIND_THINKING_LIMITS.maxPerRollingDay) return fail('Three local thinking requests already used in the rolling 24 hours');
    if (recent.some((entry) => now - Date.parse(entry.admittedAt || entry.at) < PERSISTENT_MIND_THINKING_LIMITS.minGapMs)) return fail('Local thinking requests must be 30 minutes apart');
    const grants = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
    const selection = normalizePersistentMindThinkingPresets(root.config?.persistentMindThinkingPresets).presets.find((entry) => entry.id === parsed.presetId);
    if (!selection) return fail('Preset is no longer available');
    const request = { outcome: 'pending', requestId, turnId, at: new Date(now).toISOString(), reason: parsed.reason, selection, grant: grants.thinkingPresetGrants[selection.id] };
    const route = await resolvePersistentMindSelfThinkingRequest({ request, config: root.config });
    if (!route.ok) return fail(route.error);
    if (signal?.aborted) return fail('Mind turn interrupted');
    mind.thinkingRequests = { pending: request, history: [...mind.thinkingRequests.history, request].slice(-20) };
    root.persistentMind = mind;
    // Charge before emitting or returning, so uncertain delivery never refunds.
    await saveState(root);
    await appendMindEvent({ kind: 'mind.capability.request', mindId: mind.mindId, turnId,
      eventId: `thinking-request:${requestId}`, data: { ...publicRequest(request), displayText: `Requested local preset ${selection.label}: ${parsed.reason}` } });
    return { ok: true, request: publicRequest(request) };
  });
}

export async function cancelPersistentMindThinkingRequest({ ifRevoked = false } = {}) {
  return withStateLock(async () => {
    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    const request = mind.thinkingRequests.pending;
    if (ifRevoked && request) {
      const route = await resolvePersistentMindSelfThinkingRequest({ request, config: root.config });
      if (route.ok) return { ok: true, cancelled: false };
    }
    mind.thinkingRequests.pending = null;
    mind.thinkingRequests.history = mind.thinkingRequests.history.map((entry) => entry.requestId === request?.requestId ? { ...entry, outcome: 'cancelled' } : entry);
    root.persistentMind = mind;
    await saveState(root);
    if (request) await appendMindEvent({ kind: 'mind.capability.result', mindId: mind.mindId, turnId: request.turnId,
      eventId: `thinking-cancelled:${request.requestId}`, data: { ...publicRequest(request), displayText: 'Pending local thinking request cancelled; allowance retained', outcome: 'cancelled' } });
    return { ok: true };
  });
}
