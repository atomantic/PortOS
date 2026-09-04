/**
 * Pure persistent-CoS-mind state helpers.
 *
 * The supervisor service owns I/O and timers. This module owns the durable
 * shape and clock-driven decisions so restart recovery can replay the same
 * rules without depending on module-level process state.
 */

import { createHash } from 'crypto';
import { PERSISTENT_MIND_ID } from './persistentMindTrajectory.js';
import { MAX_SCREENSHOT_BYTES } from './uploadLimits.js';
import { sanitizeFilename } from './mimeTypes.js';
import { isSafeFilename } from './pathSafety.js';
import { asPersistentMindThinkingPresetId } from './persistentMindThinkingPresets.js';

export const PERSISTENT_MIND_SCHEMA_VERSION = 6;

export const PERSISTENT_MIND_IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export const PERSISTENT_MIND_IMAGE_MIME_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

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
export const PERSISTENT_MIND_SELF_WAKE_SCHEDULE_KINDS = ['quiet', 'requested'];

export const PERSISTENT_MIND_LIMITS = Object.freeze({
  MAX_QUEUED_MESSAGES: 100,
  MAX_RECENT_MESSAGE_IDS: 200,
  MAX_MESSAGE_IMAGES: 8,
  MAX_MESSAGE_CHARS: 8_000,
  MAX_REASON_CHARS: 500,
  MAX_CALL_HISTORY: 20,
  MAX_CALL_REASON_CHARS: 200,
  MAX_CALL_SOURCE_CHARS: 60,
  MAX_ATTACHMENT_ID_CHARS: 128,
  MAX_ATTACHMENT_FILENAME_CHARS: 255,
  MAX_ATTACHMENT_NAME_CHARS: 200,
  MAX_PENDING_ATTACHMENTS: 800,
  MAX_ATTACHMENT_CLEANUP_PER_PASS: 50,
  MAX_ATTACHMENT_BYTES: MAX_SCREENSHOT_BYTES,
  PENDING_ATTACHMENT_TTL_MS: 24 * 60 * 60 * 1000,
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

const asFingerprint = (value) => (
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
);

const asAttachmentId = (value) => {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id.length <= PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_ID_CHARS
    && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
};

const asAttachmentFilename = (value) => {
  if (typeof value !== 'string') return null;
  const filename = value.trim();
  return filename.length <= PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_FILENAME_CHARS
    && isSafeFilename(filename, PERSISTENT_MIND_IMAGE_EXTENSIONS)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|gif|webp)$/i.test(filename)
    ? filename
    : null;
};

const asAttachmentMimeType = (value) => (
  typeof value === 'string' && Object.values(PERSISTENT_MIND_IMAGE_MIME_TYPES).includes(value)
    ? value
    : null
);

const asAttachmentSize = (value) => (
  Number.isSafeInteger(value) && value > 0 && value <= PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_BYTES
    ? value
    : null
);

const attachmentPath = (filename) => {
  const safeFilename = asAttachmentFilename(filename);
  return safeFilename ? `/api/screenshots/${encodeURIComponent(safeFilename)}` : null;
};

/** True when a value is a safe server-issued Mind attachment id. */
export function isPersistentMindAttachmentId(value) {
  return asAttachmentId(value) !== null;
}

/** Convert a stored screenshot filename into the only client-visible reference. */
export function persistentMindAttachmentPath(filename) {
  return attachmentPath(filename);
}

/** Normalize the bounded, machine-local pending attachment record. */
export function normalizePersistentMindAttachment(value) {
  const attachmentId = asAttachmentId(value?.attachmentId);
  const filename = asAttachmentFilename(value?.filename);
  const originalName = typeof value?.originalName === 'string'
    ? sanitizeFilename(value.originalName).slice(0, PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_NAME_CHARS) || filename
    : filename;
  const mimeType = asAttachmentMimeType(value?.mimeType);
  const size = asAttachmentSize(value?.size);
  const uploadedAt = asIso(value?.uploadedAt || value?.createdAt);
  const claimedBy = value?.claimedBy == null ? null : asId(value.claimedBy);
  if (!attachmentId || !filename || !mimeType || size === null || !uploadedAt) return null;
  if (value?.claimedBy != null && !claimedBy) return null;
  const expiresAt = claimedBy
    ? null
    : asIso(value?.expiresAt)
      || new Date(Date.parse(uploadedAt) + PERSISTENT_MIND_LIMITS.PENDING_ATTACHMENT_TTL_MS).toISOString();
  return {
    attachmentId,
    filename,
    originalName,
    mimeType,
    size,
    uploadedAt,
    expiresAt,
    claimedBy,
    claimedAt: asIso(value?.claimedAt),
    claimIndex: Number.isSafeInteger(value?.claimIndex)
      && value.claimIndex >= 0
      && value.claimIndex < PERSISTENT_MIND_LIMITS.MAX_MESSAGE_IMAGES
      ? value.claimIndex
      : null,
  };
}

/** Build the durable image reference stored on a queued or active message. */
export function normalizePersistentMindMessageImage(value) {
  const attachment = normalizePersistentMindAttachment(value);
  if (!attachment) return null;
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    path: attachmentPath(attachment.filename),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedAt: attachment.uploadedAt,
  };
}

