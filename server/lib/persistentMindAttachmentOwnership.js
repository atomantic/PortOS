// This namespace belongs to Mind even after its bounded metadata is pruned.
// Only the attachment lifecycle may decide that its bytes/markers can be removed.
export const MIND_ATTACHMENT_FILENAME_PREFIX = 'mind-';
export const PENDING_ATTACHMENT_MARKER_PREFIX = '.mind-pending-';
export const PENDING_ATTACHMENT_MARKER_PATTERN = /^\.mind-pending-([A-Za-z0-9_-]{1,128})$/;

export const isPersistentMindScreenshotEntry = (name) => {
  // Named purges can alias lowercase files on case-insensitive filesystems.
  const normalized = name.toLowerCase();
  return normalized.startsWith(MIND_ATTACHMENT_FILENAME_PREFIX)
    || normalized.startsWith(PENDING_ATTACHMENT_MARKER_PREFIX);
};
