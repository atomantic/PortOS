// Shared production inbox route, without sync, send, browser or AI endpoints.
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { parsePagination } from '../lib/validation.js';
import { UUID_RE } from '../lib/fileUtils.js';
import * as messageSync from '../services/messageSync.js';

export const messageInboxRead = asyncHandler(async (req, res) => {
  const { accountId, search } = req.query;
  if (accountId && !UUID_RE.test(accountId)) {
    throw new ServerError('Invalid accountId format', { status: 400 });
  }
  const { limit: parsedLimit, offset: parsedOffset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
  const result = await messageSync.getMessages({
    accountId,
    search,
    summary: req.query.summary === 'true',
    limit: parsedLimit,
    offset: parsedOffset
  });
  res.json(result);
});


export const messageParamsSchema = z.object({
  accountId: z.string().guid(),
  messageId: z.string().min(1)
});

export const messageDetailRead = asyncHandler(async (req, res) => {
  const parsed = messageParamsSchema.safeParse(req.params);
  if (!parsed.success) throw new ServerError('Invalid accountId or messageId format', { status: 400 });
  const message = await messageSync.getMessage(parsed.data.accountId, parsed.data.messageId);
  if (!message) throw new ServerError('Message not found', { status: 404 });
  res.json(message);
});