/**
 * Hash the bounded message content used to validate retries after completion.
 *
 * A temporary thinking-session selection is part of the content: retrying the
 * same text on a different (possibly account-billed) model is a different
 * request, not the same one. The key is omitted entirely when no override was
 * chosen so fingerprints recorded before temporary sessions existed still match
 * byte-for-byte, and an in-flight idempotent retry survives the upgrade.
 */
export function persistentMindMessageFingerprint(value) {
  const images = Array.isArray(value?.images)
    ? value.images.map((image) => (typeof image === 'string' ? image : image?.attachmentId))
      .map(asAttachmentId)
      .filter(Boolean)
    : [];
  const thinkingPresetId = asPersistentMindThinkingPresetId(value?.thinkingPresetId);
  return createHash('sha256')
    .update(JSON.stringify({
      text: asBoundedString(value?.text, PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS),
      images,
      ...(thinkingPresetId ? { thinkingPresetId } : {}),
    }))
    .digest('hex');
}

/** Build the safe upload response without exposing claim bookkeeping. */
export function publicPersistentMindAttachment(value) {
  const attachment = normalizePersistentMindAttachment(value);
  if (!attachment) return null;
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    path: attachmentPath(attachment.filename),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedAt: attachment.uploadedAt,
    expiresAt: attachment.expiresAt,
  };
}

const sanitizeMessage = (value) => {
  const id = asId(value?.id);
  const text = asBoundedString(value?.text, PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS);
  const images = [];
  const seenImageIds = new Set();
  for (const candidate of Array.isArray(value?.images) ? value.images : []) {
    const image = normalizePersistentMindMessageImage(candidate);
    if (!image || seenImageIds.has(image.attachmentId)) continue;
    seenImageIds.add(image.attachmentId);
    images.push(image);
    if (images.length >= PERSISTENT_MIND_LIMITS.MAX_MESSAGE_IMAGES) break;
  }
  if (!id || (!text && images.length === 0)) return null;
  const thinkingPresetId = asPersistentMindThinkingPresetId(value?.thinkingPresetId);
  return {
    id,
    text,
    ...(images.length > 0 ? { images } : {}),
    // Absent on every ordinary message. Kept on the durable queued/active record
    // so a requeue or a restart replays the route the user actually chose,
    // instead of quietly answering on the home profile.
    ...(thinkingPresetId ? { thinkingPresetId } : {}),
    createdAt: asIso(value?.createdAt) || new Date(0).toISOString(),
  };
};

