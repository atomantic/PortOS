/**
 * Brain Import Routes
 *
 * Guided workflows for pulling content from third-party sources into the
 * digital brain. Currently supports ChatGPT data exports — both the legacy
 * single `conversations.json` (parsed in the browser, POSTed as JSON) and the
 * modern multi-file ZIP export (streamed up whole and extracted server-side,
 * which also ingests image / voice-audio / PDF assets).
 *
 * Endpoints:
 *   POST /api/brain/import/chatgpt/preview    Validate + summarize a parsed JSON payload
 *   POST /api/brain/import/chatgpt            Run a JSON-payload import
 *   POST /api/brain/import/chatgpt/zip        Stream-upload + import a full export ZIP
 *   GET  /api/brain/import/chatgpt/archive/:name  Fetch one archived conversation transcript
 */

import { previewSchema, importSchema } from '../lib/brainImportValidation.js';
import { markdownImages } from '../lib/markdownImages.js';
import { Router } from 'express';
import { unlink } from 'fs/promises';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { chatgptArchiveQuerySchema } from '../lib/brainValidation.js';
import { uploadSingle } from '../lib/multipart.js';
import { parseExport, stripPreview, importConversations, readArchivedConversation } from '../services/chatgptImport.js';
import { importChatgptZip } from '../services/chatgptZipImport.js';

const router = Router();

router.post('/chatgpt/preview', asyncHandler(async (req, res) => {
  const { data } = validateRequest(previewSchema, req.body);
  const parsed = parseExport(data);
  if (!parsed.ok) {
    throw new ServerError(parsed.error, { status: 400, code: 'INVALID_CHATGPT_EXPORT' });
  }
  console.log(`📥 ChatGPT import preview: ${parsed.summary.totalConversations} conversations, ${parsed.summary.totalMessages} messages`);
  res.json(stripPreview(parsed));
}));

router.post('/chatgpt', asyncHandler(async (req, res) => {
  const { data, tags, skipEmpty } = validateRequest(importSchema, req.body);
  const parsed = parseExport(data);
  if (!parsed.ok) {
    throw new ServerError(parsed.error, { status: 400, code: 'INVALID_CHATGPT_EXPORT' });
  }
  console.log(`📥 ChatGPT import start: ${parsed.summary.totalConversations} conversations`);
  const result = await importConversations(parsed, { tags, skipEmpty });
  console.log(`✅ ChatGPT import complete: imported=${result.imported} updated=${result.updated} unchanged=${result.unchanged} skipped=${result.skipped} archived=${result.archived}`);
  res.json(result);
}));

// Stream the whole export ZIP up (no JSON-body size cap — mirrors the Apple
// Health importer). 2 GB ceiling; the file is written to a temp path by the
// streaming multipart parser and removed once the import finishes.
const uploadZip = uploadSingle('file', {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true);
    else cb(new ServerError('Upload the ChatGPT export .zip file.', { status: 400, code: 'BAD_REQUEST' }));
  }
});

router.post('/chatgpt/zip', uploadZip, asyncHandler(async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });

  // `tags` arrives as a multipart text field — a comma-separated string.
  const tags = String(req.body?.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
  const skipEmpty = req.body?.skipEmpty !== 'false';

  console.log(`📥 ChatGPT ZIP import start: upload (${req.file.size} bytes)`);
  try {
    const result = await importChatgptZip(filePath, { tags: tags.length ? tags : undefined, skipEmpty });
    if (!result.ok) {
      throw new ServerError(result.error, { status: 400, code: 'INVALID_CHATGPT_EXPORT' });
    }
    console.log(`✅ ChatGPT ZIP import complete: imported=${result.imported} updated=${result.updated} unchanged=${result.unchanged} skipped=${result.skipped} assets=${result.assetStats?.assetCount}`);
    res.json(result);
  } finally {
    await unlink(filePath).catch(() => {});
  }
}));

// Fetch one archived conversation's full transcript + structured messages for
// the Memory conversation viewer (the Memory record itself stores a truncated
// preview; the archive holds the complete thread).
router.get('/chatgpt/archive/:name', asyncHandler(async (req, res) => {
  const { preview } = validateRequest(chatgptArchiveQuerySchema, req.query);
  const archived = await readArchivedConversation(req.params.name);
  if (!archived) {
    throw new ServerError('Archived conversation not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(preview === 'images' ? { images: markdownImages(archived.transcript) } : archived);
}));

export default router;
