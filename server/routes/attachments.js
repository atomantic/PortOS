/**
 * File Attachments API Routes
 * Handles generic file uploads for task attachments (not just images)
 */

import { Router } from 'express';
import { writeFile, unlink, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  ensureDir, pathExists, PATHS, RISKY_MIME_TYPES,
  sanitizeFilename, getFileExtension, getMimeType, ATTACHMENT_ALLOWED_EXTENSIONS,
} from '../lib/fileUtils.js';

const ATTACHMENTS_DIR = PATHS.cosAttachments;

const router = Router();

// Max file size: 50MB (larger than screenshots to accommodate documents)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Validate file extension is allowed for attachments.
 * Uses the strict ATTACHMENT_ALLOWED_EXTENSIONS allowlist from fileUtils.
 */
function isAllowedExtension(filename) {
  const ext = getFileExtension(filename);
  return ext && ATTACHMENT_ALLOWED_EXTENSIONS.has(ext);
}

// POST /api/attachments - Upload a file attachment (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename } = req.body;

  if (!data) {
    throw new ServerError('data is required (base64)', { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (!filename) {
    throw new ServerError('filename is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Validate extension
  if (!isAllowedExtension(filename)) {
    const allowedList = [...ATTACHMENT_ALLOWED_EXTENSIONS].join(', ');
    throw new ServerError(`File type not allowed. Supported: ${allowedList}`, { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  // Decode base64 and validate size
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    throw new ServerError(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  // Ensure attachments directory exists (ensureDir is idempotent — mkdir
  // recursive — so no existence pre-check is needed on this upload path).
  await ensureDir(ATTACHMENTS_DIR);

  const id = uuidv4();
  const safeName = sanitizeFilename(filename);
  const ext = getFileExtension(safeName);
  // Create unique filename with UUID prefix to avoid collisions
  const fname = `${id.slice(0, 8)}-${safeName}`;
  const filepath = join(ATTACHMENTS_DIR, fname);

  // Double-check path is within attachments directory (defense in depth)
  const resolvedPath = resolve(filepath);
  if (!resolvedPath.startsWith(ATTACHMENTS_DIR)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFile(filepath, buffer);

  const mimeType = getMimeType(ext);

  console.log(`📎 Attachment saved: ${fname} (${buffer.length} bytes, ${mimeType})`);

  res.json({
    id,
    filename: fname,
    originalName: filename,
    path: filepath,
    size: buffer.length,
    mimeType
  });
}));

// GET /api/attachments/:filename - Serve an attachment
router.get('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  // Sanitize filename to prevent path traversal
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(ATTACHMENTS_DIR, safeFilename);

  // Verify the resolved path is within attachments directory
  if (!filepath.startsWith(ATTACHMENTS_DIR)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!(await pathExists(filepath))) {
    throw new ServerError('Attachment not found', { status: 404, code: 'NOT_FOUND' });
  }

  const ext = getFileExtension(safeFilename);
  const mimeType = getMimeType(ext);

  res.set('X-Content-Type-Options', 'nosniff');
  if (RISKY_MIME_TYPES.has(mimeType)) {
    res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
  }

  res.type(mimeType).sendFile(filepath);
}));

// DELETE /api/attachments/:filename - Delete an attachment
router.delete('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(ATTACHMENTS_DIR, safeFilename);

  // Verify the resolved path is within attachments directory
  if (!filepath.startsWith(ATTACHMENTS_DIR)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!(await pathExists(filepath))) {
    throw new ServerError('Attachment not found', { status: 404, code: 'NOT_FOUND' });
  }

  await unlink(filepath);

  console.log(`🗑️ Attachment deleted: ${safeFilename}`);

  res.json({ success: true, filename: safeFilename });
}));

// GET /api/attachments - List all attachments (for debugging)
router.get('/', asyncHandler(async (req, res) => {
  if (!(await pathExists(ATTACHMENTS_DIR))) {
    return res.json({ attachments: [] });
  }

  const files = await readdir(ATTACHMENTS_DIR);
  const attachments = await Promise.all(files.map(async filename => {
    const filepath = join(ATTACHMENTS_DIR, filename);
    const stats = await stat(filepath);
    const ext = getFileExtension(filename);
    return {
      filename,
      path: filepath,
      size: stats.size,
      mimeType: getMimeType(ext),
      createdAt: stats.birthtime
    };
  }));

  res.json({ attachments });
}));

export default router;