// One placed outbound call. Only the timestamp, the mind's own reason, and
// which subsystem asked are kept — never the handle that was dialed, which is
// the user's phone number or email and has no business in a durable ledger.
const sanitizeCallRecord = (value) => {
  const at = asIso(value?.at);
  if (!at) return null;
  return {
    at,
    reason: asBoundedString(value?.reason, PERSISTENT_MIND_LIMITS.MAX_CALL_REASON_CHARS),
    source: asBoundedString(value?.source, PERSISTENT_MIND_LIMITS.MAX_CALL_SOURCE_CHARS) || 'mind',
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
    scheduleKind: PERSISTENT_MIND_SELF_WAKE_SCHEDULE_KINDS.includes(value?.scheduleKind)
      ? value.scheduleKind
      : 'requested',
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
    pendingAttachments: [],
    selfWake: null,
    activeTurn: null,
    recentMessageIds: [],
    recentMessageFingerprints: [],
    callHistory: [],
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
  const recentMessageFingerprints = [];
  const seenFingerprintIds = new Set();
  for (const candidate of Array.isArray(source.recentMessageFingerprints) ? source.recentMessageFingerprints : []) {
    const id = asId(candidate?.id);
    const fingerprint = asFingerprint(candidate?.fingerprint);
    if (!id || !fingerprint || seenFingerprintIds.has(id)) continue;
    seenFingerprintIds.add(id);
    recentMessageFingerprints.push({ id, fingerprint });
  }
  const callHistory = [];
  for (const candidate of Array.isArray(source.callHistory) ? source.callHistory : []) {
    const record = sanitizeCallRecord(candidate);
    if (record) callHistory.push(record);
  }
  const pendingAttachments = [];
  const seenAttachmentIds = new Set();
  for (const candidate of Array.isArray(source.pendingAttachments) ? source.pendingAttachments : []) {
    const attachment = normalizePersistentMindAttachment(candidate);
    if (!attachment || seenAttachmentIds.has(attachment.attachmentId)) continue;
    seenAttachmentIds.add(attachment.attachmentId);
    pendingAttachments.push(attachment);
    if (pendingAttachments.length >= PERSISTENT_MIND_LIMITS.MAX_PENDING_ATTACHMENTS) break;
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
      if (!recentMessageIds.includes(message.id)) {
        if (message.thinkingPresetId) {
          // A temporary session may already have spent a billed call before the
          // process stopped, and nothing on disk can say whether it did.
          // Recovering it as queued work would silently repeat that spend on the
          // next boot, so it is recorded as consumed and left for the user to
          // resend deliberately.
          const queuedIndex = queuedMessages.findIndex((queued) => queued.id === message.id);
          if (queuedIndex >= 0) queuedMessages.splice(queuedIndex, 1);
          recentMessageIds.push(message.id);
          recentMessageFingerprints.push({
            id: message.id,
            fingerprint: persistentMindMessageFingerprint(message),
          });
        } else if (!seenQueued.has(message.id)) {
          queuedMessages.unshift(message);
          if (queuedMessages.length > PERSISTENT_MIND_LIMITS.MAX_QUEUED_MESSAGES) queuedMessages.pop();
        }
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
    pendingAttachments,
    selfWake,
    activeTurn,
    recentMessageIds: recentMessageIds.slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS),
    recentMessageFingerprints: recentMessageFingerprints.slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS),
    callHistory: callHistory.slice(-PERSISTENT_MIND_LIMITS.MAX_CALL_HISTORY),
    lastCompletedTurnId: asId(source.lastCompletedTurnId) || null,
    lastCompletedAt: asIso(source.lastCompletedAt),
    nextEligibleWakeAt: asIso(source.nextEligibleWakeAt),
    failureCount: asCount(source.failureCount),
    lastError: asBoundedString(source.lastError, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS) || null,
  };
}

/**
 * May the mind ring the user's phone right now?
 *
 * Two independent caps, both read from durable state so a restart, a crash, or
 * a supervisor rewire cannot hand back a fresh allowance:
 *
 * - a minimum gap, so a burst of urgent-feeling wakes cannot dial repeatedly;
 * - a rolling-window ceiling, so a persistently agitated mind still stops.
 *
 * A timestamp in the future (a clock rollback, a hand-edited state file) reads
 * as "too soon" rather than as "no recent calls" — the fail-closed reading,
 * which self-heals once the clock passes it.
 */
