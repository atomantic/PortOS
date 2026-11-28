// Zod request schemas for the beeper routes.

import { z } from 'zod';

// The browser's own origin. Optional, so an older client (or a caller with no
// window) still gets today's request-derived behaviour.
export const oauthStartSchema = z.object({ origin: z.string().min(1).max(2048).optional() }).strict();

export const scopeIdSchema = z.object({ id: z.string().uuid() });

// A query-string boolean is a STRING, so `z.coerce.boolean()` is wrong here:
// it maps the literal "false" to `true`. Omission stays `undefined`, which the
// service reads as "do not filter on this at all" — a different query from
// `false` (root AGENTS.md, absent-vs-empty).
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true').optional();

export const conversationListQuerySchema = z.object({
  network: z.string().min(1).max(100).optional(),
  unreadOnly: queryBoolean,
  archived: queryBoolean,
  lowPriority: queryBoolean,
  snoozed: queryBoolean,
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

export const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

export const conversationParamsSchema = z.object({ id: z.string().guid() });

export const archiveSchema = z.object({ archived: z.boolean() }).strict();

export const lowPrioritySchema = z.object({ lowPriority: z.boolean() }).strict();

export const createConversationSchema = z.object({
  accountId: z.string().trim().min(1).max(200),
  participantId: z.string().trim().min(1).max(500),
}).strict();

// `messageId` is Beeper's own message id (TEXT — bridges do not promise a UUID
// shape), so it is bounded and pattern-free rather than `.guid()`. It never
// becomes a path: the file is addressed by the sha256 the mirror computed.
export const attachmentParamsSchema = z.object({
  messageId: z.string().min(1).max(500),
  idx: z.coerce.number().int().min(0).max(999),
});

export const attachmentKeepSchema = z.object({ keep: z.boolean() }).strict();

export const backfillSchema = z.object({ limit: z.number().int().min(1).max(5000).optional() }).strict();
