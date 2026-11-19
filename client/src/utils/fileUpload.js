/**
 * Shared file upload utilities (DevTools Runner and CoS TasksTab screenshot/attachment uploads).
 *
 * Pure helpers only (base64 read, validation, constants), no I/O; the upload
 * orchestration (`processScreenshotUploads` / `processAttachmentUploads`) lives in `../services/apiMedia.js`.
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
 * `accept` value for attachment pickers. iOS/iPadOS pickers only understand MIME types and UTIs, so extensions alone grey out every file in the Files app; pairing them with MIME types
 * keeps desktop filtering precise and mobile usable. `processAttachmentUploads` still validates by extension, so a broader filter can't widen what uploads.
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
 * Largest raw file the upload endpoints accept. The payload is base64-encoded inside a JSON body (see `apiMedia.js`), so the express body limit is the real ceiling; anything larger
 * produces an opaque 413. Mirror of `MAX_BASE64_UPLOAD_BYTES` in `server/lib/uploadLimits.js`, which owns the derivation (the client can't import server modules); change it there first.
 */
export const JSON_UPLOAD_MAX_FILE_SIZE = 41 * 1024 * 1024;

/**
 * `accept` for the raster-image pickers (reference/init images, LoRA datasets, sprite seeds, ImageClean): image-gen backends decode PNG/JPEG/WebP only, so a broader `image/*`
 * would let a HEIC or SVG through to a confusing server failure.
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * Max screenshot size: pasted/dragged UI captures, so well below the wire limit by product choice. Mirror of `MAX_SCREENSHOT_BYTES` in `server/lib/uploadLimits.js`; `uploadLimits.test.js` keeps them in step.
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
 * The image formats the upload endpoints can magic-byte verify, a mirror of `detectImageFormat` in `server/lib/mimeTypes.js` (the client can't import it); `uploadLimits.test.js` guards drift.
 * Anything else is refused server-side with a 400, and drag-drop/paste bypass the picker's `accept`, so the check must exist here too. Distinct from `IMAGE_ACCEPT`, which is narrower (no GIF) because
 * its consumers feed image-gen backends.
 */
export const SUPPORTED_UPLOAD_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * `accept` for pickers whose file goes straight to an upload endpoint (the gallery picker's Upload button), derived from `SUPPORTED_UPLOAD_IMAGE_MIME` so the filter and
 * `validateImageFile` can't disagree. Distinct from `IMAGE_ACCEPT` (narrower, no GIF).
 */
export const UPLOAD_IMAGE_ACCEPT = SUPPORTED_UPLOAD_IMAGE_MIME.join(',');

const SUPPORTED_LABEL = 'PNG, JPEG, GIF, WebP';

/**
 * Gate a picked file as an uploadable image: a format the server accepts, within the size cap. Shared because a surface that PREVIEWS before uploading (the Shell photo composer)
 * can't get these checks from `processScreenshotUploads`, which uploads immediately.
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

// Capped by the base64-in-JSON wire limit, not an attachment rule: see JSON_UPLOAD_MAX_FILE_SIZE.
export const ATTACHMENT_MAX_FILE_SIZE = JSON_UPLOAD_MAX_FILE_SIZE;