export function persistentMindCallRateVerdict(raw, now = Date.now(), limits = {}) {
  const {
    maxPerRollingDay = 3,
    rollingWindowMs = 24 * 60 * 60 * 1000,
    minGapMs = 30 * 60 * 1000,
  } = limits;
  const placedAt = normalizePersistentMindState(raw).callHistory
    .map((entry) => Date.parse(entry.at))
    .filter((value) => Number.isFinite(value));
  const withinWindow = placedAt.filter((at) => now - at < rollingWindowMs);
  const mostRecent = placedAt.length > 0 ? Math.max(...placedAt) : null;
  if (mostRecent !== null && now - mostRecent < minGapMs) {
    return { ok: false, reason: 'too-soon', retryAt: mostRecent + minGapMs, callsInWindow: withinWindow.length };
  }
  if (withinWindow.length >= maxPerRollingDay) {
    return {
      ok: false,
      reason: 'rate-capped',
      retryAt: Math.min(...withinWindow) + rollingWindowMs,
      callsInWindow: withinWindow.length,
    };
  }
  return { ok: true, reason: null, retryAt: null, callsInWindow: withinWindow.length };
}

/** Append one placed call to the durable, bounded call ledger. */
export function recordPersistentMindCall(raw, { at = new Date().toISOString(), reason = '', source = 'mind' } = {}) {
  const state = normalizePersistentMindState(raw);
  return normalizePersistentMindState({
    ...state,
    callHistory: [...state.callHistory, { at, reason, source }]
      .slice(-PERSISTENT_MIND_LIMITS.MAX_CALL_HISTORY),
  });
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

/**
 * Does abandoning this wake risk repeating work the user may already be billed for?
 *
 * Only an explicitly selected temporary thinking session does: it is the one
 * route the user opted into per-message, and it may sit on an account-backed
 * provider. The home profile is the mind's ordinary heartbeat, so a self-wake
 * or an ordinary message still requeues and retries as before.
 */
export function persistentMindWakeConsumesAttempt(wake) {
  return wake?.kind === 'message' && Boolean(wake.message?.thinkingPresetId);
}

/**
 * Retire a wake WITHOUT requeueing it, recording its id and fingerprint so an
 * idempotent client retry reads as a completed duplicate rather than as new
 * work. Resuming a temporary session is then an explicit user decision (a fresh
 * message id), never an automatic replay.
 */
export function holdPersistentMindWake(raw, wake) {
  const state = normalizePersistentMindState(raw);
  const sanitized = sanitizeWake(wake);
  if (sanitized?.kind !== 'message') return state;
  const { id } = sanitized.message;
  return {
    ...state,
    queuedMessages: state.queuedMessages.filter((message) => message.id !== id),
    recentMessageIds: [...state.recentMessageIds.filter((entry) => entry !== id), id]
      .slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS),
    recentMessageFingerprints: [
      ...state.recentMessageFingerprints.filter((entry) => entry.id !== id),
      { id, fingerprint: persistentMindMessageFingerprint(sanitized.message) },
    ].slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS),
  };
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

/**
 * Report whether a source transition can safely cross a reader that predates
 * image-bearing Persistent Mind messages. Counts only durable queued/active
 * work; completed historical assets do not make rollback unsafe.
 */
export function persistentMindImageWorkGuard(raw) {
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasValidImages = (value) => value.images === undefined || Array.isArray(value.images);
  const source = raw == null ? {} : raw;
  const queuedMessages = source?.queuedMessages;
  const activeTurn = source?.activeTurn;
  const activeMessage = activeTurn?.wake?.kind === 'message' ? activeTurn.wake.message : null;
  const trusted = isRecord(source)
    && (queuedMessages === undefined || (
      Array.isArray(queuedMessages)
      && queuedMessages.every((message) => isRecord(message) && hasValidImages(message))
    ))
    && (activeTurn == null || isRecord(activeTurn))
    && (activeMessage == null || (isRecord(activeMessage) && hasValidImages(activeMessage)));
  if (!trusted) {
    return { safe: false, trusted: false, queuedImageMessages: 0, activeImageMessage: false };
  }
  const queuedImageMessages = (Array.isArray(queuedMessages) ? queuedMessages : [])
    .filter((message) => Array.isArray(message?.images) && message.images.length > 0)
    .length;
  const activeImageMessage = Boolean(
    activeMessage && Array.isArray(activeMessage.images) && activeMessage.images.length > 0,
  );
  return {
    safe: queuedImageMessages === 0 && !activeImageMessage,
    trusted: true,
    queuedImageMessages,
    activeImageMessage,
  };
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
