/** Admit idempotent Persistent Mind messages and claim their attachments in the same state transaction. */
import { randomUUID } from 'crypto';
import {
  PERSISTENT_MIND_LIMITS,
  isPersistentMindAttachmentId,
  normalizePersistentMindMessageImage,
  normalizePersistentMindState,
  persistentMindMessageFingerprint,
} from '../../lib/persistent/persistentMind.js';
import { loadState } from '../cos/cosState.js';
import {
  attachmentFailure,
  cleanupPersistentMindAttachments,
  removePendingAttachmentMarker,
  resolveMessageAttachments,
} from './persistentMindAttachments.js';
import { appendMindEvent } from '../agent/agentRunEventLog.js';
import { isUpdateInProgress } from '../updateChecker.js';
import { normalizePersistentMindProfile } from '../../lib/persistent/persistentMindProfile.js';
import { getProviderById } from '../provider/providers.js';
import {
  findPersistentMindThinkingPreset,
  normalizePersistentMindThinkingSelection,
  samePersistentMindThinkingSelection,
  PERSISTENT_MIND_THINKING_PRESET_LIMITS,
} from '../../lib/persistent/persistentMindThinkingPresets.js';
import { imageCapabilityAllowsAttempt, resolvePersistentMindImageCapability } from './persistentMindImageCapability.js';

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

const messageFromAttachments = ({ id, text, createdAt, attachments, thinkingPresetId, thinkingPreset }) => ({
  id,
  text,
  ...(attachments.length > 0 ? {
    images: attachments.map(normalizePersistentMindMessageImage).filter(Boolean),
  } : {}),
  ...(thinkingPresetId ? { thinkingPresetId, thinkingPreset: thinkingPreset || null } : {}),
  createdAt,
});

async function probeMessageImageProfile(profile) {
  if (!profile) return null;
  const { providerId, model } = profile;
  const provider = providerId ? await getProviderById(providerId) : null;
  const capability = await resolvePersistentMindImageCapability({ provider, model });
  return { providerId, model, allowed: imageCapabilityAllowsAttempt(capability, provider), reason: capability.reason };
}

