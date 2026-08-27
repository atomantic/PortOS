import { request, API_BASE, throwApiError } from './apiCore.js';
import { formatBytes } from '../utils/formatters.js';
import {
  validateImageFile,
  ALLOWED_ATTACHMENT_EXTENSIONS,
  SCREENSHOT_MAX_FILE_SIZE,
  ATTACHMENT_MAX_FILE_SIZE,
} from '../utils/fileUpload.js';

// Screenshots
export const uploadScreenshot = (base64Data, filename, mimeType) => request('/screenshots', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename, mimeType })
});

// Attachments (generic file uploads for tasks)
export const uploadAttachment = (base64Data, filename) => request('/attachments', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename })
});
export const getAttachment = (filename) => request(`/attachments/${encodeURIComponent(filename)}`);
export const deleteAttachment = (filename) => request(`/attachments/${encodeURIComponent(filename)}`, { method: 'DELETE' });
export const listAttachments = () => request('/attachments');

/**
 * Upload a single screenshot file
 *
 * @param {File} file - File to upload
 * @param {Object} options - Upload options
 * @param {Function} options.onSuccess - Callback for successful upload
 * @param {Function} options.onError - Callback for errors
 * @returns {Promise<Object|null>} Uploaded file info or null on failure
 */
export async function uploadScreenshotFile(file, options = {}) {
  const { onSuccess, onError } = options;

  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = async (ev) => {
      const result = ev?.target?.result;
      if (typeof result !== 'string') {
        onError?.('Failed to read file: unexpected result type');
        resolve(null);
        return;
      }

      const parts = result.split(',');
      if (parts.length < 2) {
        onError?.('Failed to read file: invalid data URL format');
        resolve(null);
        return;
      }

      const base64 = parts[1];
      const uploaded = await uploadScreenshot(base64, file.name, file.type).catch((err) => {
        onError?.(`Failed to upload: ${err.message}`);
        return null;
      });

      if (uploaded) {
        const fileInfo = {
          id: uploaded.id,
          filename: uploaded.filename,
          preview: result,
          path: uploaded.path
        };
        onSuccess?.(fileInfo);
        resolve(fileInfo);
      } else {
        resolve(null);
      }
    };

    reader.onerror = () => {
      onError?.('Failed to read file');
      resolve(null);
    };

    reader.readAsDataURL(file);
  });
}

/**
 * Process and upload image files as screenshots
 *
 * @param {FileList|File[]} files - Files to process
 * @param {Object} options - Upload options
 * @param {number} options.maxFileSize - Max file size in bytes (default: 10MB)
 * @param {Function} options.onSuccess - Callback for successful upload (receives uploaded file info)
 * @param {Function} options.onError - Callback for errors (receives error message)
 * @returns {Promise<void>}
 */
export async function processScreenshotUploads(files, options = {}) {
  const {
    maxFileSize = SCREENSHOT_MAX_FILE_SIZE,
    onSuccess,
    onError
  } = options;

  const fileArray = Array.from(files);

  for (const file of fileArray) {
    // Non-image files are skipped SILENTLY here (this runs over a multi-select /
    // drop of mixed content, where naming each non-image is noise) — but an
    // oversized image is reported, since the user clearly meant to upload it.
    if (!file.type.startsWith('image/')) continue;

    const problem = validateImageFile(file, maxFileSize);
    if (problem) {
      onError?.(problem);
      continue;
    }

    await uploadScreenshotFile(file, { onSuccess, onError });
  }
}

/**
 * Check if a file extension is allowed for attachments
 */
function isAllowedAttachmentExtension(filename) {
  const ext = filename.lastIndexOf('.') > -1
    ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
    : '';
  return ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext);
}

/**
 * Get file extension from filename
 */
function getFileExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > -1 ? filename.slice(lastDot).toLowerCase() : '';
}

/**
 * Check if a file is an image based on extension
 */
function isImageFile(filename) {
  const ext = getFileExtension(filename);
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
}

/**
 * Process and upload generic file attachments
 *
 * @param {FileList|File[]} files - Files to process
 * @param {Object} options - Upload options
 * @param {number} options.maxFileSize - Max file size in bytes (default: ATTACHMENT_MAX_FILE_SIZE)
 * @param {Function} options.onSuccess - Callback for successful upload (receives uploaded file info)
 * @param {Function} options.onError - Callback for errors (receives error message)
 * @returns {Promise<void>}
 */
