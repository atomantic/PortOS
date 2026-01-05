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

// POST /api/screenshots - Upload a screenshot (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename, mimeType } = req.body;

  if (!data) {
    throw new ServerError('data is required (base64)', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Ensure screenshots directory exists
  if (!existsSync(SCREENSHOTS_DIR)) {
    await mkdir(SCREENSHOTS_DIR, { recursive: true });
  }

  const id = uuidv4();
  const ext = mimeType?.includes('png') ? 'png' : 'jpg';
  const fname = filename || `screenshot-${id}.${ext}`;
  const filepath = join(SCREENSHOTS_DIR, fname);

  // Decode base64 and write file
  const buffer = Buffer.from(data, 'base64');
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
