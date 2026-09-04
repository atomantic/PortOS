/**
 * Persistent CoS mind supervisor.
 *
 * This service owns liveness, durable wake admission, restart recovery, and
 * one-turn-at-a-time execution. It deliberately does not own provider/model
 * selection or the mind prompt: the model-profile slice registers an exact
 * provider adapter, and the trajectory slice supplies bounded context. Until
 * that adapter is registered, an explicitly started mind degrades visibly and
 * makes zero provider calls.
 */

import { randomUUID } from 'crypto';
import { mkdir, readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getDomainMode } from '../lib/domainAutonomy.js';
import {
  PERSISTENT_MIND_LIMITS,
  PERSISTENT_MIND_IMAGE_EXTENSIONS,
  createDefaultPersistentMindState,
  holdPersistentMindWake,
  isPersistentMindAttachmentId,
  normalizePersistentMindAttachment,
  normalizePersistentMindMessageImage,
  nextPersistentMindWakeAt,
  normalizePersistentMindState,
  persistentMindMessageFingerprint,
  persistentMindBackoffMs,
  persistentMindTurnIsStale,
  persistentMindWakeConsumesAttempt,
  publicPersistentMindAttachment,
  requeuePersistentMindWake,
  takeNextPersistentMindWake,
} from '../lib/persistentMind.js';
import {
  detectImageFormat,
  PATHS,
  resolveScreenshot,
  sanitizeFilename,
  saveImageUpload,
  unlinkGuarded,
  writeFileGuarded,
} from '../lib/fileUtils.js';
import { isDaemonRunning, loadState, saveState, withStateLock } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { schedule, cancel } from './eventScheduler.js';
import { getDomainBudgetStatus, recordDomainUsage } from './domainUsage.js';
import { acquireLocalEndpointProviderSlot } from './cosLocalEndpointSlots.js';
import { acquireCosActionReservation, acquireCosGlobalSlot } from './cosAdmissionReservations.js';
import { appendMindEvent } from './agentRunEventLog.js';
import { preparePersistentMindContext } from './persistentMindContext.js';
import { resolvePersistentMindProfile, resolvePersistentMindThinkingSession } from './persistentMindProfile.js';
import { isUpdateInProgress } from './updateChecker.js';
import { publicPersistentMindState } from '../lib/persistentMindPublic.js';
import { normalizePersistentMindProfile, persistentMindWakeIntervalMs } from '../lib/persistentMindProfile.js';
import { getProviderById } from './providers.js';
import {
  findPersistentMindThinkingPreset,
  PERSISTENT_MIND_THINKING_PRESET_LIMITS,
} from '../lib/persistentMindThinkingPresets.js';
import {
  imageCapabilityAllowsAttempt,
  resolvePersistentMindImageCapability,
} from './persistentMindImageCapability.js';

export const PERSISTENT_MIND_WAKE_EVENT_ID = 'cos-persistent-mind-wake';
export const PERSISTENT_MIND_WATCHDOG_EVENT_ID = 'cos-persistent-mind-watchdog';
export const PERSISTENT_MIND_WATCHDOG_INTERVAL_MS = 30_000;

let turnAdapter = null;
let activeRun = null;
let activeAbortController = null;
let runtimeGeneration = 0;
let supervisorStopping = false;

const nowIso = () => new Date().toISOString();
const errorMessage = (error) => String(error?.message || error || 'Persistent mind turn failed')
  .slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS);
const PENDING_ATTACHMENT_MARKER_PREFIX = '.mind-pending-';
const PENDING_ATTACHMENT_MARKER_PATTERN = /^\.mind-pending-([A-Za-z0-9_-]{1,128})$/;

async function mutateMindState(mutator) {
  return withStateLock(async () => {
    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    const result = await mutator(mind, root);
    root.persistentMind = normalizePersistentMindState(result?.mind || mind);
    await saveState(root);
    return { state: root.persistentMind, value: result?.value };
  });
}

const attachmentFailure = (error, { code = 'INVALID_ATTACHMENT', status = 400 } = {}) => ({
  success: false,
  error,
  code,
  status,
});