export async function processAttachmentUploads(files, options = {}) {
  const {
    maxFileSize = ATTACHMENT_MAX_FILE_SIZE,
    onSuccess,
    onError
  } = options;

  const fileArray = Array.from(files);

  for (const file of fileArray) {
    // Check file extension is allowed
    if (!isAllowedAttachmentExtension(file.name)) {
      const allowedList = ALLOWED_ATTACHMENT_EXTENSIONS.join(', ');
      onError?.(`File "${file.name}" has unsupported type. Allowed: ${allowedList}`);
      continue;
    }

    // Check file size
    if (file.size > maxFileSize) {
      onError?.(`File "${file.name}" exceeds the ${formatBytes(maxFileSize)} limit`);
      continue;
    }

    await uploadAttachmentFile(file, { onSuccess, onError });
  }
}

/**
 * Upload a single attachment file
 *
 * @param {File} file - File to upload
 * @param {Object} options - Upload options
 * @param {Function} options.onSuccess - Callback for successful upload
 * @param {Function} options.onError - Callback for errors
 * @returns {Promise<Object|null>} Uploaded file info or null on failure
 */
export async function uploadAttachmentFile(file, options = {}) {
  const { onSuccess, onError } = options;

  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = async (ev) => {
      const result = ev?.target?.result;
      if (typeof result !== 'string') {
        onError?.('Failed to read file: unexpected result type');
        resolve(null);
        return;
      }

      const parts = result.split(',');
      if (parts.length < 2) {
        onError?.('Failed to read file: invalid data URL format');
        resolve(null);
        return;
      }

      const base64 = parts[1];
      const uploaded = await uploadAttachment(base64, file.name).catch((err) => {
        onError?.(`Failed to upload: ${err.message}`);
        return null;
      });

      if (uploaded) {
        const fileInfo = {
          id: uploaded.id,
          filename: uploaded.filename,
          originalName: uploaded.originalName || file.name,
          path: uploaded.path,
          size: uploaded.size,
          mimeType: uploaded.mimeType,
          // For images, create preview from the data URL
          preview: isImageFile(file.name) ? result : null,
          isImage: isImageFile(file.name)
        };
        onSuccess?.(fileInfo);
        resolve(fileInfo);
      } else {
        resolve(null);
      }
    };

    reader.onerror = () => {
      onError?.('Failed to read file');
      resolve(null);
    };

    reader.readAsDataURL(file);
  });
}

// Uploads (general file storage)
export const uploadFile = (base64Data, filename, options = {}) => request('/uploads', {
  method: 'POST',
  body: JSON.stringify({ data: base64Data, filename }),
  ...options
});
export const listUploads = (options = {}) => request('/uploads', options);
export const getUploadUrl = (filename) => `/api/uploads/${encodeURIComponent(filename)}`;
export const deleteUpload = (filename, options = {}) => request(`/uploads/${encodeURIComponent(filename)}`, { method: 'DELETE', ...options });
export const deleteAllUploads = (options = {}) => request('/uploads?confirm=true', { method: 'DELETE', ...options });

