import { Router } from 'express';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, screenshotUploadBodySchema } from '../lib/validation.js';
import { PATHS, sanitizeFilename, isPathInsideDir, saveImageUpload } from '../lib/fileUtils.js';
import { MAX_SCREENSHOT_BYTES } from '../lib/uploadLimits.js';

const SCREENSHOTS_DIR = PATHS.screenshots;

const router = Router();

// Screenshots cap well below the wire limit on purpose — see lib/uploadLimits.js.
const MAX_FILE_SIZE = MAX_SCREENSHOT_BYTES;

// POST /api/screenshots - Upload a screenshot (base64)
router.post('/', asyncHandler(async (req, res) => {
  const { data, filename } = validateRequest(screenshotUploadBodySchema, req.body);

  const id = uuidv4();
  // The server UUID always prefixes the stored name: clients (camera roll,
  // screenshot tools) reuse names, and `SCREENSHOTS_DIR` is a shared bucket whose
  // files are referenced by task records, so a repeat must never replace an
  // earlier image. Sanitize BEFORE prefixing so a traversal-shaped name can't
  // swallow the prefix.
  // Shared pipeline: decode → size cap → magic-byte sniff → detected extension →
  // containment guard → write. The client-supplied mimeType is deliberately
  // ignored; the bytes decide the type.
  const saved = await saveImageUpload(SCREENSHOTS_DIR, {
    filename: `${id}-${sanitizeFilename(filename || 'screenshot')}`,
    data,
  }, { maxBytes: MAX_FILE_SIZE });

  console.log(`📸 Screenshot saved: ${saved.filename} (${saved.size} bytes)`);

  res.json({
    id,
    filename: saved.filename,
    // API-relative URL only — never the absolute FS path (leaks install layout).
    path: `/api/screenshots/${encodeURIComponent(saved.filename)}`,
    size: saved.size
  });
}));

// GET /api/screenshots/:filename - Serve a screenshot
router.get('/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  // Sanitize filename to prevent path traversal
  const safeFilename = sanitizeFilename(filename);
  const filepath = resolve(SCREENSHOTS_DIR, safeFilename);

  // Verify the resolved path is within screenshots directory
  if (!isPathInsideDir(SCREENSHOTS_DIR, filepath)) {
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