const normalizeRequestedAttachmentIds = (images) => {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.length > PERSISTENT_MIND_LIMITS.MAX_MESSAGE_IMAGES) return null;
  const ids = images.map((image) => {
    const value = typeof image === 'string' ? image : image?.attachmentId;
    return typeof value === 'string' ? value.trim() : null;
  });
  if (ids.some((id) => !id || !isPersistentMindAttachmentId(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
};

const normalizeMessageText = (text) => (
  typeof text === 'string' ? text.trim().slice(0, PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS) : ''
);

const imageIdsForMessage = (message) => (
  Array.isArray(message?.images)
    ? message.images.map((image) => image?.attachmentId).filter(isPersistentMindAttachmentId)
    : []
);

const sameAttachmentIds = (left, right) => (
  left.length === right.length && left.every((id, index) => id === right[index])
);

const findMessageById = (mind, messageId) => {
  const queued = mind.queuedMessages.find((message) => message.id === messageId);
  if (queued) return queued;
  return mind.activeTurn?.wake.kind === 'message' && mind.activeTurn.wake.message.id === messageId
    ? mind.activeTurn.wake.message
    : null;
};

const claimedAttachmentsForMessage = (mind, messageId) => mind.pendingAttachments
  .map((attachment, index) => ({ attachment, index }))
  .filter(({ attachment }) => attachment.claimedBy === messageId)
  .sort((left, right) => (
    (left.attachment.claimIndex ?? Number.MAX_SAFE_INTEGER)
      - (right.attachment.claimIndex ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index
  ))
  .map(({ attachment }) => attachment);

const messageFromAttachments = ({ id, text, createdAt, attachments, thinkingPresetId }) => ({
  id,
  text,
  ...(attachments.length > 0 ? {
    images: attachments.map(normalizePersistentMindMessageImage).filter(Boolean),
  } : {}),
  ...(thinkingPresetId ? { thinkingPresetId } : {}),
  createdAt,
});

const pendingAttachmentMarkerPath = (attachmentId) => join(
  PATHS.screenshots,
  `${PENDING_ATTACHMENT_MARKER_PREFIX}${attachmentId}`,
);

const removePendingAttachmentMarker = async (attachmentId) => unlinkGuarded(pendingAttachmentMarkerPath(attachmentId)).then(
  () => true,
  (error) => {
    if (error?.code === 'ENOENT') return true;
    console.error(`❌ Failed to remove Persistent Mind upload marker ${attachmentId}: ${error.message}`);
    return false;
  },
);

const removeStoredFilename = async (filename) => {
  const filePath = resolveScreenshot(filename);
  if (!filePath) return true;
  return unlinkGuarded(filePath).then(
    () => true,
    (error) => {
      if (error?.code === 'ENOENT') return true;
      console.error(`❌ Failed to remove Persistent Mind attachment file: ${error.message}`);
      return false;
    },
  );
};

const screenshotEntries = async () => readdir(PATHS.screenshots).then(
  (entries) => entries.filter((entry) => typeof entry === 'string'),
  (error) => {
    if (error?.code === 'ENOENT') return [];
    console.error(`❌ Failed to inspect Persistent Mind upload markers: ${error.message}`);
    return null;
  },
);

const removePendingAttachmentFiles = async (attachmentId, entries) => {
  const prefix = `mind-${attachmentId}-`;
  const candidates = entries.filter((entry) => (
    entry.startsWith(prefix)
    && PERSISTENT_MIND_IMAGE_EXTENSIONS.some((extension) => entry.toLowerCase().endsWith(extension))
  ));
  let removed = true;
  for (const filename of candidates) {
    if (!await removeStoredFilename(filename)) removed = false;
  }
  return removed;
};

/** Reap marker-backed files left before their pending state could be indexed. */
const cleanupUnindexedPendingAttachments = async ({ knownAttachments, now, limit }) => {
  const entries = await screenshotEntries();
  if (!entries) return { examined: 0, removed: 0 };
  const recordsById = new Map(knownAttachments.map((attachment) => [attachment.attachmentId, attachment]));
  const markers = entries
    .map((entry) => ({ entry, match: PENDING_ATTACHMENT_MARKER_PATTERN.exec(entry) }))
    .filter(({ match }) => Boolean(match))
    .slice(0, limit);
  let removed = 0;
  for (const { entry, match } of markers) {
    const attachmentId = match[1];
    const known = recordsById.get(attachmentId);
    if (known) {
      // A claimed asset is durable even if its metadata is later pruned. The
      // marker is only a pending-upload sentinel, so removing it is safe.
      if (known.claimedBy && await removePendingAttachmentMarker(attachmentId)) removed += 1;
      continue;
    }
    const markerAge = await stat(join(PATHS.screenshots, entry)).then(
      (value) => value.mtimeMs,
      () => null,
    );
    if (!Number.isFinite(markerAge) || markerAge > now - PERSISTENT_MIND_LIMITS.PENDING_ATTACHMENT_TTL_MS) continue;
    if (await removePendingAttachmentFiles(attachmentId, entries)
        && await removePendingAttachmentMarker(attachmentId)) {
      removed += 1;
    }
  }
  return { examined: markers.length, removed };
};

const verifyStoredAttachment = async (attachment) => {
  const filePath = resolveScreenshot(attachment.filename);
  if (!filePath) return false;
  const bytes = await readFile(filePath).then((value) => value, () => null);
  const detected = detectImageFormat(bytes);
  return Boolean(
    detected
    && detected.mime === attachment.mimeType
    && bytes.length === attachment.size,
  );
};

const removeStoredAttachmentFile = async (attachment) => {
  return removeStoredFilename(attachment.filename);
};

const removeUploadAfterStateFailure = async (filePath, attachmentId) => unlinkGuarded(filePath).then(
  async () => removePendingAttachmentMarker(attachmentId),
  (error) => {
    if (error?.code !== 'ENOENT') {
      console.error(`❌ Failed to clean up Persistent Mind upload ${attachmentId}: ${error.message}`);
    }
    return removePendingAttachmentMarker(attachmentId).then(() => false);
  },
);

// A validation/write rejection happens before `saveImageUpload` can return its
// stored path. Remove every file with this upload's generated prefix as well as
// the marker, so a partial write cannot survive without the marker-based crash
// recovery path.
const removeRejectedUpload = async (attachmentId) => {
  const entries = await screenshotEntries();
  if (entries) await removePendingAttachmentFiles(attachmentId, entries);
  await removePendingAttachmentMarker(attachmentId);
};

const resolveMessageAttachments = async (mind, attachmentIds, messageId) => {
  const byId = new Map(mind.pendingAttachments.map((attachment) => [attachment.attachmentId, attachment]));
  const attachments = [];
  for (const attachmentId of attachmentIds) {
    const attachment = byId.get(attachmentId);
    if (!attachment) {
      return { error: attachmentFailure('Persistent mind attachment was not found', { code: 'ATTACHMENT_NOT_FOUND' }) };
    }
    if (attachment.claimedBy && attachment.claimedBy !== messageId) {
      return { error: attachmentFailure('Persistent mind attachment is already claimed by another message', { code: 'ATTACHMENT_ALREADY_CLAIMED', status: 409 }) };
    }
    const expiresAt = attachment.expiresAt ? Date.parse(attachment.expiresAt) : null;
    if (!attachment.claimedBy && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return { error: attachmentFailure('Persistent mind attachment has expired', { code: 'ATTACHMENT_EXPIRED' }) };
    }
    if (!await verifyStoredAttachment(attachment)) {
      return { error: attachmentFailure('Persistent mind attachment is missing or invalid', { code: 'INVALID_ATTACHMENT' }) };
    }
    attachments.push(attachment);
  }
  return { attachments };
};

/** Remove expired or invalid unclaimed files in one bounded maintenance pass. */
export async function cleanupPersistentMindAttachments({ now = Date.now() } = {}) {
  const result = await mutateMindState(async (mind) => {
    let examined = 0;
    let removed = 0;
    const pendingAttachments = [];
    for (const attachment of mind.pendingAttachments) {
      if (attachment.claimedBy) {
        await removePendingAttachmentMarker(attachment.attachmentId);
        pendingAttachments.push(attachment);
        continue;
      }
      if (examined >= PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_CLEANUP_PER_PASS) {
        pendingAttachments.push(attachment);
        continue;
      }
      examined += 1;
      const expiresAt = attachment.expiresAt ? Date.parse(attachment.expiresAt) : null;
      const expired = !attachment.claimedBy && Number.isFinite(expiresAt) && expiresAt <= now;
      const valid = expired ? false : await verifyStoredAttachment(attachment);
      if (!expired && valid) {
        pendingAttachments.push(attachment);
        continue;
      }
      if (await removeStoredAttachmentFile(attachment)) removed += 1;
      else pendingAttachments.push(attachment);
    }
    const orphaned = await cleanupUnindexedPendingAttachments({
      knownAttachments: pendingAttachments,
      now,
      limit: Math.max(0, PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_CLEANUP_PER_PASS - examined),
    });
    removed += orphaned.removed;
    return {
      mind: removed > 0 ? { ...mind, pendingAttachments } : mind,
      value: { success: true, removed, examined: examined + orphaned.examined },
    };
  });
  return result.value;
}

/** Store one validated image and register its server-owned pending record. */
export async function createPersistentMindAttachment({ filename, data } = {}) {
  if (typeof filename !== 'string' || !filename.trim() || typeof data !== 'string' || !data.trim()) {
    return attachmentFailure('Image filename and base64 data are required', { code: 'VALIDATION_ERROR' });
  }
  if (isUpdateInProgress()) {
    return attachmentFailure('Persistent Mind image admission is paused during a PortOS update', {
      code: 'UPDATE_IN_PROGRESS',
      status: 409,
    });
  }
  await cleanupPersistentMindAttachments();
  const attachmentId = randomUUID();
  const originalName = sanitizeFilename(filename).slice(0, PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_NAME_CHARS) || `image-${attachmentId}`;
  // Create the marker BEFORE the image write. If the process dies after the
  // write but before the state record is saved, boot/activity cleanup can find
  // and reap the otherwise-unindexed file without ever scanning durable assets.
  await mkdir(PATHS.screenshots, { recursive: true });
  await writeFileGuarded(pendingAttachmentMarkerPath(attachmentId), '', { flag: 'wx' });
  const saved = await saveImageUpload(PATHS.screenshots, {
    filename: `mind-${attachmentId}-${originalName}`,
    data,
  }, { maxBytes: PERSISTENT_MIND_LIMITS.MAX_ATTACHMENT_BYTES }).then(
    (value) => value,
    async (error) => {
      await removeRejectedUpload(attachmentId);
      throw error;
    },
  );
  const uploadedAt = nowIso();
  const attachment = normalizePersistentMindAttachment({
    attachmentId,
    filename: saved.filename,
    originalName,
    mimeType: saved.mime,
    size: saved.size,
    uploadedAt,
    expiresAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.PENDING_ATTACHMENT_TTL_MS).toISOString(),
  });
  if (!attachment) {
    await removeUploadAfterStateFailure(saved.filePath, attachmentId);
    return attachmentFailure('Stored image metadata was invalid', { code: 'INVALID_ATTACHMENT' });
  }
  const result = await mutateMindState(async (mind) => {
    if (isUpdateInProgress()) {
      return {
        mind,
        value: attachmentFailure('Persistent Mind image admission is paused during a PortOS update', {
          code: 'UPDATE_IN_PROGRESS',
          status: 409,
        }),
      };
    }
    const retainedMessageIds = new Set([
      ...mind.recentMessageIds,
      ...mind.queuedMessages.map((message) => message.id),
      ...(mind.activeTurn?.wake.kind === 'message' ? [mind.activeTurn.wake.message.id] : []),
    ]);
    // Old claimed records are metadata only once their message leaves the
    // idempotency window. Keep their files and message references durable, but
    // do not let the pending-record index grow without bound. If removing the
    // claim marker fails, retain the metadata: without it the marker-based
    // orphan sweep could mistake the durable image for an unindexed upload.
    const pendingAttachments = [];
    for (const item of mind.pendingAttachments) {
      if (!item.claimedBy || retainedMessageIds.has(item.claimedBy)) {
        pendingAttachments.push(item);
      } else if (!await removePendingAttachmentMarker(item.attachmentId)) {
        pendingAttachments.push(item);
      }
    }
    if (pendingAttachments.length >= PERSISTENT_MIND_LIMITS.MAX_PENDING_ATTACHMENTS) {
      return {
        mind,
        value: attachmentFailure('Persistent mind has too many pending image uploads', {
          code: 'ATTACHMENT_QUEUE_FULL',
          status: 409,
        }),
      };
    }
    return {
      mind: { ...mind, pendingAttachments: [...pendingAttachments, attachment] },
      value: { success: true, attachment: publicPersistentMindAttachment(attachment) },
    };
  }).then(
    (value) => value,
    async (error) => {
      await removeUploadAfterStateFailure(saved.filePath, attachmentId);
      throw error;
    },
  );
  if (!result.value.success) {
    await removeUploadAfterStateFailure(saved.filePath, attachmentId);
  } else {
    await removePendingAttachmentMarker(attachmentId);
  }
  return result.value;
}

/** Delete an unclaimed pending image and its machine-local bytes. */
export async function deletePersistentMindAttachment(attachmentId) {
  if (!isPersistentMindAttachmentId(attachmentId)) {
    return attachmentFailure('Invalid persistent mind attachment id', { code: 'VALIDATION_ERROR' });
  }
  const result = await mutateMindState(async (mind) => {
    const attachment = mind.pendingAttachments.find((item) => item.attachmentId === attachmentId);
    if (!attachment) return { mind, value: attachmentFailure('Persistent mind attachment was not found', { code: 'ATTACHMENT_NOT_FOUND', status: 404 }) };
    if (attachment.claimedBy) {
      return { mind, value: attachmentFailure('Claimed persistent mind attachments cannot be removed', { code: 'ATTACHMENT_ALREADY_CLAIMED', status: 409 }) };
    }
    if (!await removeStoredAttachmentFile(attachment)) {
      return { mind, value: attachmentFailure('Persistent mind attachment could not be removed', { code: 'ATTACHMENT_DELETE_FAILED', status: 500 }) };
    }
    await removePendingAttachmentMarker(attachmentId);
    return {
      mind: { ...mind, pendingAttachments: mind.pendingAttachments.filter((item) => item.attachmentId !== attachmentId) },
      value: { success: true, attachmentId },
    };
  });
  return result.value;
}

function emitMindStatus(state) {
  cosEvents.emit('persistent-mind:status', publicPersistentMindState(state));
}

function armWatchdog() {
  if (supervisorStopping || !isDaemonRunning()) return;
  schedule({
    id: PERSISTENT_MIND_WATCHDOG_EVENT_ID,
    type: 'interval',
    intervalMs: PERSISTENT_MIND_WATCHDOG_INTERVAL_MS,
    handler: () => checkPersistentMindWatchdog(),
    metadata: { description: 'Persistent CoS mind stale-turn watchdog' },
  });
}

async function scheduleNextWake() {
  const root = await loadState();
  const state = normalizePersistentMindState(root.persistentMind);
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  if (supervisorStopping || !isDaemonRunning() || root.paused || getDomainMode(root.config, 'cos') !== 'execute') return;
  const dueAt = nextPersistentMindWakeAt(state);
  if (dueAt == null || activeRun) return;
  schedule({
    id: PERSISTENT_MIND_WAKE_EVENT_ID,
    type: 'once',
    delayMs: Math.max(1, dueAt - Date.now()),
    handler: async () => {
      await drainPersistentMind({ rearm: false });
      // eventScheduler removes a one-shot's timer handle after its handler
      // resolves. Replacing the same id inside the handler would make the new
      // timer live but uncancellable, so defer the replacement one event-loop
      // turn until that cleanup is complete.
      setImmediate(() => {
        scheduleNextWake().catch((error) => {
          console.error(`❌ Failed to re-arm persistent mind wake: ${error.message}`);
        });
      });
    },
    metadata: { description: 'Persistent CoS mind next eligible wake' },
  });
}

function initialSelfWake(reason) {
  const createdAt = nowIso();
  return {
    id: `wake-${randomUUID()}`,
    kind: 'self',
    scheduleKind: 'requested',
    reason,
    sourceTurnId: reason,
    createdAt,
    notBefore: createdAt,
  };
}

const QUIET_SELF_WAKE_REASON = 'maximum quiet period elapsed';

function quietSelfWake(turnId, quietPeriodMs = PERSISTENT_MIND_LIMITS.MAX_QUIET_MS, baseAt = Date.now()) {
  return {
    id: `wake-${randomUUID()}`,
    kind: 'self',
    scheduleKind: 'quiet',
    reason: QUIET_SELF_WAKE_REASON,
    sourceTurnId: turnId,
    createdAt: nowIso(),
    notBefore: new Date(baseAt + quietPeriodMs).toISOString(),
  };
}

/**
 * Hand a claimed wake back to durable state when its turn is abandoned.
 *
 * An interrupted temporary thinking session is an uncertain consumed attempt:
 * the abort races whatever the provider already started, and no durable record
 * can say whether that call was billed. Every such wake is retired rather than
 * requeued, so resuming it stays an explicit user decision; an ordinary message
 * or self-wake keeps its free automatic retry.
 */
const releaseClaimedWake = (mind, wake) => (
  persistentMindWakeConsumesAttempt(wake)
    ? holdPersistentMindWake(mind, wake)
    : requeuePersistentMindWake(mind, wake)
);

async function interruptActiveTurn(reason, status, { retry = false, expectedTurnId = null } = {}) {
  const result = await mutateMindState((mind) => {
    if (expectedTurnId && mind.activeTurn?.id !== expectedTurnId) {
      return { mind, value: false };
    }
    const interrupted = Boolean(mind.activeTurn);
    let next = mind;
    if (mind.activeTurn) next = releaseClaimedWake(next, mind.activeTurn.wake);
    const failureCount = retry ? next.failureCount + 1 : next.failureCount;
    return {
      mind: {
        ...next,
        activeTurn: null,
        status,
        pauseReason: reason,
        failureCount,
        lastError: reason,
        nextEligibleWakeAt: retry
          ? new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString()
          : null,
      },
      value: { interrupted, turnId: mind.activeTurn?.id || null, mindId: mind.mindId },
    };
  });
  if (result.value?.interrupted) {
    runtimeGeneration += 1;
    activeAbortController?.abort(reason);
    await appendMindEvent({
      kind: status === 'paused' ? 'mind.paused' : 'mind.failed',
      mindId: result.value.mindId,
      turnId: result.value.turnId,
      eventId: `mind-${status}:${result.value.turnId}`,
      data: { status, error: reason },
    });
  }
  emitMindStatus(result.state);
  return { state: result.state, interrupted: result.value?.interrupted === true };
}

/**
 * Return a claimed turn to the queue with a visible reason.
 *
 * `consumedAttempt` says the provider span had already opened, so a temporary
 * thinking session must not be replayed automatically. Every refusal decided
 * before that point — an unresolvable route, an unavailable adapter, a busy
 * local endpoint — spent nothing and still requeues normally.
 */
async function parkActiveTurn(turnId, reason, status = 'waiting', { retryAt = null, consumedAttempt = false } = {}) {
  const result = await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind, value: false };
    // A refusal decided before the provider span opened spent nothing, so it
    // requeues even for a temporary session.
    const held = consumedAttempt && persistentMindWakeConsumesAttempt(mind.activeTurn.wake);
    const next = held
      ? holdPersistentMindWake(mind, mind.activeTurn.wake)
      : requeuePersistentMindWake(mind, mind.activeTurn.wake);
    const failureCount = next.failureCount + 1;
    return {
      mind: {
        ...next,
        activeTurn: null,
        status,
        pauseReason: reason,
        failureCount,
        lastError: reason,
        nextEligibleWakeAt: retryAt || new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString(),
      },
      value: held,
    };
  });
  await appendMindEvent({
    kind: 'mind.failed',
    mindId: result.state.mindId,
    turnId,
    eventId: `mind-failed:${turnId}:${status}`,
    data: { status, error: reason, retryAt, consumedAttempt: result.value === true },
  });
  emitMindStatus(result.state);
  return result.state;
}

