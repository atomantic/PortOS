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
    limit: parsedLimit,
    offset: parsedOffset
  });
  // Summary is opt-in so older clients and automation retain the full-record
  // contract. Search and pagination above still run against the full cache.
  res.json(req.query.summary === 'true' ? {
    ...result,
    messages: result.messages.map(message => ({
      id: message.id,
      accountId: message.accountId,
      externalId: message.externalId,
      threadId: message.threadId,
      subject: message.subject,
      from: message.from && { name: message.from.name, email: message.from.email },
      date: message.date,
      source: message.source,
      isRead: message.isRead,
      isUnread: message.isUnread,
      isPinned: message.isPinned,
      isFlagged: message.isFlagged,
      preview: typeof message.bodyText === 'string' ? message.bodyText.slice(0, 100) : '',
      evaluation: message.evaluation && {
        action: message.evaluation.action,
        priority: message.evaluation.priority,
      },
    })),
  } : result);
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
