import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCREENSHOTS_DIR = resolve(__dirname, '../../data/screenshots');

const router = Router();

/**
 * Validate and sanitize filename to prevent path traversal
 * @param {string} filename - User-provided filename
 * @returns {string} - Safe filename
 */
function sanitizeFilename(filename) {
  // Get just the base filename, removing any path components
  const base = basename(filename);
  // Remove any remaining path traversal attempts or special characters
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Ensure it doesn't start with a dot (hidden files)
  if (sanitized.startsWith('.')) {
    return '_' + sanitized.slice(1);
  }
  return sanitized;
}

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Validate image magic bytes
 * Note: This validates the file signature/magic bytes at the start of the file.
 * It does NOT validate the entire file structure - a file could have valid magic
 * bytes but malformed content. This is sufficient for basic type detection and
 * blocking non-image uploads. For high-security scenarios, consider using a
 * proper image processing library to fully validate the file structure.
 */
function isValidImage(buffer) {
  if (buffer.length < 12) return null; // Too small to be a valid image
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpg';
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }
  return null;
}

// POST /api/screenshots - Upload a screenshot (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename, mimeType } = req.body;

  if (!data) {
    throw new ServerError('data is required (base64)', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Decode base64 and validate size
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    throw new ServerError(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  // Validate actual file content (magic bytes)
  const detectedType = isValidImage(buffer);
  if (!detectedType) {
    throw new ServerError('Invalid image file - only PNG, JPEG, GIF, and WebP are supported', { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  // Ensure screenshots directory exists
  if (!existsSync(SCREENSHOTS_DIR)) {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
  }

  const id = uuidv4();
  const ext = detectedType; // Use detected type, not client-provided
  // Sanitize user-provided filename or generate a safe one
  const safeName = filename ? sanitizeFilename(filename) : `screenshot-${id}.${ext}`;
  // Ensure extension matches detected type
  const fname = safeName.endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`;
  const filepath = join(SCREENSHOTS_DIR, fname);

  // Double-check path is within screenshots directory (defense in depth)
  const resolvedPath = resolve(filepath);
  if (!resolvedPath.startsWith(SCREENSHOTS_DIR)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFile(filepath, buffer);

  console.log(`📸 Screenshot saved: ${fname} (${buffer.length} bytes)`);

  res.json({
    id,
    filename: fname,
    path: filepath,
    size: buffer.length
  });
}));

// GET /api/screenshots/:filename - Serve a screenshot
router.get('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  // Sanitize filename to prevent path traversal
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(SCREENSHOTS_DIR, safeFilename);

  // Verify the resolved path is within screenshots directory
  if (!filepath.startsWith(SCREENSHOTS_DIR)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!existsSync(filepath)) {
    throw new ServerError('Screenshot not found', { status: 404, code: 'NOT_FOUND' });
  }

  const ext = safeFilename.split('.').pop().toLowerCase();
  const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';

  res.type(mimeType).sendFile(filepath);
}));

export default router;