async function claimNextTurn() {
  const result = await mutateMindState((mind, root) => {
    if (supervisorStopping || !isDaemonRunning()) return { mind, value: null };
    if (!mind.enabled || !mind.started || mind.activeTurn || mind.status === 'paused') return { mind, value: null };
    if (root.paused || getDomainMode(root.config, 'cos') !== 'execute') return { mind, value: null };
    const selected = takeNextPersistentMindWake(mind);
    if (!selected.wake) return { mind: selected.state, value: null };
    const id = `mind-turn-${randomUUID()}`;
    const startedAt = nowIso();
    const activeTurn = {
      id,
      wake: selected.wake,
      startedAt,
      heartbeatAt: startedAt,
      providerId: null,
      model: null,
      effort: null,
    };
    return {
      mind: {
        ...selected.state,
        status: 'thinking',
        pauseReason: null,
        activeTurn,
        nextEligibleWakeAt: null,
      },
      value: activeTurn,
    };
  });
  if (result.value) {
    await appendMindEvent({
      kind: 'mind.wake',
      mindId: result.state.mindId,
      turnId: result.value.id,
      eventId: `mind-wake:${result.value.id}`,
      at: result.value.startedAt,
      data: {
        status: result.state.status,
        wakeKind: result.value.wake.kind,
        wakeId: result.value.wake.id || null,
        messageId: result.value.wake.message?.id || null,
        thinkingPresetId: result.value.wake.message?.thinkingPresetId || null,
        reason: result.value.wake.reason || null,
      },
    });
    emitMindStatus(result.state);
  }
  return result.value;
}

