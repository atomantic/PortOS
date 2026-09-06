/**
 * Generic File Uploads API Routes
 * Handles file uploads to data/uploads directory
 */

import { Router } from 'express';
import { readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  pathExists, PATHS, sanitizeFilename, getFileExtension, getMimeType,
  EXTENSION_MIME_MAP, isPathInsideDir, saveBase64Upload, serveLocalFile,
  unlinkGuarded,
} from '../lib/fileUtils.js';
import { MAX_BASE64_UPLOAD_BYTES } from '../lib/uploadLimits.js';
import { validateRequest, uploadRequestSchema } from '../lib/validation.js';

const UPLOADS_DIR = PATHS.uploads;

const router = Router();

// This is the GENERIC upload bucket (recordings, gallery videos, reference
// audio, arbitrary drops from the Uploads page), so it allows every extension
// the shared MIME map knows rather than a route-specific subset like
// ATTACHMENT_ALLOWED_EXTENSIONS / SONGBOOK_ATTACHMENT_EXTENSIONS. Derived from
// the map instead of a second literal so the two can never drift.
const UPLOAD_ALLOWED_EXTENSIONS = new Set(Object.keys(EXTENSION_MIME_MAP));

// Bounded by the JSON body limit, not by any uploads-specific rule — see
// lib/uploadLimits.js.
const MAX_FILE_SIZE = MAX_BASE64_UPLOAD_BYTES;

/**
 * Format file size for display. Deliberately NOT lib/fileUtils.js's
 * `formatBytes` — that one rounds KB to whole units ("1 KB"), while the
 * `sizeFormatted` / `freedSpaceFormatted` fields this route has always
 * returned carry one decimal ("1.0 KB"), and the Uploads page renders them
 * verbatim.
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// POST /api/uploads - Upload a file (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename } = validateRequest(uploadRequestSchema, req.body);

  // Shared pipeline: allowlist → decode → size cap → `<uuid8>-name` → write.
  const saved = await saveBase64Upload(UPLOADS_DIR, { filename, data }, {
    allowedExtensions: UPLOAD_ALLOWED_EXTENSIONS,
    maxBytes: MAX_FILE_SIZE,
  });

  console.log(`📤 File uploaded: ${saved.filename} (${formatSize(saved.size)}, ${saved.mime})`);

  res.json({
    id: saved.id,
    filename: saved.filename,
    originalName: filename,
    // API-relative URL only — never the absolute FS path (leaks install layout).
    path: `/api/uploads/${encodeURIComponent(saved.filename)}`,
    size: saved.size,
    sizeFormatted: formatSize(saved.size),
    mimeType: saved.mime,
    createdAt: new Date().toISOString()
  });
}));

// GET /api/uploads - List all uploads
router.get('/', asyncHandler(async (req, res) => {
  if (!(await pathExists(UPLOADS_DIR))) {
    return res.json({ uploads: [], totalSize: 0, totalSizeFormatted: '0 B' });
  }

  const files = await readdir(UPLOADS_DIR);
  let totalSize = 0;

  const uploads = await Promise.all(files.map(async (filename) => {
    const filepath = join(UPLOADS_DIR, filename);
    const stats = await stat(filepath);
    const ext = getFileExtension(filename);
    totalSize += stats.size;

    return {
      filename,
      // API-relative URL only — never the absolute FS path (leaks install layout).
      path: `/api/uploads/${encodeURIComponent(filename)}`,
      size: stats.size,
      sizeFormatted: formatSize(stats.size),
      mimeType: getMimeType(ext),
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString()
    };
  }));

  // Sort by creation date, newest first
  uploads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    uploads,
    count: uploads.length,
    totalSize,
    totalSizeFormatted: formatSize(totalSize)
  });
}));

// GET /api/uploads/:filename - Serve a file
router.get('/:filename', asyncHandler(async (req, res) => {
  // Shared pipeline: sanitize → containment guard → existence → nosniff +
  // attachment disposition for risky MIME types → sendFile.
  await serveLocalFile(res, UPLOADS_DIR, req.params.filename, {
    missingError: { message: 'File not found', code: 'NOT_FOUND' },
  });
}));

// DELETE /api/uploads/:filename - Delete a file
router.delete('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(UPLOADS_DIR, safeFilename);

  if (!isPathInsideDir(UPLOADS_DIR, filepath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!(await pathExists(filepath))) {
    throw new ServerError('File not found', { status: 404, code: 'NOT_FOUND' });
  }

  const stats = await stat(filepath);
  await unlinkGuarded(filepath);

  console.log(`🗑️ File deleted: ${safeFilename} (${formatSize(stats.size)})`);

  res.json({ success: true, filename: safeFilename, size: stats.size });
}));

// DELETE /api/uploads - Delete all files
router.delete('/', asyncHandler(async (req, res) => {
  const { confirm } = req.query;

  if (confirm !== 'true') {
    throw new ServerError('Add ?confirm=true to delete all uploads', { status: 400, code: 'CONFIRMATION_REQUIRED' });
  }

  if (!(await pathExists(UPLOADS_DIR))) {
    return res.json({ success: true, deleted: 0, freedSpace: 0 });
  }

  const files = await readdir(UPLOADS_DIR);
  let freedSpace = 0;

  for (const filename of files) {
    const filepath = join(UPLOADS_DIR, filename);
    const stats = await stat(filepath);
    freedSpace += stats.size;
    await unlinkGuarded(filepath);
  }

  console.log(`🗑️ Cleared all uploads: ${files.length} files (${formatSize(freedSpace)})`);

  res.json({
    success: true,
    deleted: files.length,
    freedSpace,
    freedSpaceFormatted: formatSize(freedSpace)
  });
}));

export default router;
