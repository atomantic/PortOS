// Zod request schemas for the tribe routes.

import { paginationQuerySchema } from './queryValidation.js';
import { z } from 'zod';
import { partialWithoutDefaults } from './zodCompat.js';

const ringSchema = z.enum(['support', 'core', 'tribe', 'village', 'external']);

const energySchema = z.enum(['nourishing', 'steady', 'complex', 'draining']);

export const personSchema = z.object({
  id: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  relationship: z.string().max(200).optional().default(''),
  ring: ringSchema.optional().default('tribe'),
  cadenceDays: z.number().int().min(1).max(3650).optional(),
  lastContact: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  channel: z.string().max(200).optional().default(''),
  energy: energySchema.optional().default('steady'),
  tags: z.array(z.string().max(80)).max(50).optional().default([]),
  // Known emails/handles used to auto-match calendar attendees / message
  // counterparts to this person (#2033). Service-side `normalizeEmails` lowercases
  // and de-duplicates; the UI splits its single-line input to an array like tags.
  emails: z.array(z.string().max(320)).max(100).optional().default([]),
  // Known phone handles used to auto-match iMessage/Signal counterparts to this
  // person (#2151). Service-side `normalizePhones` E.164-normalizes and
  // de-duplicates; the UI splits its single-line input to an array like tags.
  phones: z.array(z.string().max(40)).max(100).optional().default([]),
  nextMove: z.string().max(2000).optional().default(''),
  notes: z.string().max(10000).optional().default(''),
});

export const personUpdateSchema = partialWithoutDefaults(personSchema).extend({
  id: z.never().optional(),
});

export const touchpointSchema = z.object({
  happenedAt: z.string().datetime().optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  channel: z.string().max(200).optional().default(''),
  summary: z.string().max(2000).optional().default(''),
  source: z.enum(['user', 'calendar', 'message', 'import']).optional().default('user'),
  calendarAccountId: z.string().max(200).nullable().optional(),
  calendarEventId: z.string().max(500).nullable().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export const memoryLinkSchema = z.object({
  memoryId: z.string().guid(),
  note: z.string().max(1000).optional().default(''),
});

// Beeper participant → Tribe linking (#34). conversationId/sourceUserId
// identify the beeper_participants row. No `network` field here on purpose:
// it used to be client-supplied and scoped a username-shaped identity claim,
// but that let a request omit it (writing an inert kind='handle' row no
// later lookup can ever match) or spoof a WRONG network (silently stealing
// another person's claim on a UNIQUE (kind, network, handle) collision) —
// see server/services/beeper/beeperTribe.js. The network is now derived server-side
// from the participant's own beeper_conversations.network; a phone-shaped
// claim stays network-less (see server/lib/tribeMatch.js).
export const beeperLinkSchema = z.object({
  conversationId: z.string().guid(),
  sourceUserId: z.string().min(1).max(500),
  personId: z.string().guid(),
});

// Unlink a Beeper participant from whichever Tribe person currently owns it
// (#97 part B). Same identifying pair as `beeperLinkSchema` — no `personId`
// here, since unlink releases whatever the participant is CURRENTLY linked
// to, and is a no-op rather than an error when that is nothing.
export const beeperUnlinkSchema = z.object({
  conversationId: z.string().guid(),
  sourceUserId: z.string().min(1).max(500),
});

export const beeperCreateAndLinkSchema = z.object({
  conversationId: z.string().guid(),
  sourceUserId: z.string().min(1).max(500),
  name: z.string().min(1).max(200).optional(),
  ring: ringSchema.optional().default('tribe'),
  relationship: z.string().max(200).optional().default(''),
});

// Outreach draft generation (#2158). The seed fields come from a detected
// unanswered thread; the LLM call happens only on this explicit POST (user action)
// per the AI-provider policy — never from the detection sweep.
export const outreachDraftSchema = z.object({
  personId: z.string().guid().nullable().optional(),
  source: z.string().max(60).nullable().optional(),
  // Message-account id (#2820) — scopes the email grounding query so a threadId
  // shared across accounts can't merge conversations. Optional/back-compat.
  accountId: z.string().max(200).nullable().optional(),
  threadId: z.string().max(500).nullable().optional(),
  chatGuid: z.string().max(500).nullable().optional(),
  conversationId: z.string().max(500).nullable().optional(),
  handle: z.string().max(320).nullable().optional(),
  lastInboundAt: z.string().datetime().nullable().optional(),
  instructions: z.string().max(2000).optional().default(''),
  useVoice: z.boolean().optional(),
}).refine(
  // Require a conversation key — without one, generateOutreachDraft would query
  // the whole timeline and draft a reply to an unrelated conversation.
  (d) => Boolean(d.threadId || d.chatGuid || d.conversationId || d.handle),
  { message: 'An outreach draft needs one of threadId, chatGuid, conversationId, or handle' },
);

export const listQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(200).optional(),
  ring: ringSchema.or(z.literal('all')).optional(),
});

export const tribeGuidSchema = z.string().guid();
