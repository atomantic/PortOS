import { useCallback, useEffect, useRef, useState } from 'react';
import { readFileAsBase64 } from '../utils/fileUpload';

const MAX_ATTACHMENTS = 8;
// Matches server-side ATTACHMENT_BASE64_MAX_CHARS (13,333,333 chars). Base64 expands raw bytes
// by 4/3, so 13,333,333 chars ≈ 9,999,999 raw bytes after block-rounding. Use that as the limit
// so a file that passes client validation is guaranteed to pass server validation too.
const MAX_ATTACHMENT_FILE_SIZE = 9_999_999; // effective per-file server limit in raw bytes
// Matches server-side ATTACHMENTS_TOTAL_BASE64_MAX_CHARS (50,000,000 chars ≈ 37.5MB raw)
const MAX_ATTACHMENTS_TOTAL_BASE64_CHARS = 50_000_000;

const ALLOWED_ATTACHMENT_MIME_PREFIXES = ['image/'];
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown',
  'application/json', 'text/csv', 'application/csv', 'text/x-csv',
  'application/pdf'
]);
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf']);

function getAttachmentKind(file) {
  return file.type.startsWith('image/') ? 'image' : 'file';
}

function isAllowedAttachmentType(file) {
  if (ALLOWED_ATTACHMENT_MIME_PREFIXES.some(p => file.type?.startsWith(p))) return true;
  const mimeBase = file.type ? file.type.split(';')[0].trim().toLowerCase() : '';
  if (mimeBase && ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeBase)) return true;
  const ext = file.name ? `.${file.name.split('.').pop().toLowerCase()}` : '';
  return ALLOWED_ATTACHMENT_EXTENSIONS.has(ext);
}

async function filesToAttachments(files) {
  const createdPreviewUrls = [];
  try {
    return await Promise.all(files.map(async (file) => {
      const kind = getAttachmentKind(file);
      const mediaType = file.type || 'application/octet-stream';
      const base64 = await readFileAsBase64(file);
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : '';
      if (previewUrl) createdPreviewUrls.push(previewUrl);
      return {
        id: `attachment-${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        filename: file.name,
        mediaType,
        kind,
        size: file.size,
        data: base64,
        previewUrl
      };
    }));
  } catch (err) {
    createdPreviewUrls.forEach(url => URL.revokeObjectURL(url));
    throw err;
  }
}

export function useOpenClawAttachments({ sending, onError = () => {} } = {}) {
  const [attachments, setAttachments] = useState([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef(null);
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Revoke any remaining object URLs when the hook unmounts — owned here since
  // previewUrls are created by this hook.
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    };
  }, []);

  const appendFiles = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    if (sending) return;

    const remainingSlots = MAX_ATTACHMENTS - attachmentsRef.current.length;

    if (remainingSlots <= 0) {
      onError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      return;
    }

    const limitedFiles = files.slice(0, remainingSlots);
    const tooLargeFile = limitedFiles.find(
      (file) => typeof file.size === 'number' && file.size > MAX_ATTACHMENT_FILE_SIZE
    );

    if (tooLargeFile) {
      onError(
        `"${tooLargeFile.name}" is too large. Maximum attachment size is ${Math.round(MAX_ATTACHMENT_FILE_SIZE / (1024 * 1024))}MB.`
      );
      return;
    }

    const disallowedFile = limitedFiles.find(file => !isAllowedAttachmentType(file));
    if (disallowedFile) {
      onError(`"${disallowedFile.name}" is not a supported file type. Allowed: images, .txt, .md, .json, .csv, .pdf`);
      return;
    }

    try {
      const next = await filesToAttachments(limitedFiles);
      const newBase64Chars = next.reduce((sum, a) => sum + (typeof a.data === 'string' ? a.data.length : 0), 0);

      // Use the ref for live state — avoids stale-closure issues after the async read.
      const liveAttachments = attachmentsRef.current;
      const existingBase64Chars = liveAttachments.reduce((sum, a) => sum + (typeof a.data === 'string' ? a.data.length : 0), 0);
      if (existingBase64Chars + newBase64Chars > MAX_ATTACHMENTS_TOTAL_BASE64_CHARS) {
        next.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
        const totalMB = Math.round((existingBase64Chars + newBase64Chars) * 0.75 / (1024 * 1024));
        onError(`Combined attachments exceed the 50MB encoded total limit (~${totalMB}MB decoded).`);
        return;
      }

      const liveRemaining = MAX_ATTACHMENTS - liveAttachments.length;
      if (liveRemaining <= 0) {
        next.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
        onError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
        return;
      }

      const accepted = next.slice(0, liveRemaining);
      next.slice(liveRemaining).forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      setAttachments(prev => [...prev, ...accepted]);
      onError('');
    } catch (err) {
      onError(err.message || 'Failed to prepare attachment');
    }
  }, [sending, onError]);

  const removeAttachment = (attachmentId) => {
    setAttachments(current => {
      const toRemove = current.find(a => a.id === attachmentId);
      if (toRemove?.previewUrl) URL.revokeObjectURL(toRemove.previewUrl);
      return current.filter(item => item.id !== attachmentId);
    });
  };

  const handleAttachmentSelect = async (event) => {
    const files = Array.from(event.target.files || []);
    await appendFiles(files);
    event.target.value = '';
  };

  const handlePaste = async (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const files = items
      .map(item => item.getAsFile())
      .filter(Boolean);

    if (files.length === 0) return;
    event.preventDefault();
    await appendFiles(files);
  };

  const handleDragEnter = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer?.types?.includes('Files')) {
      dragCounterRef.current += 1;
      setIsDragActive(true);
    }
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragActive(false);
    }
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragActive(false);
    const files = Array.from(event.dataTransfer?.files || []);
    await appendFiles(files);
  };

  return {
    attachments,
    setAttachments,
    isDragActive,
    fileInputRef,
    appendFiles,
    removeAttachment,
    handleAttachmentSelect,
    handlePaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop
  };
}