// Image Cleaner — composable opt-in pipeline (metadata strip and/or denoise).
// Uploads the RAW image bytes (no base64 inflation) with the step selection in
// the query string; the cleaned bytes come back as the response body and the
// per-step report rides in the `X-Clean-Report` header. Bypasses request()
// because that helper assumes a JSON response and can't surface a Blob body +
// custom header. Returns `{ blob, mimeType, report }`. Throws on failure so the
// page's own catch can toast (no silent flag needed — this never double-toasts).
//
// `steps` is `{ metadata?: boolean, denoise?: boolean, diffusion?: 'off'|'light'|'gpu',
//   mask?: Blob, feather?: number, strength?: number, maxMp?: number }`.
// metadata/denoise default on the server (metadata ON, denoise OFF); diffusion
// defaults to 'off'. 'light' runs the CPU spatial SynthID-disruption pass;
// 'gpu' (the FLUX round-trip) is GPU-serialized: the server returns HTTP 202
// with a `{ mode:'gpu', jobId, ... }` JSON body instead of image bytes. This
// wrapper detects that and returns `{ gpu: true, job }` so the caller can track
// progress via the media-job channel and then fetch the result (see
// `fetchCleanResult` / `saveCleanResult` below). `strength`/`maxMp` are
// GPU-only diffusion knobs, ignored by the sync passes.
//
// When a `mask` Blob (a painted preserve-region PNG) is supplied AND a diffusion
// step runs, the body is framed as an ignore-zone envelope
// `<uint32 BE maskLen><mask bytes><image bytes>` (no multipart dependency) and
// `?mask=1&feather=<px>` is added. The server composites the ORIGINAL pixels
// back into the masked regions (feathered edge) over the diffused result.
export const cleanImage = async (file, steps = {}) => {
  const params = new URLSearchParams();
  if (typeof steps.metadata === 'boolean') params.set('metadata', steps.metadata ? '1' : '0');
  if (typeof steps.denoise === 'boolean') params.set('denoise', steps.denoise ? '1' : '0');
  if (typeof steps.diffusion === 'string' && steps.diffusion !== 'off') params.set('diffusion', steps.diffusion);
  if (typeof steps.strength === 'number') params.set('strength', String(steps.strength));
  if (typeof steps.maxMp === 'number') params.set('maxMp', String(steps.maxMp));

  // Build the request body. With a mask + a diffusion step, prefix the raw image
  // bytes with the length-framed mask; otherwise send the file directly.
  let body = file;
  const diffusionOn = typeof steps.diffusion === 'string' && steps.diffusion !== 'off';
  if (steps.mask && diffusionOn) {
    const [maskBytes, imageBytes] = await Promise.all([
      steps.mask.arrayBuffer(),
      file.arrayBuffer(),
    ]);
    const lenPrefix = new Uint8Array(4);
    new DataView(lenPrefix.buffer).setUint32(0, maskBytes.byteLength, false);
    body = new Blob([lenPrefix, maskBytes, imageBytes]);
    params.set('mask', '1');
    if (typeof steps.feather === 'number') params.set('feather', String(steps.feather));
  }
  const qs = params.toString();

  // Always send application/octet-stream rather than the browser's reported
  // file.type. The server sniffs the real format from magic bytes, so a file
  // the page accepted by extension despite an unreliable MIME (image/jpg,
  // image/pjpeg, text/plain, or empty) must not be forwarded with a type the
  // route's express.raw() type-filter would refuse to parse — that would fail
  // with an empty body before the magic-byte sniff ever runs. octet-stream is
  // always in the parser's accepted set.
  const response = await fetch(`${API_BASE}/image-clean${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  }).catch(() => null);

  if (!response) throw new Error('Server unreachable — check your connection and try again');

  if (!response.ok) {
    await throwApiError(response);
  }

  // GPU FLUX round-trip: the server enqueued a job and returned 202 + JSON
  // (no image bytes). Hand the job descriptor back so the caller tracks progress
  // and fetches the result when it completes.
  if (response.status === 202) {
    const job = await response.json().catch(() => null);
    return { gpu: true, job };
  }

  const reportHeader = response.headers.get('X-Clean-Report');
  let report = null;
  if (reportHeader) { try { report = JSON.parse(reportHeader); } catch { report = null; } }
  const blob = await response.blob();
  return { blob, mimeType: blob.type || report?.format || 'application/octet-stream', report };
};

// Fetch the finished bytes for a GPU FLUX clean job (issue #2264). Returns
// `{ blob, mimeType, report }` on 200, `{ pending: true }` while the job is
// still rendering (409 RESULT_NOT_READY — the caller keeps polling the
// media-job channel), or throws on a hard failure (404/JOB_FAILED). The result
// is ephemeral; call `saveCleanResult` to keep it in the gallery.
export const fetchCleanResult = async (jobId) => {
  const response = await fetch(`${API_BASE}/image-clean/result/${encodeURIComponent(jobId)}`).catch(() => null);
  if (!response) throw new Error('Server unreachable — check your connection and try again');
  if (response.status === 409) {
    const err = await response.json().catch(() => ({}));
    if (err?.code === 'RESULT_NOT_READY') return { pending: true };
    const e = new Error(err.error || 'Clean job failed');
    e.code = err.code; e.status = 409;
    throw e;
  }
  if (!response.ok) {
    await throwApiError(response);
  }
  const reportHeader = response.headers.get('X-Clean-Report');
  let report = null;
  if (reportHeader) { try { report = JSON.parse(reportHeader); } catch { report = null; } }
  const blob = await response.blob();
  return { blob, mimeType: blob.type || 'image/png', report };
};

// Explicit save-to-gallery for a finished GPU clean result (the default is NOT
// to keep it). Returns the new gallery `{ filename, path }`. Silent so the
// page's own useAsyncAction/catch owns the error toast.
export const saveCleanResult = (jobId, options = {}) =>
  request(`/image-clean/result/${encodeURIComponent(jobId)}/save`, { method: 'POST', ...options });
