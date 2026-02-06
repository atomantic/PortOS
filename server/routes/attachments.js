/**
 * File Attachments API Routes
 * Handles generic file uploads for task attachments (not just images)
 */

import { Router } from 'express';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ATTACHMENTS_DIR = resolve(__dirname, '../../data/cos/attachments');

const router = Router();

// Max file size: 50MB (larger than screenshots to accommodate documents)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Allowed file extensions and their MIME types
const ALLOWED_EXTENSIONS = {
  // Documents
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  // Documents
  '.pdf': 'application/pdf',
  // Code
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/javascript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.html': 'text/html',
  '.css': 'text/css',
  // Archives (useful for providing multiple files)
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip'
};

/**
 * Validate and sanitize filename to prevent path traversal
 * @param {string} filename - User-provided filename
 * @returns {string} - Safe filename
 */
function sanitizeFilename(filename) {
  const base = basename(filename);
  // Replace problematic characters but keep extension dots
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Ensure it doesn't start with a dot (hidden files)
  if (sanitized.startsWith('.')) {
    return '_' + sanitized.slice(1);
  }
  return sanitized;
}

/**
 * Get file extension, normalized to lowercase with leading dot
 */
function getExtension(filename) {
  const ext = extname(filename).toLowerCase();
  return ext || null;
}

/**
 * Validate file extension is allowed
 */
function isAllowedExtension(filename) {
  const ext = getExtension(filename);
  return ext && ALLOWED_EXTENSIONS[ext];
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
    const allowedList = Object.keys(ALLOWED_EXTENSIONS).join(', ');
    throw new ServerError(`File type not allowed. Supported: ${allowedList}`, { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  // Decode base64 and validate size
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    throw new ServerError(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  // Ensure attachments directory exists
  if (!existsSync(ATTACHMENTS_DIR)) {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
  }

  const id = uuidv4();
  const safeName = sanitizeFilename(filename);
  const ext = getExtension(safeName);
  // Create unique filename with UUID prefix to avoid collisions
  const fname = `${id.slice(0, 8)}-${safeName}`;
  const filepath = join(ATTACHMENTS_DIR, fname);

  // Double-check path is within attachments directory (defense in depth)
  const resolvedPath = resolve(filepath);
  if (!resolvedPath.startsWith(ATTACHMENTS_DIR)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFile(filepath, buffer);

  const mimeType = ALLOWED_EXTENSIONS[ext] || 'application/octet-stream';

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

  if (!existsSync(filepath)) {
    throw new ServerError('Attachment not found', { status: 404, code: 'NOT_FOUND' });
  }

  const ext = getExtension(safeFilename);
  const mimeType = ALLOWED_EXTENSIONS[ext] || 'application/octet-stream';

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

  if (!existsSync(filepath)) {
    throw new ServerError('Attachment not found', { status: 404, code: 'NOT_FOUND' });
  }

  await unlink(filepath);

  console.log(`🗑️ Attachment deleted: ${safeFilename}`);

  res.json({ success: true, filename: safeFilename });
}));

// GET /api/attachments - List all attachments (for debugging)
router.get('/', asyncHandler(async (req, res) => {
  const { readdirSync, statSync } = await import('fs');

  if (!existsSync(ATTACHMENTS_DIR)) {
    return res.json({ attachments: [] });
  }

  const files = readdirSync(ATTACHMENTS_DIR);
  const attachments = files.map(filename => {
    const filepath = join(ATTACHMENTS_DIR, filename);
    const stats = statSync(filepath);
    const ext = getExtension(filename);
    return {
      filename,
      path: filepath,
      size: stats.size,
      mimeType: ALLOWED_EXTENSIONS[ext] || 'application/octet-stream',
      createdAt: stats.birthtime
    };
  });

  res.json({ attachments });
}));

export default router;
