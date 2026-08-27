/**
 * Pure persistent-CoS-mind state helpers.
 *
 * The supervisor service owns I/O and timers. This module owns the durable
 * shape and clock-driven decisions so restart recovery can replay the same
 * rules without depending on module-level process state.
 */

import { PERSISTENT_MIND_ID } from './persistentMindTrajectory.js';

export const PERSISTENT_MIND_SCHEMA_VERSION = 2;

export const PERSISTENT_MIND_STATUSES = [
  'disabled',
  'idle',
  'thinking',
  'waiting',
  'paused',
  'degraded',
  'interrupted',
  'stopping',
];

export const PERSISTENT_MIND_WAKE_KINDS = ['message', 'self'];

export const PERSISTENT_MIND_LIMITS = Object.freeze({
  MAX_QUEUED_MESSAGES: 100,
  MAX_RECENT_MESSAGE_IDS: 200,
  MAX_MESSAGE_CHARS: 8_000,
  MAX_REASON_CHARS: 500,
  BACKOFF_BASE_MS: 5_000,
  BACKOFF_MAX_MS: 15 * 60_000,
  WATCHDOG_STALE_MS: 5 * 60_000,
  MAX_QUIET_MS: 30 * 60_000,
});

const asIso = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

const asBoundedString = (value, max) => (
  typeof value === 'string' ? value.trim().slice(0, max) : ''
);

const asId = (value) => asBoundedString(value, 200);
const asMindId = (value) => asBoundedString(value, 128);

const asCount = (value) => (
  Number.isSafeInteger(value) && value >= 0 ? value : 0
);

const sanitizeMessage = (value) => {
  const id = asId(value?.id);
  const text = asBoundedString(value?.text, PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS);
  if (!id || !text) return null;
  return {
    id,
    text,
    createdAt: asIso(value?.createdAt) || new Date(0).toISOString(),
  };
};

const sanitizeSelfWake = (value) => {
  const id = asId(value?.id);
  const reason = asBoundedString(value?.reason, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS);
  const sourceTurnId = asId(value?.sourceTurnId);
  if (!id || !reason || !sourceTurnId) return null;
  return {
    id,
    kind: 'self',
    reason,
    sourceTurnId,
    createdAt: asIso(value?.createdAt) || new Date(0).toISOString(),
    notBefore: asIso(value?.notBefore),
  };
};

const sanitizeWake = (value) => {
  if (value?.kind === 'message') {
    const message = sanitizeMessage(value.message);
    return message ? { kind: 'message', message } : null;
  }
  return sanitizeSelfWake(value);
};

const sanitizeActiveTurn = (value) => {
  const id = asId(value?.id);
  const wake = sanitizeWake(value?.wake);
  if (!id || !wake) return null;
  return {
    id,
    wake,
    startedAt: asIso(value?.startedAt) || new Date(0).toISOString(),
    heartbeatAt: asIso(value?.heartbeatAt) || asIso(value?.startedAt) || new Date(0).toISOString(),
    providerId: asId(value?.providerId) || null,
    model: asBoundedString(value?.model, 500) || null,
    effort: asBoundedString(value?.effort, 100) || null,
  };
};

export function createDefaultPersistentMindState() {
  return {
    schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
    mindId: PERSISTENT_MIND_ID,
    enabled: false,
    started: false,
    status: 'disabled',
    pauseReason: null,
    queuedMessages: [],
    selfWake: null,
    activeTurn: null,
    recentMessageIds: [],
    lastCompletedTurnId: null,
    lastCompletedAt: null,
    nextEligibleWakeAt: null,
    failureCount: 0,
    lastError: null,
  };
}

