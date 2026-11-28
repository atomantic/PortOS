// Zod request schemas for the stacker news routes.

import { z } from 'zod';

export const uuid = z.string().uuid();

const ruleStrings = z.array(z.string().trim().min(1).max(300)).max(50).optional();

const rules = z.object({
  guidance: z.string().max(4_000).optional(),
  tone: z.string().max(500).optional(),
  allowedThemes: ruleStrings,
  disallowedThemes: ruleStrings,
  escalationCues: ruleStrings,
  desiredEngagement: ruleStrings,
  actionBudget: z.object({
    maxPerHour: z.number().int().min(1).max(50).optional(),
    maxPerDay: z.number().int().min(1).max(200).optional(),
    minMinutesBetween: z.number().int().min(0).max(1_440).optional(),
  }).strict().optional(),
}).strict().optional();

export const accountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  username: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, 'must be a Stacker News username'),
  apiKey: z.string().trim().min(1).max(400).optional(),
  readTransport: z.enum(['browser', 'api']).optional(),
  enabled: z.boolean().optional(),
  monitoringEnabled: z.boolean().optional(),
  monitoringIntervalMinutes: z.number().int().min(5).max(1_440).optional(),
  syncItemLimit: z.number().int().min(1).max(100).optional(),
  analysisEnabled: z.boolean().optional(),
  textModel: z.string().trim().max(200).optional(),
  visionModel: z.string().trim().max(200).optional(),
  rules,
}).strict();

export const accountUpdateSchema = accountSchema.partial().extend({ apiKey: z.string().trim().max(400).optional() }).strict();

export const territorySchema = z.object({
  accountId: uuid,
  slug: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().max(160).optional(),
  isOwned: z.boolean().optional(),
  monitoringEnabled: z.boolean().nullable().optional(),
  inheritAccountRules: z.boolean().optional(),
  rules,
}).strict();

const actionBase = { accountId: uuid, itemId: uuid.nullable().optional(), territoryId: uuid.nullable().optional() };

const itemHandoffPayload = z.object({ intent: z.enum(['inspect', 'zap', 'moderate']).optional() }).strict().optional();

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ ...actionBase, kind: z.enum(['draft_post', 'publish_post']), territoryId: uuid, destination: z.literal('').optional(), payload: z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(40_000).optional() }).strict() }).strict(),
  z.object({ ...actionBase, kind: z.enum(['draft_comment', 'publish_comment']), itemId: uuid, destination: z.literal('').optional(), payload: z.object({ body: z.string().trim().min(1).max(40_000) }).strict() }).strict(),
  z.object({ ...actionBase, kind: z.literal('open_browser'), destination: z.enum(['item', 'territory_settings']), payload: itemHandoffPayload }).strict(),
  z.object({ ...actionBase, kind: z.literal('territory_setting'), territoryId: uuid, destination: z.literal('territory_settings').optional(), payload: z.object({}).strict().optional() }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === 'open_browser' && value.destination === 'item' && !value.itemId) {
    ctx.addIssue({ code: 'custom', message: 'item destination requires itemId' });
  }
  if (value.kind === 'open_browser' && value.destination === 'territory_settings' && !value.territoryId) {
    ctx.addIssue({ code: 'custom', message: 'territory settings destination requires territoryId' });
  }
});

// Optional override so "Check API identity" can test the stored key even while
// the account reads through the browser; omitted, it uses the account's own
// configured read transport.
export const verifySchema = z.object({ transport: z.enum(['browser', 'api']).optional() }).strict();

export const reviewSchema = z.object({ state: z.enum(['approved', 'rejected']), reviewNote: z.string().max(2_000).optional() }).strict();

export const feedbackSchema = z.object({ feedback: z.string().trim().min(1).max(4_000) }).strict();
