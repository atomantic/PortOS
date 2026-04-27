/**
 * Brain Import Routes
 *
 * Guided workflows for pulling content from third-party sources into the
 * digital brain. Currently supports ChatGPT data exports
 * (`conversations.json`).
 *
 * Endpoints:
 *   GET  /api/brain/import/sources         List available import sources
 *   POST /api/brain/import/chatgpt/preview Validate + summarize a parsed payload
 *   POST /api/brain/import/chatgpt         Run the import, returning per-conversation results
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { parseExport, stripPreview, importConversations } from '../services/chatgptImport.js';

const router = Router();

const SOURCES = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    status: 'available',
    description: 'Import every conversation from your ChatGPT data export.',
    fileExpected: 'conversations.json',
    helpUrl: 'https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data',
    instructions: [
      'Open chatgpt.com → Settings → Data Controls → Export data → Confirm export.',
      'OpenAI emails you a download link within a few minutes (link expires in 24h).',
      'Download the ZIP and extract it on your machine.',
      'Upload the `conversations.json` file from the extracted folder using this wizard.'
    ]
  }
];

router.get('/sources', asyncHandler(async (_req, res) => {
  res.json({ sources: SOURCES });
}));

const previewSchema = z.object({
  data: z.unknown()
});

const importSchema = z.object({
  data: z.unknown(),
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
  skipEmpty: z.boolean().optional()
});

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
  console.log(`✅ ChatGPT import complete: imported=${result.imported} skipped=${result.skipped} archived=${result.archived}`);
  res.json(result);
}));

export default router;