async function turnCanContinue(turnId, generation, signal) {
  if (supervisorStopping || !isDaemonRunning() || generation !== runtimeGeneration || signal.aborted) return false;
  const state = await getPersistentMindState();
  return !supervisorStopping
    && isDaemonRunning()
    && generation === runtimeGeneration
    && !signal.aborted
    && state.activeTurn?.id === turnId;
}

async function recordTurnProfile(turnId, prepared) {
  await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind };
    return {
      mind: {
        ...mind,
        activeTurn: {
          ...mind.activeTurn,
          providerId: prepared.provider?.id || null,
          model: prepared.model || null,
          effort: prepared.effort || null,
        },
      },
    };
  });
}

async function heartbeat(turnId, generation) {
  if (generation !== runtimeGeneration) return false;
  const result = await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind, value: false };
    return {
      mind: {
        ...mind,
        activeTurn: { ...mind.activeTurn, heartbeatAt: nowIso() },
      },
      value: true,
    };
  });
  return result.value === true;
}

async function completeTurn(turnId, result, generation) {
  if (generation !== runtimeGeneration) return;
  const completedAt = nowIso();
  const updated = await mutateMindState((mind, root) => {
    if (mind.activeTurn?.id !== turnId) return { mind, value: false };
    const messageId = mind.activeTurn.wake.kind === 'message'
      ? mind.activeTurn.wake.message.id
      : null;
    const messageFingerprint = messageId
      ? persistentMindMessageFingerprint(mind.activeTurn.wake.message)
      : null;
    const recentMessageIds = messageId
      ? [...mind.recentMessageIds.filter((id) => id !== messageId), messageId]
        .slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS)
      : mind.recentMessageIds;
    const recentMessageFingerprints = messageId
      ? [...mind.recentMessageFingerprints.filter((entry) => entry.id !== messageId), {
          id: messageId,
          fingerprint: messageFingerprint,
        }].slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS)
      : mind.recentMessageFingerprints;
    const quietPeriodMs = persistentMindWakeIntervalMs(root.config?.persistentMindProfile);
    const quietDeadline = Date.parse(completedAt) + quietPeriodMs;
    const requestedAt = Date.parse(result?.selfWake?.notBefore);
    const requestedWake = result?.selfWake && typeof result.selfWake === 'object'
      ? {
          id: `wake-${randomUUID()}`,
          kind: 'self',
          scheduleKind: 'requested',
          reason: String(result.selfWake.reason || 'turn requested follow-up')
            .slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS),
          sourceTurnId: turnId,
          createdAt: completedAt,
          // A turn may request an earlier follow-up, but the saved cadence is
          // the operator's maximum quiet period and therefore caps later asks.
          notBefore: new Date(Math.min(
            quietDeadline,
            Number.isFinite(requestedAt) ? Math.max(Date.parse(completedAt), requestedAt) : Date.parse(completedAt),
          )).toISOString(),
        }
      : quietSelfWake(turnId, quietPeriodMs, Date.parse(completedAt));
    const hasQueuedMessages = mind.queuedMessages.length > 0;
    return {
      mind: {
        ...mind,
        activeTurn: null,
        recentMessageIds,
        recentMessageFingerprints,
        selfWake: requestedWake,
        lastCompletedTurnId: turnId,
        lastCompletedAt: completedAt,
        nextEligibleWakeAt: null,
        failureCount: 0,
        lastError: null,
        status: hasQueuedMessages ? 'waiting' : 'idle',
        pauseReason: null,
      },
      value: true,
    };
  });
  if (!updated.value) return;
  await appendMindEvent({
    kind: 'mind.turn.completed',
    mindId: updated.state.mindId,
    turnId,
    eventId: `mind-turn-completed:${turnId}`,
    at: completedAt,
    data: {
      status: updated.state.status,
      providerId: result?.providerId || null,
      model: result?.model || null,
      effort: result?.effort || null,
      thinkingPresetId: result?.thinkingPresetId || null,
      summaryText: typeof result?.summary === 'string' ? result.summary : null,
    },
  });
  emitMindStatus(updated.state);
  cosEvents.emit('persistent-mind:turn-completed', {
    turnId,
    providerId: updated.state.lastCompletedTurnId === turnId ? result?.providerId || null : null,
  });
}

