/**
 * Shell image drop — hand a photo to whatever is running in a shell session (a
 * live `claude` / `codex` TUI, or a bare prompt).
 *
 * Agent CLIs read images off disk, so the way to actually get a photo in front of
 * one is to put the file's absolute path into its prompt. This module owns that
 * translation: it persists the uploaded bytes, then bracket-pastes
 * `<message>\n<absolute path>` into the session so the agent sees one input event.
 *
 * The path never leaves the server — the API answers with the stored filename
 * only, so a response can't leak the install layout.
 *
 * Storage is `PATHS.screenshots`, the existing "user-supplied image an AI reads
 * off disk" bucket (shared with the vision-test and universe-describe paths, and
 * already archivable/deletable via dataManager). Because it IS shared, the name
 * is uniquified here: a phone camera roll hands out the same `IMG_0001.jpg` over
 * and over, and a second drop must not overwrite bytes the agent hasn't read yet.
 */

import { PATHS, saveImageUpload, unlinkGuarded } from '../lib/fileUtils.js';
import { MAX_SCREENSHOT_BYTES } from '../lib/uploadLimits.js';
import { ServerError } from '../lib/errorHandler.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getSession, pasteToSession } from './shell.js';

/**
 * Compose the text pasted into the session.
 *
 * The message comes first and the path lands on its own line, so a model reads it
 * as "here's the ask, here's the file". Paths containing whitespace are
 * single-quoted (POSIX-escaped): the filename can't contain whitespace after
 * `sanitizeFilename`, but the install root can.
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
 * Save an uploaded image and paste it (plus an optional message) into a live
 * shell session.
 *
 * The session is checked BEFORE the bytes are written so a stale session id
 * doesn't leave an orphan file on disk.
 *
 * @param {object} params
 * @param {string} params.sessionId - target shell session
 * @param {string} params.filename - client-supplied name (used for the stored
 *   name's readable suffix only; the extension comes from the bytes)
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

  // Re-check liveness: the PTY can exit while the bytes are being written. Drop
  // the file we just wrote — nothing will ever read it, and this bucket is shared
  // with the screenshot uploads, so an orphan here is indistinguishable from a
  // real one. Best-effort: a failed unlink must not mask the 404.
  if (!pasteToSession(sessionId, buildImageDropText(saved.filePath, message), { label: 'image drop' })) {
    await unlinkGuarded(saved.filePath).catch(() => {});
    throw new ServerError('Session not found', { status: 404, code: 'NOT_FOUND' });
  }

  console.log(`🖼️ Sent image ${saved.filename} to shell session ${sessionId.slice(0, 8)}`);

  return { sessionId, filename: saved.filename };
}
