/**
 * File Attachments API Routes
 * Handles generic file uploads for task attachments (not just images)
 */

import { Router } from 'express';
import { unlink, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  pathExists, PATHS, sanitizeFilename, getFileExtension, getMimeType,
  ATTACHMENT_ALLOWED_EXTENSIONS, isPathInsideDir, saveBase64Upload, serveLocalFile,
} from '../lib/fileUtils.js';

const ATTACHMENTS_DIR = PATHS.cosAttachments;

const router = Router();

// Max file size: 50MB (larger than screenshots to accommodate documents)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// POST /api/attachments - Upload a file attachment (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename } = req.body;

  if (!data) {
    throw new ServerError('data is required (base64)', { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (!filename) {
    throw new ServerError('filename is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Shared pipeline: allowlist → decode → size cap → `<uuid8>-name` → write.
  const saved = await saveBase64Upload(ATTACHMENTS_DIR, { filename, data }, {
    allowedExtensions: ATTACHMENT_ALLOWED_EXTENSIONS,
    maxBytes: MAX_FILE_SIZE,
  });

  console.log(`📎 Attachment saved: ${saved.filename} (${saved.size} bytes, ${saved.mime})`);

  res.json({
    id: saved.id,
    filename: saved.filename,
    originalName: filename,
    // API-relative URL only — never the absolute FS path (leaks install layout).
    path: `/api/attachments/${encodeURIComponent(saved.filename)}`,
    size: saved.size,
    mimeType: saved.mime
  });
}));

// GET /api/attachments/:filename - Serve an attachment
router.get('/:filename', asyncHandler(async (req, res) => {
  await serveLocalFile(res, ATTACHMENTS_DIR, req.params.filename);
}));

// DELETE /api/attachments/:filename - Delete an attachment
router.delete('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(ATTACHMENTS_DIR, safeFilename);

  // Verify the resolved path is within attachments directory
  if (!isPathInsideDir(ATTACHMENTS_DIR, filepath)) {
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
      // API-relative URL only — never the absolute FS path (leaks install layout).
      path: `/api/attachments/${encodeURIComponent(filename)}`,
      size: stats.size,
      mimeType: getMimeType(ext),
      createdAt: stats.birthtime
    };
  }));

  res.json({ attachments });
}));

export default router;
