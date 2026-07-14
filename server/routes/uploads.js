/**
 * Generic File Uploads API Routes
 * Handles file uploads to data/uploads directory
 */

import { Router } from 'express';
import { writeFile, unlink, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { ensureDir, PATHS, RISKY_MIME_TYPES, sanitizeFilename, getFileExtension, getMimeType, isPathInsideDir } from '../lib/fileUtils.js';

const UPLOADS_DIR = PATHS.uploads;

const router = Router();

// Max file size: 100MB for general uploads
const MAX_FILE_SIZE = 100 * 1024 * 1024;

/**
 * Format file size for display
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// POST /api/uploads - Upload a file (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename } = req.body;

  if (!data) {
    throw new ServerError('data is required (base64)', { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (!filename) {
    throw new ServerError('filename is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Decode base64 and validate size
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    throw new ServerError(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  // Ensure uploads directory exists
  if (!existsSync(UPLOADS_DIR)) {
    await ensureDir(UPLOADS_DIR);
  }

  const id = uuidv4();
  const safeName = sanitizeFilename(filename);
  const ext = getFileExtension(safeName);
  // Create unique filename with UUID prefix to avoid collisions
  const fname = `${id.slice(0, 8)}-${safeName}`;
  const filepath = join(UPLOADS_DIR, fname);

  // Double-check path is within uploads directory (defense in depth)
  if (!isPathInsideDir(UPLOADS_DIR, filepath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFile(filepath, buffer);

  const mimeType = getMimeType(ext);

  console.log(`📤 File uploaded: ${fname} (${formatSize(buffer.length)}, ${mimeType})`);

  res.json({
    id,
    filename: fname,
    originalName: filename,
    path: `/api/uploads/${encodeURIComponent(fname)}`,
    size: buffer.length,
    sizeFormatted: formatSize(buffer.length),
    mimeType,
    createdAt: new Date().toISOString()
  });
}));

// GET /api/uploads - List all uploads
router.get('/', asyncHandler(async (req, res) => {
  if (!existsSync(UPLOADS_DIR)) {
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
  const { filename } = req.params;
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(UPLOADS_DIR, safeFilename);

  if (!isPathInsideDir(UPLOADS_DIR, filepath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!existsSync(filepath)) {
    throw new ServerError('File not found', { status: 404, code: 'NOT_FOUND' });
  }

  const ext = getFileExtension(safeFilename);
  const mimeType = getMimeType(ext);

  res.set('X-Content-Type-Options', 'nosniff');
  if (RISKY_MIME_TYPES.has(mimeType)) {
    res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
  }

  res.type(mimeType).sendFile(filepath);
}));

// DELETE /api/uploads/:filename - Delete a file
router.delete('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(UPLOADS_DIR, safeFilename);

  if (!isPathInsideDir(UPLOADS_DIR, filepath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!existsSync(filepath)) {
    throw new ServerError('File not found', { status: 404, code: 'NOT_FOUND' });
  }

  const stats = await stat(filepath);
  await unlink(filepath);

  console.log(`🗑️ File deleted: ${safeFilename} (${formatSize(stats.size)})`);

  res.json({ success: true, filename: safeFilename, size: stats.size });
}));

// DELETE /api/uploads - Delete all files
router.delete('/', asyncHandler(async (req, res) => {
  const { confirm } = req.query;

  if (confirm !== 'true') {
    throw new ServerError('Add ?confirm=true to delete all uploads', { status: 400, code: 'CONFIRMATION_REQUIRED' });
  }

  if (!existsSync(UPLOADS_DIR)) {
    return res.json({ success: true, deleted: 0, freedSpace: 0 });
  }

  const files = await readdir(UPLOADS_DIR);
  let freedSpace = 0;

  for (const filename of files) {
    const filepath = join(UPLOADS_DIR, filename);
    const stats = await stat(filepath);
    freedSpace += stats.size;
    await unlink(filepath);
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
