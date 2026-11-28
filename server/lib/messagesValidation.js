// Zod schemas for the message inbox, accounts, drafts, sync, actions, and token providers.

import { z } from 'zod';
import { isValidComposePattern, MESSAGE_COMPOSE_PATTERN_DEFAULTS } from './messageSelectorDefaults.js';
import { MESSAGE_ACCOUNT_TYPES } from './messageTransport.js';

// Express turns a repeated `?k=a&k=b` into an array; every field must be scalar
// before any cache read (#13150). Value leniency (bad/absent limit) stays in parsePagination.
export const messageInboxQuerySchema = z.object({
  accountId: z.string().optional(),
  search: z.string().optional(),
  summary: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

export const messageParamsSchema = z.object({
  accountId: z.string().guid(),
  messageId: z.string().min(1)
});

export const MESSAGE_TOKEN_PROVIDERS = ['outlook', 'teams'];
export const messageSyncBodySchema = z.object({ mode: z.enum(['unread', 'full']).optional() });
export const messageFetchFullBodySchema = z.object({ force: z.boolean().default(false) });
export const messageActionBodySchema = z.object({ action: z.enum(['archive', 'delete']) });
export const messageTokenProviderBodySchema = z.object({ provider: z.enum(MESSAGE_TOKEN_PROVIDERS).optional() });

export const createAccountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(MESSAGE_ACCOUNT_TYPES),
  email: z.union([z.string().email(), z.literal('')]).optional().default(''),
  syncConfig: z.object({
    maxMessages: z.number().int().positive().optional(),
    // Per-account reply-detection ingestion (Gmail sent mail → timeline). #2796.
    ingestSent: z.boolean().optional()
  }).optional()
});

export const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  enabled: z.boolean().optional(),
  // Gmail send-as aliases (#2831). Server-populated on sync, not typically set by the
  // client; accepted here for schema parity so a round-tripped account payload validates.
  sendAsAliases: z.array(z.string()).optional(),
  syncConfig: z.object({
    maxMessages: z.number().int().positive().optional(),
    // Per-account reply-detection ingestion (Gmail sent mail → timeline). #2796.
    ingestSent: z.boolean().optional()
  }).optional()
});

export const createDraftSchema = z.object({
  accountId: z.string().guid(),
  replyToMessageId: z.string().nullish(),
  threadId: z.string().nullish(),
  to: z.array(z.string()).optional().default([]),
  cc: z.array(z.string()).optional().default([]),
  subject: z.string().optional().default(''),
  body: z.string().optional().default(''),
  generatedBy: z.enum(['ai', 'manual']).optional().default('manual'),
  sendVia: z.enum(['api', 'playwright']).optional()
});

export const updateDraftSchema = z.object({
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  status: z.enum(['draft', 'pending_review', 'approved']).optional()
});

export const reconcileDraftSchema = z.object({
  attemptId: z.string().guid(),
  outcome: z.enum(['sent', 'not_sent'])
});

export const generateDraftSchema = z.object({
  accountId: z.string().guid(),
  replyToMessageId: z.string().trim().min(1),
  threadId: z.string().nullish(),
  context: z.string().optional().default(''),
  instructions: z.string().optional().default(''),
  useVoice: z.boolean().optional()
});

export const evaluateMessagesSchema = z.object({
  accountId: z.string().guid().optional(),
  messageIds: z.array(z.string().trim().min(1).max(1024)).min(1).max(100).optional()
});

export const updateSelectorsSchema = z.object({
  selectors: z.record(z.string()).superRefine((selectors, ctx) => {
    for (const key of Object.keys(MESSAGE_COMPOSE_PATTERN_DEFAULTS)) {
      if (Object.hasOwn(selectors, key) && !isValidComposePattern(selectors[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Enter a valid regular expression.' });
      }
    }
  })
});

export const draftListQuerySchema = z.object({ accountId: z.string().optional(), status: z.string().optional() });

export const testTokenQuerySchema = z.object({ top: z.string().optional() });
