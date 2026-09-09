/**
 * Persistent Mind screenshot attachment storage and lifecycle.
 *
 * Owns image upload validation, storage in the screenshots directory,
 * pending attachment markers, crash recovery, and expiration cleanup
 * independently of the supervisor turn execution loop.
 */

import { randomUUID } from 'crypto';
import { mkdir, readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import {
  PERSISTENT_MIND_LIMITS,
  PERSISTENT_MIND_IMAGE_EXTENSIONS,
  isPersistentMindAttachmentId,
  normalizePersistentMindAttachment,
  normalizePersistentMindState,
  publicPersistentMindAttachment,
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
import { loadState, saveState, withStateLock } from './cosState.js';
import { isUpdateInProgress } from './updateChecker.js';

const nowIso = () => new Date().toISOString();

export const PENDING_ATTACHMENT_MARKER_PREFIX = '.mind-pending-';
export const PENDING_ATTACHMENT_MARKER_PATTERN = /^\.mind-pending-([A-Za-z0-9_-]{1,128})$/;

export const attachmentFailure = (error, { code = 'INVALID_ATTACHMENT', status = 400 } = {}) => ({
  success: false,
  error,
  code,
  status,
});

export const pendingAttachmentMarkerPath = (attachmentId) => join(
  PATHS.screenshots,
  `${PENDING_ATTACHMENT_MARKER_PREFIX}${attachmentId}`,
);

export const removePendingAttachmentMarker = async (attachmentId) => unlinkGuarded(pendingAttachmentMarkerPath(attachmentId)).then(
  () => true,
  (error) => {
    if (error?.code === 'ENOENT') return true;
    console.error(`❌ Failed to remove Persistent Mind upload marker ${attachmentId}: ${error.message}`);
    return false;
  },
);

export const removeStoredFilename = async (filename) => {
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

export const screenshotEntries = async () => readdir(PATHS.screenshots).then(
  (entries) => entries.filter((entry) => typeof entry === 'string'),
  (error) => {
    if (error?.code === 'ENOENT') return [];
    console.error(`❌ Failed to inspect Persistent Mind upload markers: ${error.message}`);
    return null;
  },
);

export const removePendingAttachmentFiles = async (attachmentId, entries) => {
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
export const cleanupUnindexedPendingAttachments = async ({ knownAttachments, now, limit }) => {
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

export const verifyStoredAttachment = async (attachment) => {
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

export const removeStoredAttachmentFile = async (attachment) => {
  return removeStoredFilename(attachment.filename);
};

export const removeUploadAfterStateFailure = async (filePath, attachmentId) => unlinkGuarded(filePath).then(
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
export const removeRejectedUpload = async (attachmentId) => {
  const entries = await screenshotEntries();
  if (entries) await removePendingAttachmentFiles(attachmentId, entries);
  await removePendingAttachmentMarker(attachmentId);
};

export const resolveMessageAttachments = async (mind, attachmentIds, messageId) => {
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

async function mutateMindAttachments(mutator) {
  return withStateLock(async () => {
    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    const result = await mutator(mind, root);
    const next = result?.mind || mind;
    root.persistentMind = normalizePersistentMindState(next);
    await saveState(root);
    return { state: root.persistentMind, value: result?.value };
  });
}

/** Remove expired or invalid unclaimed files in one bounded maintenance pass. */
export async function cleanupPersistentMindAttachments({ now = Date.now() } = {}) {
  const result = await mutateMindAttachments(async (mind) => {
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
  const result = await mutateMindAttachments(async (mind) => {
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
  const result = await mutateMindAttachments(async (mind) => {
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