async function runOnePersistentMindTurn() {
  if (supervisorStopping || !isDaemonRunning()) return;
  if (!turnAdapter) {
    const updated = await mutateMindState((mind) => ({
      mind: mind.enabled && mind.started
        ? {
            ...mind,
            status: 'degraded',
            pauseReason: 'Persistent mind provider is not configured',
            lastError: 'Persistent mind provider is not configured',
            nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS).toISOString(),
          }
        : mind,
    }));
    emitMindStatus(updated.state);
    return;
  }

  const root = await loadState();
  const mind = normalizePersistentMindState(root.persistentMind);
  if (supervisorStopping || !isDaemonRunning()) return;
  if (!mind.enabled || !mind.started || mind.status === 'paused') return;
  if (root.paused || getDomainMode(root.config, 'cos') !== 'execute') return;

  const runningAgentEntries = Object.values(root.agents || {}).filter((agent) => agent.status === 'running');
  const maxConcurrentAgents = Number(root.config?.maxConcurrentAgents);
  const admissionId = `persistent-mind:${randomUUID()}`;
  const globalSlot = acquireCosGlobalSlot({
    agents: root.agents,
    limit: maxConcurrentAgents,
    reservationId: admissionId,
  });
  if (!globalSlot.ok) {
    const updated = await mutateMindState((current) => ({
      mind: {
        ...current,
        status: 'waiting',
        pauseReason: globalSlot.reason,
        nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_BASE_MS).toISOString(),
      },
    }));
    emitMindStatus(updated.state);
    return;
  }

  let actionReservation = null;
  try {
    let budget;
    try {
      budget = await getDomainBudgetStatus('cos');
    } catch (error) {
      const message = `Persistent mind budget check failed: ${errorMessage(error)}`;
      const updated = await mutateMindState((current) => ({
        mind: {
          ...current,
          status: 'degraded',
          pauseReason: message,
          lastError: message,
          nextEligibleWakeAt: new Date(Date.now() + persistentMindBackoffMs(current.failureCount + 1)).toISOString(),
          failureCount: current.failureCount + 1,
        },
      }));
      emitMindStatus(updated.state);
      return;
    }
    if (!budget.withinBudget) {
      const updated = await mutateMindState((current) => ({
        mind: {
          ...current,
          status: 'waiting',
          pauseReason: `CoS ${budget.exceeded || 'daily'} budget exhausted`,
          nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS).toISOString(),
        },
      }));
      emitMindStatus(updated.state);
      return;
    }

    const runningAutonomous = runningAgentEntries.filter(
      (agent) => agent.metadata?.taskType && agent.metadata.taskType !== 'user'
    ).length;
    actionReservation = acquireCosActionReservation({
      budget: budget.budget,
      usage: budget.usage,
      inFlight: runningAutonomous,
      reservationId: admissionId,
    });
    if (!actionReservation.ok) {
      const updated = await mutateMindState((current) => ({
        mind: {
          ...current,
          status: 'waiting',
          pauseReason: actionReservation.reason,
          nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS).toISOString(),
        },
      }));
      emitMindStatus(updated.state);
      return;
    }

    const turn = await claimNextTurn();
    if (!turn) return;

    const generation = runtimeGeneration;
    const controller = new AbortController();
    activeAbortController = controller;
    let release = () => {};
    let runStartedAt = null;
    try {
      // The route is resolved before an adapter can run. This is a read-only
      // catalog/status check: no alternate provider, model pull, or generation
      // is allowed while deciding whether the pinned mind can wake.
      //
      // A message the user explicitly sent with another model resolves its saved
      // preset here instead of the home profile. Only that one message carries
      // it: the next ordinary message and every scheduled wake read the
      // unchanged default, because the selection lives on the message rather
      // than in config. A preset that has since been removed, retired, or
      // narrowed is a refusal — never a silent return to the default route.
      const thinkingPresetId = turn.wake.kind === 'message'
        ? turn.wake.message.thinkingPresetId || null
        : null;
      const profile = thinkingPresetId
        ? await resolvePersistentMindThinkingSession({ presetId: thinkingPresetId, config: root.config })
        : await resolvePersistentMindProfile(root.config?.persistentMindProfile);
      if (!profile.ok) {
        await parkActiveTurn(turn.id, profile.error, 'degraded');
        return;
      }
      // Adapters receive the exact profile. They may prepare their text
      // transport, but cannot substitute a fallback provider/model/effort.
      const adapterPrepared = await turnAdapter.prepare({ wake: turn.wake, signal: controller.signal, profile });
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;
      if (!adapterPrepared?.ok || !adapterPrepared.provider) {
        await parkActiveTurn(turn.id, adapterPrepared?.error || 'Persistent mind provider is unavailable', 'degraded', { retryAt: adapterPrepared?.retryAt || null });
        return;
      }
      // Existing adapters only named their transport provider; missing model or
      // effort now means "use the supplied profile", while an explicit value
      // still must match exactly and cannot become a fallback route.
      const prepared = {
        ...adapterPrepared,
        model: adapterPrepared.model ?? profile.model,
        effort: adapterPrepared.effort ?? profile.effort,
      };
      if (prepared.provider.id !== profile.provider.id
          || prepared.model !== profile.model
          || prepared.effort !== profile.effort) {
        await parkActiveTurn(turn.id, 'Persistent mind adapter did not honor the pinned provider profile', 'degraded');
        return;
      }
      if (turn.wake.kind === 'message' && Array.isArray(turn.wake.message?.images) && turn.wake.message.images.length > 0) {
        const imageCapability = await resolvePersistentMindImageCapability({
          provider: prepared.provider,
          model: prepared.model,
        });
        if (!imageCapabilityAllowsAttempt(imageCapability, prepared.provider)) {
          await parkActiveTurn(turn.id, imageCapability.reason, 'degraded');
          return;
        }
      }
      await recordTurnProfile(turn.id, prepared);
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;

      const latestRoot = await loadState();
      const slot = await acquireLocalEndpointProviderSlot(prepared.provider, latestRoot.agents, turn.id);
      if (!slot.ok) {
        await parkActiveTurn(turn.id, slot.reason, 'waiting');
        return;
      }
      release = slot.release;
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;
      // One accounted provider span covers both optional context summarization
      // and the turn itself. A local adapter must not bypass endpoint capacity
      // merely because its first inference happens while context is prepared.
      runStartedAt = Date.now();
      const context = await preparePersistentMindContext({
        mindId: mind.mindId,
        identity: prepared.identity ?? turnAdapter.identity ?? 'One supervised persistent Chief of Staff mind.',
        instructions: prepared.instructions || '',
        memories: Array.isArray(prepared.memories) ? prepared.memories : [],
        providerId: prepared.provider.id,
        model: prepared.model || null,
        summarize: typeof turnAdapter.summarize === 'function'
          ? (input) => turnAdapter.summarize({
              ...input,
              provider: prepared.provider,
              model: prepared.model || null,
              effort: prepared.effort || null,
              signal: controller.signal,
              heartbeat: () => heartbeat(turn.id, generation),
            })
          : null,
      });
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;
      await appendMindEvent({
        kind: 'mind.model.request',
        mindId: mind.mindId,
        turnId: turn.id,
        eventId: `mind-model-request:${turn.id}`,
        data: {
          providerId: prepared.provider.id,
          model: prepared.model || null,
          effort: prepared.effort || null,
          thinkingPresetId,
          contextChars: context.chars,
          contextSummaryState: context.summaryState,
        },
      });
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;

      const result = await turnAdapter.run({
        turnId: turn.id,
        wake: turn.wake,
        provider: prepared.provider,
        model: prepared.model || null,
        effort: prepared.effort || null,
        signal: controller.signal,
        heartbeat: () => heartbeat(turn.id, generation),
        context,
        recordCapabilityEvent: ({ kind, id, data } = {}) => {
          const eventKind = kind === 'result' ? 'mind.capability.result' : 'mind.capability.request';
          const capabilityId = typeof id === 'string' && id ? id : randomUUID();
          return appendMindEvent({
            kind: eventKind,
            mindId: mind.mindId,
            turnId: turn.id,
            eventId: `mind-capability:${turn.id}:${capabilityId}:${kind === 'result' ? 'result' : 'request'}`,
            data: { capabilityId, ...(data && typeof data === 'object' ? data : {}) },
          });
        },
      });
      for (const event of Array.isArray(result?.events) ? result.events : []) {
        await appendMindEvent({
          kind: event.kind,
          mindId: mind.mindId,
          turnId: turn.id,
          eventId: `mind-${event.id}`,
          data: event.data,
        });
      }
      await appendMindEvent({
        kind: 'mind.model.result',
        mindId: mind.mindId,
        turnId: turn.id,
        eventId: `mind-model-result:${turn.id}`,
        data: {
          providerId: prepared.provider.id,
          model: prepared.model || null,
          effort: prepared.effort || null,
          thinkingPresetId,
          summaryText: typeof result?.summary === 'string' ? result.summary : null,
          responseChars: typeof result?.output === 'string' ? result.output.length : null,
          success: true,
        },
      });
      await completeTurn(turn.id, {
        ...result,
        providerId: prepared.provider.id,
        model: prepared.model || null,
        effort: prepared.effort || null,
        thinkingPresetId,
      }, generation);
    } catch (error) {
      if (generation === runtimeGeneration) {
        const message = controller.signal.aborted
          ? String(controller.signal.reason || 'Persistent mind turn interrupted')
          : errorMessage(error);
        await parkActiveTurn(turn.id, message, 'interrupted', { consumedAttempt: runStartedAt != null });
        emitLog('warn', `Persistent mind turn interrupted: ${message}`, { turnId: turn.id });
      }
    } finally {
      release();
      if (runStartedAt != null) {
        await recordDomainUsage('cos', { actions: 1, ms: Date.now() - runStartedAt }).catch((error) => {
          console.error(`❌ Failed to record persistent mind usage: ${error.message}`);
        });
      }
    }
  } finally {
    actionReservation?.release?.();
    globalSlot.release();
  }
}