export async function admitPersistentMindMessage({
  id = randomUUID(),
  text,
  images,
  thinkingPresetId,
  thinkingPreset,
  createdAt = new Date().toISOString(),
} = {}, { mutateMindState, armWatchdog, scheduleNextWake, emitMindStatus, resetUsageLimitProbe }) {
  const messageId = typeof id === 'string' ? id.trim().slice(0, 200) : '';
  const messageText = normalizeMessageText(text);
  const attachmentIds = normalizeRequestedAttachmentIds(images);
  const presetId = typeof thinkingPresetId === 'string'
    ? thinkingPresetId.trim().slice(0, PERSISTENT_MIND_THINKING_PRESET_LIMITS.ID_MAX)
    : '';
  if (!messageId || attachmentIds === null || (!messageText && attachmentIds.length === 0)) {
    return attachmentFailure('Message id and text or at least one image are required', { code: 'VALIDATION_ERROR' });
  }
  const submittedSelection = normalizePersistentMindThinkingSelection(thinkingPreset);
  if (thinkingPreset !== undefined && (!submittedSelection || submittedSelection.id !== presetId)) {
    return attachmentFailure('A temporary selection must include the exact preset, provider, model and effort', { code: 'VALIDATION_ERROR' });
  }
  const messageCreatedAt = typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt))
    ? new Date(createdAt).toISOString()
    : new Date().toISOString();
  await cleanupPersistentMindAttachments();
  const currentPreset = (config) => presetId
    ? findPersistentMindThinkingPreset(config?.persistentMindThinkingPresets, presetId)
    : null;
  let imageProfile = null;
  if (attachmentIds.length > 0 && !isUpdateInProgress()) {
    const snapshot = await loadState();
    const mind = normalizePersistentMindState(snapshot.persistentMind);
    if (!findMessageById(mind, messageId) && !mind.recentMessageIds.includes(messageId)) {
      imageProfile = presetId
        ? currentPreset(snapshot.config)
        : normalizePersistentMindProfile(snapshot.config?.persistentMindProfile);
      if (submittedSelection && !samePersistentMindThinkingSelection(submittedSelection, imageProfile)) imageProfile = null;
    }
  }
  const admitMessage = (imageCheck) => mutateMindState(async (mind, root) => {
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
    const recentReceipt = mind.recentMessageFingerprints.find((entry) => entry.id === messageId);
    const acceptedSelection = existingMessage?.thinkingPreset || recentReceipt?.thinkingPreset || null;
    const requestedFingerprint = persistentMindMessageFingerprint({
      text: messageText,
      images: attachmentIds,
      thinkingPresetId: presetId,
      thinkingPreset: submittedSelection || acceptedSelection,
    });
    const recentFingerprint = recentReceipt?.fingerprint;
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
      if (existingMessage && submittedSelection
          && !samePersistentMindThinkingSelection(submittedSelection, acceptedSelection)) {
        return {
          mind,
          value: attachmentFailure('A retry must use the same accepted thinking route', {
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
            thinkingPreset: acceptedSelection,
          }),
        },
      };
    }
    // Resolve new admissions inside the same state update that accepts them.
    // Matching retries above use their receipt, even if the preset was revoked.
    const selection = currentPreset(root.config);
    if (presetId && !selection) {
      return { mind, value: attachmentFailure('The temporary thinking preset is unavailable', {
        code: 'THINKING_PRESET_UNAVAILABLE', status: 422,
      }) };
    }
    if (submittedSelection && !samePersistentMindThinkingSelection(submittedSelection, selection)) {
      return { mind, value: attachmentFailure('The displayed preset changed; select its current route before sending', {
        code: 'THINKING_PRESET_CHANGED', status: 409,
      }) };
    }
    if (attachmentIds.length > 0) {
      const profile = selection || normalizePersistentMindProfile(root.config?.persistentMindProfile);
      if (!imageCheck || imageCheck.providerId !== profile.providerId || imageCheck.model !== profile.model) {
        return { mind, value: { retryImageProfile: profile } };
      }
      if (!imageCheck.allowed) {
        return { mind, value: attachmentFailure(imageCheck.reason, { code: 'IMAGE_CAPABILITY_UNSUPPORTED', status: 422 }) };
      }
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
    const claimedAt = new Date().toISOString();
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
      thinkingPreset: selection,
    });
    return {
      mind: {
        ...mind,
        pendingAttachments,
        queuedMessages: [...mind.queuedMessages, message],
        // Sending a new message is explicit consent to start/resume. Keep an
        // in-flight turn intact; FIFO admission picks this message up next.
        enabled: true,
        started: true,
        status: mind.activeTurn ? mind.status : 'waiting',
        pauseReason: null,
        nextEligibleWakeAt: null,
      },
      value: { success: true, duplicate: false, messageId, acceptedMessage: message },
    };
  });
  let result = await admitMessage(await probeMessageImageProfile(imageProfile));
  if (result.value.retryImageProfile) {
    result = await admitMessage(await probeMessageImageProfile(result.value.retryImageProfile));
    if (result.value.retryImageProfile) {
      return attachmentFailure('The image route changed during admission; retry this message', {
        code: 'IMAGE_PROFILE_CHANGED', status: 409,
      });
    }
  }
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
        thinkingPreset: acceptedMessage.thinkingPreset || null,
        imageCount: Array.isArray(acceptedMessage.images) ? acceptedMessage.images.length : 0,
        images: Array.isArray(acceptedMessage.images)
          ? acceptedMessage.images.map(normalizePersistentMindMessageImage).filter(Boolean)
          : [],
      },
    });
  }
  if (result.value.success && !result.value.duplicate) {
    resetUsageLimitProbe();
    armWatchdog();
  }
  if (result.value.success && result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  const publicResult = { ...result.value };
  delete publicResult.acceptedMessage;
  return publicResult;
}
