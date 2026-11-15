/**
 * Shared file upload utilities
 * Used by DevTools Runner and CoS TasksTab for screenshot and attachment uploads
 *
 * This module holds only pure helpers (base64 read, validation, constants) —
 * no I/O. The upload orchestration that actually POSTs to the server
 * (`processScreenshotUploads` / `processAttachmentUploads`) lives in
 * `../services/apiMedia.js`; import those from there directly.
 */

import { formatBytes } from './formatters';

// Allowed attachment extensions (should match server)
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.pdf',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.sh', '.sql', '.html', '.css',
  '.zip', '.tar', '.gz'
];

/**
 * `accept` value for attachment pickers.
 *
 * Extensions alone are not enough: iOS/iPadOS pickers only understand MIME
 * types and UTIs, so an extension-only `accept` greys out every file in the
 * Files app — the picker opens but nothing can be selected. Pairing the
 * extensions with the corresponding MIME types keeps desktop filtering precise
 * while leaving mobile pickers usable. `processAttachmentUploads` still
 * validates by extension, so a broader picker filter can't widen what uploads.
 */
export const ATTACHMENT_ACCEPT = [
  ...ALLOWED_ATTACHMENT_EXTENSIONS,
  'text/*',
  'image/*',
  'application/pdf',
  'application/json',
  'application/zip',
  'application/gzip',
  'application/x-tar'
].join(',');

/**
 * Largest raw file the upload endpoints can accept. Callers POST the payload
 * base64-encoded inside a JSON body (see `apiMedia.js`), so the express body
 * limit is the real ceiling — advertising anything larger just produces an
 * opaque 413. This module itself does no I/O.
 *
 * Mirror of `MAX_BASE64_UPLOAD_BYTES` in `server/lib/uploadLimits.js`, which
 * owns the derivation and the rationale (the client can't import server
 * modules). Change it there first.
 */
export const JSON_UPLOAD_MAX_FILE_SIZE = 41 * 1024 * 1024;

/**
 * `accept` for the raster-image pickers (reference images, init images, LoRA
 * dataset uploads, sprite seeds, ImageClean). These are all fed to image-gen
 * backends that decode PNG/JPEG/WebP only — a broader `image/*` would let a
 * HEIC or SVG through to a confusing server-side failure.
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * Max screenshot size. Screenshots are pasted/dragged UI captures, so this sits
 * well below the wire limit by product choice, not by encoding math. Mirror of
 * `MAX_SCREENSHOT_BYTES` in `server/lib/uploadLimits.js`; `uploadLimits.test.js`
 * keeps the two in step.
 */
export const SCREENSHOT_MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Read a File as a base64 string (without the data URL prefix)
 * @param {File} file - File to read
 * @returns {Promise<string>} Base64-encoded file contents
 */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex !== -1 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * The image formats the upload endpoints can magic-byte verify — a mirror of
 * `detectImageFormat` in `server/lib/fileUtils.js`, which the client can't import.
 * Anything else is refused server-side with a 400, so the check has to exist here
 * too: a drag-drop or a clipboard paste bypasses the picker's `accept` entirely,
 * and without this an AVIF or SVG previews happily and only fails AFTER the user
 * has typed their message. `uploadLimits.test.js` guards the two lists against
 * drift.
 *
 * Distinct from `IMAGE_ACCEPT`, which is narrower on purpose (no GIF) because its
 * consumers feed image-gen backends rather than this upload pipeline.
 */
export const SUPPORTED_UPLOAD_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * `accept` for pickers whose file goes straight to an upload endpoint (the
 * gallery picker's Upload button). Derived from `SUPPORTED_UPLOAD_IMAGE_MIME` so
 * the picker filter and `validateImageFile` can never disagree about which
 * formats are allowed.
 *
 * Distinct from `IMAGE_ACCEPT`, which is narrower (no GIF) because its consumers
 * feed image-gen backends rather than this upload pipeline.
 */
export const UPLOAD_IMAGE_ACCEPT = SUPPORTED_UPLOAD_IMAGE_MIME.join(',');

const SUPPORTED_LABEL = 'PNG, JPEG, GIF, WebP';

/**
 * Gate a picked file as an uploadable image: a format the server accepts, within
 * the size cap.
 *
 * Every image picker in the app needs these checks, and a surface that PREVIEWS
 * before uploading (the Shell photo composer) can't get them from
 * `processScreenshotUploads`, which uploads immediately. So it lives here and both
 * call it, keeping one wording for the messages.
 *
 * @param {File} file
 * @param {number} [maxFileSize] - byte ceiling (default: the screenshot cap)
 * @returns {string|null} an error message, or null when the file is acceptable
 */
export function validateImageFile(file, maxFileSize = SCREENSHOT_MAX_FILE_SIZE) {
  if (!file?.type?.startsWith('image/')) return `File "${file?.name}" is not an image`;
  if (!SUPPORTED_UPLOAD_IMAGE_MIME.includes(file.type)) {
    return `File "${file.name}" is a ${file.type.replace('image/', '').toUpperCase()} — supported: ${SUPPORTED_LABEL}`;
  }
  if (file.size > maxFileSize) return `File "${file.name}" exceeds the ${formatBytes(maxFileSize)} limit`;
  return null;
}

// Max file size for attachments. Capped by the base64-in-JSON wire limit, not
// by any attachment-specific rule — see JSON_UPLOAD_MAX_FILE_SIZE.
export const ATTACHMENT_MAX_FILE_SIZE = JSON_UPLOAD_MAX_FILE_SIZE;