export async function registerPersistentMindTurnAdapter(adapter) {
  if (!adapter || typeof adapter.prepare !== 'function' || typeof adapter.run !== 'function') {
    throw new Error('Persistent mind adapter requires prepare() and run()');
  }
  turnAdapter = adapter;
  await mutateMindState((mind) => ({
    mind: mind.lastError === 'Persistent mind provider is not configured'
      ? { ...mind, status: mind.started ? 'waiting' : mind.status, pauseReason: null, lastError: null, nextEligibleWakeAt: null }
      : mind,
  }));
  await scheduleNextWake();
}

export function unregisterPersistentMindTurnAdapter() {
  turnAdapter = null;
}

export async function getPersistentMindState() {
  const state = await loadState();
  return normalizePersistentMindState(state.persistentMind);
}

/** Apply a saved cadence to the currently scheduled self-wake and timer. */
export async function refreshPersistentMindWakeCadence() {
  const result = await mutateMindState((mind, root) => {
    if (!mind.started || mind.activeTurn) return { mind };
    const quietPeriodMs = persistentMindWakeIntervalMs(root.config?.persistentMindProfile);
    const baseAt = Number.isFinite(Date.parse(mind.lastCompletedAt))
      ? Date.parse(mind.lastCompletedAt)
      : Date.now();
    const quietDeadline = baseAt + quietPeriodMs;
    let selfWake = mind.selfWake;
    if (!selfWake && mind.queuedMessages.length === 0) {
      selfWake = quietSelfWake(mind.lastCompletedTurnId || 'cadence-change', quietPeriodMs, baseAt);
    } else if (selfWake?.scheduleKind === 'quiet') {
      selfWake = quietSelfWake(selfWake.sourceTurnId || mind.lastCompletedTurnId || 'cadence-change', quietPeriodMs, baseAt);
    } else if (selfWake && (!Number.isFinite(Date.parse(selfWake.notBefore)) || Date.parse(selfWake.notBefore) > quietDeadline)) {
      selfWake = { ...selfWake, notBefore: new Date(quietDeadline).toISOString() };
    }
    return { mind: { ...mind, selfWake } };
  });
  if (result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  return result.state;
}

/** Clear failure/backoff residue without changing lifecycle or queued work. */
export async function resetPersistentMindRuntimeResidue() {
  const result = await mutateMindState((mind) => ({
    mind: {
      ...mind,
      failureCount: 0,
      lastError: null,
      nextEligibleWakeAt: null,
      pauseReason: mind.status === 'paused' ? mind.pauseReason : null,
    },
  }));
  emitMindStatus(result.state);
  return result.state;
}

export async function setPersistentMindEnabled(enabled) {
  if (!enabled) {
    runtimeGeneration += 1;
    activeAbortController?.abort('Persistent mind disabled');
    cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
    cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  }
  const result = await mutateMindState((mind) => {
    const changedToDisabled = !enabled && (mind.enabled || Boolean(mind.activeTurn));
    const interruptedTurnId = !enabled ? mind.activeTurn?.id || null : null;
    let next = mind;
    if (!enabled && mind.activeTurn) next = releaseClaimedWake(next, mind.activeTurn.wake);
    return {
      mind: {
        ...next,
        enabled: Boolean(enabled),
        started: enabled ? next.started : false,
        status: enabled ? (next.started ? 'waiting' : 'idle') : 'disabled',
        activeTurn: enabled ? next.activeTurn : null,
        pauseReason: null,
        nextEligibleWakeAt: enabled ? next.nextEligibleWakeAt : null,
      },
      value: { changedToDisabled, interruptedTurnId, mindId: mind.mindId },
    };
  });
  if (result.value.changedToDisabled) {
    await appendMindEvent({
      kind: 'mind.paused',
      mindId: result.value.mindId,
      turnId: result.value.interruptedTurnId,
      eventId: `mind-disabled:${result.value.interruptedTurnId || randomUUID()}`,
      data: { status: 'disabled', error: 'Persistent mind disabled' },
    });
  }
  emitMindStatus(result.state);
  return result.state;
}

export async function startPersistentMind() {
  const result = await mutateMindState((mind) => {
    if (mind.started) return { mind, value: { success: true, alreadyStarted: true } };
    return {
      mind: {
        ...mind,
        enabled: true,
        started: true,
        status: 'waiting',
        pauseReason: null,
        selfWake: mind.queuedMessages.length > 0 ? mind.selfWake : initialSelfWake('explicit-start'),
        nextEligibleWakeAt: null,
      },
      value: { success: true, alreadyStarted: false },
    };
  });
  if (result.value.success) {
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(result.state);
  return result.value;
}

export async function pausePersistentMind(reason = 'Paused by user') {
  const { state, interrupted } = await interruptActiveTurn(reason, 'paused');
  if (!interrupted) {
    await appendMindEvent({
      kind: 'mind.paused',
      mindId: state.mindId,
      eventId: `mind-paused:${randomUUID()}`,
      data: { status: 'paused', error: reason },
    });
  }
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  return { success: true, state };
}

export async function resumePersistentMind() {
  const result = await mutateMindState((mind) => {
    if (!mind.enabled || !mind.started) return { mind, value: { success: false, error: 'Persistent mind is not started' } };
    if (mind.status !== 'paused') return { mind, value: { success: true, alreadyRunning: true } };
    return {
      mind: {
        ...mind,
        status: 'waiting',
        pauseReason: null,
        selfWake: mind.queuedMessages.length > 0 || mind.selfWake
          ? mind.selfWake
          : initialSelfWake('explicit-resume'),
      },
      value: { success: true, alreadyRunning: false },
    };
  });
  if (result.value.success) {
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(result.state);
  return result.value;
}

export async function stopPersistentMind({ waitForTurn = false } = {}) {
  runtimeGeneration += 1;
  activeAbortController?.abort('Persistent mind stopped');
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  const result = await mutateMindState((mind) => {
    const wasStarted = mind.started;
    const interruptedTurnId = mind.activeTurn?.id || null;
    let next = mind;
    if (mind.activeTurn) next = releaseClaimedWake(next, mind.activeTurn.wake);
    return {
      mind: {
        ...next,
        started: false,
        status: mind.enabled ? 'idle' : 'disabled',
        activeTurn: null,
        pauseReason: null,
        nextEligibleWakeAt: null,
      },
      value: { wasStarted, interruptedTurnId, mindId: mind.mindId },
    };
  });
  if (result.value.wasStarted || result.value.interruptedTurnId) {
    await appendMindEvent({
      kind: 'mind.paused',
      mindId: result.value.mindId,
      turnId: result.value.interruptedTurnId,
      eventId: `mind-stopped:${result.value.interruptedTurnId || randomUUID()}`,
      data: { status: result.state.status, error: 'Persistent mind stopped' },
    });
  }
  emitMindStatus(result.state);
  if (waitForTurn && activeRun) {
    await activeRun.catch((error) => {
      console.error(`❌ Failed while settling stopped persistent mind turn: ${error.message}`);
    });
  }
  return { success: true };
}

export async function enqueuePersistentMindMessage({
  id = randomUUID(),
  text,
  images,
  thinkingPresetId,
  createdAt = nowIso(),
} = {}) {
  const messageId = typeof id === 'string' ? id.trim().slice(0, 200) : '';
  const messageText = normalizeMessageText(text);
  const attachmentIds = normalizeRequestedAttachmentIds(images);
  const presetId = typeof thinkingPresetId === 'string'
    ? thinkingPresetId.trim().slice(0, PERSISTENT_MIND_THINKING_PRESET_LIMITS.ID_MAX)
    : '';
  if (!messageId || attachmentIds === null || (!messageText && attachmentIds.length === 0)) {
    return attachmentFailure('Message id and text or at least one image are required', { code: 'VALIDATION_ERROR' });
  }
  if (presetId || attachmentIds.length > 0) {
    const root = await loadState();
    const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
    // Admission reads the saved preset list only — a lookup, never a provider
    // call, model pull, or generation. Selecting a model must stay free.
    const preset = presetId
      ? findPersistentMindThinkingPreset(root.config?.persistentMindThinkingPresets, presetId)
      : null;
    if (presetId && !preset) {
      return attachmentFailure(`Temporary thinking preset "${presetId}" is not available`, {
        code: 'THINKING_PRESET_UNAVAILABLE',
        status: 422,
      });
    }
    if (attachmentIds.length > 0) {
      // Images are checked against the route this message will actually take,
      // so a text-only alternate cannot accept an image it can never read.
      const routeProviderId = preset ? preset.providerId : profile.providerId;
      const routeModel = preset ? preset.model : profile.model;
      const provider = routeProviderId ? await getProviderById(routeProviderId) : null;
      const imageCapability = await resolvePersistentMindImageCapability({ provider, model: routeModel });
      if (!imageCapabilityAllowsAttempt(imageCapability, provider)) {
        return attachmentFailure(imageCapability.reason, { code: 'IMAGE_CAPABILITY_UNSUPPORTED', status: 422 });
      }
    }
  }
  const messageCreatedAt = typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt))
    ? new Date(createdAt).toISOString()
    : nowIso();
  await cleanupPersistentMindAttachments();
  const result = await mutateMindState(async (mind) => {
    if (attachmentIds.length > 0 && isUpdateInProgress()) {
      return {
        mind,
        value: attachmentFailure('Persistent Mind image admission is paused during a PortOS update', {
          code: 'UPDATE_IN_PROGRESS',
          status: 409,
        }),
      };
    }
    const existingMessage = findMessageById(mind, messageId);
    const claimedRecords = claimedAttachmentsForMessage(mind, messageId);
    const duplicate = Boolean(existingMessage) || mind.recentMessageIds.includes(messageId);
    const requestedFingerprint = persistentMindMessageFingerprint({
      text: messageText,
      images: attachmentIds,
      thinkingPresetId: presetId,
    });
    const recentFingerprint = mind.recentMessageFingerprints.find((entry) => entry.id === messageId)?.fingerprint;
    const existingImageIds = existingMessage
      ? imageIdsForMessage(existingMessage)
      : claimedRecords.map((attachment) => attachment.attachmentId);
    if (duplicate) {
      if (!existingMessage && !recentFingerprint) {
        return {
          mind,
          value: attachmentFailure('This completed message predates retry verification; send it again with a new message id', {
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
          }),
        };
      }
      if (!existingMessage && recentFingerprint && recentFingerprint !== requestedFingerprint) {
        return {
          mind,
          value: attachmentFailure('A retry must use the same Persistent Mind message content', {
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
          }),
        };
      }
      if (existingMessage && existingMessage.text !== messageText) {
        return {
          mind,
          value: attachmentFailure('A retry must use the same Persistent Mind message text', {
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
          }),
        };
      }
      if (existingMessage && (existingMessage.thinkingPresetId || '') !== presetId) {
        return {
          mind,
          value: attachmentFailure('A retry must use the same Persistent Mind thinking preset', {
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
          }),
        };
      }
      if (!sameAttachmentIds(existingImageIds, attachmentIds)) {
        return {
          mind,
          value: attachmentFailure('A retry must use the same Persistent Mind image references', {
            code: 'IDEMPOTENCY_CONFLICT',
            status: 409,
          }),
        };
      }
      const resolved = await resolveMessageAttachments(mind, attachmentIds, messageId);
      if (resolved.error) return { mind, value: resolved.error };
      return {
        mind,
        value: {
          success: true,
          duplicate: true,
          messageId,
          acceptedMessage: existingMessage || messageFromAttachments({
            id: messageId,
            text: messageText,
            createdAt: messageCreatedAt,
            attachments: resolved.attachments,
            thinkingPresetId: presetId,
          }),
        },
      };
    }
    if (claimedRecords.length > 0 && !sameAttachmentIds(
      claimedRecords.map((attachment) => attachment.attachmentId),
      attachmentIds,
    )) {
      return {
        mind,
        value: attachmentFailure('A retry must use the same Persistent Mind image references', {
          code: 'IDEMPOTENCY_CONFLICT',
          status: 409,
        }),
      };
    }
    const resolved = await resolveMessageAttachments(mind, attachmentIds, messageId);
    if (resolved.error) return { mind, value: resolved.error };
    const acceptedMessageCount = mind.queuedMessages.length
      + (mind.activeTurn?.wake.kind === 'message' ? 1 : 0);
    if (acceptedMessageCount >= PERSISTENT_MIND_LIMITS.MAX_QUEUED_MESSAGES) {
      return { mind, value: attachmentFailure('Persistent mind message queue is full', { code: 'QUEUE_FULL', status: 409 }) };
    }
    // Once the state mutation below records the claim, the attachment is a
    // durable conversation asset. Removing the pending marker first is safe:
    // if this process stops before saveState, the still-unclaimed state record
    // continues to protect the valid file from cleanup.
    for (const attachment of resolved.attachments) {
      await removePendingAttachmentMarker(attachment.attachmentId);
    }
    const claimedAt = nowIso();
    const requestedIds = new Set(attachmentIds);
    const pendingAttachments = mind.pendingAttachments.map((attachment) => {
      if (!requestedIds.has(attachment.attachmentId)) return attachment;
      return {
        ...attachment,
        claimedBy: messageId,
        claimedAt,
        claimIndex: attachmentIds.indexOf(attachment.attachmentId),
        expiresAt: null,
      };
    });
    const message = messageFromAttachments({
      id: messageId,
      text: messageText,
      createdAt: messageCreatedAt,
      attachments: resolved.attachments,
      thinkingPresetId: presetId,
    });
    return {
      mind: {
        ...mind,
        pendingAttachments,
        queuedMessages: [...mind.queuedMessages, message],
        status: mind.started && mind.status !== 'paused' ? 'waiting' : mind.status,
      },
      value: { success: true, duplicate: false, messageId, acceptedMessage: message },
    };
  });
  if (result.value.success) {
    // Retry the stable event id even when the mutable queue already saw this
    // message. The ledger deduplicates a healthy first append; if the first
    // append was dropped, the caller's idempotent retry repairs the trajectory.
    const acceptedMessage = result.value.acceptedMessage;
    await appendMindEvent({
      kind: 'mind.message.accepted',
      mindId: result.state.mindId,
      eventId: `mind-message:${messageId}`,
      at: acceptedMessage.createdAt,
      data: {
        messageId,
        displayText: acceptedMessage.text,
        textChars: acceptedMessage.text.length,
        thinkingPresetId: acceptedMessage.thinkingPresetId || null,
        imageCount: Array.isArray(acceptedMessage.images) ? acceptedMessage.images.length : 0,
        images: Array.isArray(acceptedMessage.images)
          ? acceptedMessage.images.map(normalizePersistentMindMessageImage).filter(Boolean)
          : [],
      },
    });
  }
  if (result.value.success && result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  const publicResult = { ...result.value };
  delete publicResult.acceptedMessage;
  return publicResult;
}

export async function requestPersistentMindWake({ sourceTurnId, reason, notBefore = nowIso() } = {}) {
  const result = await mutateMindState((mind) => {
    if (!sourceTurnId || sourceTurnId !== mind.lastCompletedTurnId) {
      return { mind, value: { success: false, error: 'Self-wake must reference the last completed turn' } };
    }
    const selfWake = {
      id: `wake-${randomUUID()}`,
      kind: 'self',
      scheduleKind: 'requested',
      reason: String(reason || 'self-wake').slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS),
      sourceTurnId,
      createdAt: nowIso(),
      notBefore,
    };
    return {
      mind: { ...mind, selfWake, status: mind.started && mind.status !== 'paused' ? 'waiting' : mind.status },
      value: { success: true, wakeId: selfWake.id },
    };
  });
  if (result.value.success && result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  return result.value;
}

export async function drainPersistentMind({ rearm = true } = {}) {
  if (activeRun) return activeRun;
  const run = runOnePersistentMindTurn();
  activeRun = run.finally(async () => {
    activeRun = null;
    activeAbortController = null;
    if (rearm) await scheduleNextWake();
  });
  return activeRun;
}

export async function checkPersistentMindWatchdog() {
  const state = await getPersistentMindState();
  if (!persistentMindTurnIsStale(state)) return { interrupted: false };
  const result = await interruptActiveTurn('Persistent mind turn heartbeat expired', 'interrupted', {
    retry: true,
    expectedTurnId: state.activeTurn.id,
  });
  if (result.interrupted) await scheduleNextWake();
  return { interrupted: result.interrupted };
}

export async function initializePersistentMindSupervisor() {
  supervisorStopping = false;
  await cleanupPersistentMindAttachments();
  const recovered = await mutateMindState((mind, root) => {
    if (!mind.enabled || !mind.started) return { mind };
    let next = mind;
    const orphanedTurnId = mind.activeTurn?.id || null;
    if (mind.activeTurn) {
      next = releaseClaimedWake(next, mind.activeTurn.wake);
      const failureCount = next.failureCount + 1;
      next = {
        ...next,
        activeTurn: null,
        status: 'interrupted',
        pauseReason: 'Recovered an orphaned persistent mind turn after restart',
        failureCount,
        lastError: 'Recovered an orphaned persistent mind turn after restart',
        nextEligibleWakeAt: new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString(),
      };
    } else if (next.queuedMessages.length === 0 && !next.selfWake) {
      const base = next.lastCompletedAt ? Date.parse(next.lastCompletedAt) : Date.now();
      next = {
        ...next,
        selfWake: quietSelfWake(
          next.lastCompletedTurnId || 'restart',
          persistentMindWakeIntervalMs(root.config?.persistentMindProfile),
          base,
        ),
      };
    }
    return { mind: next, value: { orphanedTurnId, mindId: mind.mindId } };
  });
  if (recovered.value?.orphanedTurnId) {
    await appendMindEvent({
      kind: 'mind.failed',
      mindId: recovered.value.mindId,
      turnId: recovered.value.orphanedTurnId,
      eventId: `mind-restart-recovered:${recovered.value.orphanedTurnId}`,
      data: {
        status: 'interrupted',
        error: 'Recovered an orphaned persistent mind turn after restart',
      },
    });
  }
  if (recovered.state.enabled && recovered.state.started) {
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(recovered.state);
  return recovered.state;
}

export async function handlePersistentMindGlobalPause(reason = 'Chief of Staff paused') {
  const state = await getPersistentMindState();
  if (!state.activeTurn) {
    cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
    return state;
  }
  return (await interruptActiveTurn(reason, 'waiting')).state;
}

export async function handlePersistentMindGlobalResume() {
  await scheduleNextWake();
}

export async function shutdownPersistentMindSupervisor() {
  supervisorStopping = true;
  runtimeGeneration += 1;
  activeAbortController?.abort('Chief of Staff daemon stopped');
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  const state = await getPersistentMindState();
  if (!state.activeTurn) return state;
  return (await interruptActiveTurn('Chief of Staff daemon stopped', 'interrupted', { retry: true })).state;
}

export function __resetPersistentMindSupervisorForTests() {
  turnAdapter = null;
  activeRun = null;
  activeAbortController = null;
  runtimeGeneration = 0;
  supervisorStopping = false;
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
}
