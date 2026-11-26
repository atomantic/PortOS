/** Zod schemas for insight refreshes, generated themes and weekly goal scorecards. */

import { z } from 'zod';
import { providerRefSchema } from './zodCompat.js';

const themeEvidenceSchema = z.object({
  preference: z.string().catch(''),
  domain: z.string().catch(''),
  connection: z.string().catch(''),
});

export const insightThemeSchema = z.object({
  title: z.string().trim().min(1),
  narrative: z.preprocess(value => value ?? '', z.coerce.string().catch('')),
  evidence: z.array(z.unknown()).catch([]).transform(items => items.flatMap(item => {
    const parsed = themeEvidenceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
  strength: z.enum(['strong', 'moderate', 'tentative']).catch('tentative'),
});

export const insightRefreshSchema = z.object({
  providerId: providerRefSchema.optional(),
  model: z.string().optional()
});

// Goal effectiveness scorecard (#2157).
export const scorecardComputeSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export const scorecardSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: providerRefSchema.nullable().optional(),
  model: z.string().nullable().optional(),
  feedBrainDigest: z.boolean().optional(),
  weekStartsOn: z.number().int().min(1).max(7).optional()
});

// Per-goal mapping overrides: { [goalId]: { keywords?, personIds?, subcalendarIds?, enabled? } }.
const scorecardRuleOverrideSchema = z.object({
  keywords: z.array(z.string()).optional(),
  personIds: z.array(z.string()).optional(),
  subcalendarIds: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
});
export const scorecardRulesSchema = z.record(z.string(), scorecardRuleOverrideSchema);