/** Normalize hand-edited, legacy, or partially migrated state. */
export function normalizePersistentMindState(raw) {
  const defaults = createDefaultPersistentMindState();
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const queuedMessages = [];
  const seenQueued = new Set();
  for (const candidate of Array.isArray(source.queuedMessages) ? source.queuedMessages : []) {
    const message = sanitizeMessage(candidate);
    if (!message || seenQueued.has(message.id)) continue;
    seenQueued.add(message.id);
    queuedMessages.push(message);
    if (queuedMessages.length >= PERSISTENT_MIND_LIMITS.MAX_QUEUED_MESSAGES) break;
  }
  const recentMessageIds = [];
  for (const candidate of Array.isArray(source.recentMessageIds) ? source.recentMessageIds : []) {
    const id = asId(candidate);
    if (!id || recentMessageIds.includes(id)) continue;
    recentMessageIds.push(id);
  }

  const enabled = source.enabled === true;
  const started = enabled && source.started === true;
  let status = PERSISTENT_MIND_STATUSES.includes(source.status)
    ? source.status
    : started ? 'idle' : enabled ? 'idle' : 'disabled';
  if (!enabled) status = 'disabled';
  else if (!started || status === 'disabled') status = 'idle';

  let selfWake = sanitizeSelfWake(source.selfWake);
  let activeTurn = sanitizeActiveTurn(source.activeTurn);
  if (!started && activeTurn) {
    if (activeTurn.wake.kind === 'message') {
      const message = activeTurn.wake.message;
      if (!seenQueued.has(message.id) && !recentMessageIds.includes(message.id)) {
        queuedMessages.unshift(message);
        if (queuedMessages.length > PERSISTENT_MIND_LIMITS.MAX_QUEUED_MESSAGES) queuedMessages.pop();
      }
    } else if (!selfWake) {
      selfWake = activeTurn.wake;
    }
    activeTurn = null;
  }

  return {
    ...defaults,
    schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
    mindId: asMindId(source.mindId) || PERSISTENT_MIND_ID,
    enabled,
    started,
    status,
    pauseReason: asBoundedString(source.pauseReason, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS) || null,
    queuedMessages,
    selfWake,
    activeTurn,
    recentMessageIds: recentMessageIds.slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS),
    lastCompletedTurnId: asId(source.lastCompletedTurnId) || null,
    lastCompletedAt: asIso(source.lastCompletedAt),
    nextEligibleWakeAt: asIso(source.nextEligibleWakeAt),
    failureCount: asCount(source.failureCount),
    lastError: asBoundedString(source.lastError, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS) || null,
  };
}

export function persistentMindBackoffMs(failureCount) {
  const exponent = Math.max(0, Math.min(20, asCount(failureCount) - 1));
  return Math.min(
    PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS,
    PERSISTENT_MIND_LIMITS.BACKOFF_BASE_MS * (2 ** exponent)
  );
}

/** User messages always outrank a due self-wake. */
export function takeNextPersistentMindWake(raw, now = Date.now()) {
  const state = normalizePersistentMindState(raw);
  const gateAt = state.nextEligibleWakeAt ? Date.parse(state.nextEligibleWakeAt) : 0;
  if (Number.isFinite(gateAt) && gateAt > now) return { state, wake: null, dueAt: gateAt };

  if (state.queuedMessages.length > 0) {
    const [message, ...queuedMessages] = state.queuedMessages;
    return { state: { ...state, queuedMessages }, wake: { kind: 'message', message }, dueAt: now };
  }

  if (!state.selfWake) return { state, wake: null, dueAt: null };
  const dueAt = state.selfWake.notBefore ? Date.parse(state.selfWake.notBefore) : now;
  if (Number.isFinite(dueAt) && dueAt > now) return { state, wake: null, dueAt };
  return { state: { ...state, selfWake: null }, wake: state.selfWake, dueAt: now };
}

export function requeuePersistentMindWake(raw, wake) {
  const state = normalizePersistentMindState(raw);
  const sanitized = sanitizeWake(wake);
  if (!sanitized) return state;
  if (sanitized.kind === 'message') {
    const alreadyQueued = state.queuedMessages.some((message) => message.id === sanitized.message.id);
    const alreadyCompleted = state.recentMessageIds.includes(sanitized.message.id);
    return alreadyQueued || alreadyCompleted
      ? state
      : { ...state, queuedMessages: [sanitized.message, ...state.queuedMessages] };
  }
  return { ...state, selfWake: sanitized };
}

export function persistentMindTurnIsStale(raw, now = Date.now(), staleMs = PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS) {
  const active = normalizePersistentMindState(raw).activeTurn;
  if (!active) return false;
  const heartbeatAt = Date.parse(active.heartbeatAt);
  return Number.isFinite(heartbeatAt) && now - heartbeatAt >= staleMs;
}

export function nextPersistentMindWakeAt(raw, now = Date.now()) {
  const state = normalizePersistentMindState(raw);
  if (!state.enabled || !state.started || state.activeTurn || state.status === 'paused') return null;
  const gateAt = state.nextEligibleWakeAt ? Date.parse(state.nextEligibleWakeAt) : now;
  if (state.queuedMessages.length > 0) return Math.max(now, gateAt || now);
  if (!state.selfWake) return null;
  const selfAt = state.selfWake.notBefore ? Date.parse(state.selfWake.notBefore) : now;
  return Math.max(now, gateAt || now, selfAt || now);
}
