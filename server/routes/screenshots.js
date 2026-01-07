import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCREENSHOTS_DIR = join(__dirname, '../../data/screenshots');

const router = Router();

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Validate image magic bytes
function isValidImage(buffer) {
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
  const fname = filename || `screenshot-${id}.${ext}`;
  const filepath = join(SCREENSHOTS_DIR, fname);

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
  const filepath = join(SCREENSHOTS_DIR, filename);

  if (!existsSync(filepath)) {
    throw new ServerError('Screenshot not found', { status: 404, code: 'NOT_FOUND' });
  }

  const ext = filename.split('.').pop().toLowerCase();
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

  res.type(mimeType).sendFile(filepath);
}));

export default router;
