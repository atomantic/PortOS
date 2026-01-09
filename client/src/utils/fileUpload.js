/**
 * Shared file upload utilities
 * Used by DevTools Runner and CoS TasksTab for screenshot uploads
 */

import * as api from '../services/api';

// Default max file size: 10MB
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

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
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    onSuccess,
    onError
  } = options;

  const fileArray = Array.from(files);

  for (const file of fileArray) {
    // Skip non-image files silently
    if (!file.type.startsWith('image/')) continue;

    // Check file size
    if (file.size > maxFileSize) {
      const sizeMB = Math.round(maxFileSize / (1024 * 1024));
      onError?.(`File "${file.name}" exceeds ${sizeMB}MB limit`);
      continue;
    }

    await uploadScreenshotFile(file, { onSuccess, onError });
  }
}

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
      const uploaded = await api.uploadScreenshot(base64, file.name, file.type).catch((err) => {
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
