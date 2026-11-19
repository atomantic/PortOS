/**
 * Shell image drop: persist an uploaded photo and bracket-paste `<message>\n<absolute path>`
 * into a shell session (agent CLIs read images off disk). Responses carry only the stored
 * filename. The shared `PATHS.screenshots` bucket needs uniquified names (repeated `IMG_0001.jpg`).
 */

import { PATHS, unlinkGuarded } from '../lib/fileUtils.js';
import { saveImageUpload } from '../lib/uploads.js';
import { MAX_SCREENSHOT_BYTES } from '../lib/uploadLimits.js';
import { ServerError } from '../lib/errorHandler.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getSession, pasteToSession } from './shell.js';

/**
 * Compose the pasted text: message first, path on its own line, single-quoted if it contains whitespace.
 *
 * @param {string} imagePath - absolute path to the saved image
 * @param {string} [message] - optional accompanying message
 * @returns {string} paste payload (no trailing newline — the Enter submits it)
 */
export function buildImageDropText(imagePath, message = '') {
  const trimmed = typeof message === 'string' ? message.trim() : '';
  const pathRef = /\s/.test(imagePath)
    ? `'${imagePath.replace(/'/g, "'\\''")}'`
    : imagePath;
  return trimmed ? `${trimmed}\n${pathRef}` : pathRef;
}

/**
 * Save an uploaded image and paste it (plus an optional message) into a live shell session.
 * The session is checked BEFORE the bytes are written so a stale id leaves no orphan file.
 *
 * @param {object} params
 * @param {string} params.sessionId - target shell session
 * @param {string} params.filename - client-supplied name (readable suffix only)
 * @param {string} params.data - base64-encoded image bytes
 * @param {string} [params.message] - message to send alongside the image
 * @returns {Promise<{ sessionId: string, filename: string }>} the STORED filename
 * @throws {ServerError} 404 when the session is gone; 400 from `saveImageUpload`
 *   when the bytes are too large or aren't a supported image
 */
export async function dropImageIntoShellSession({ sessionId, filename, data, message = '' }) {
  if (!getSession(sessionId)) {
    throw new ServerError('Session not found', { status: 404, code: 'NOT_FOUND' });
  }

  const saved = await saveImageUpload(PATHS.screenshots, {
    filename: `shell-${uuidv4().slice(0, 8)}-${filename}`,
    data,
  }, { maxBytes: MAX_SCREENSHOT_BYTES });

  // The PTY can exit during the write: drop the orphan (shared bucket). A failed unlink must not mask the 404.
  if (!pasteToSession(sessionId, buildImageDropText(saved.filePath, message), { label: 'image drop' })) {
    await unlinkGuarded(saved.filePath).catch(() => {});
    throw new ServerError('Session not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`🖼️ Sent image ${saved.filename} to shell session ${sessionId.slice(0, 8)}`);

  return { sessionId, filename: saved.filename };
}
