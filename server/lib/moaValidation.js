/**
 * Zod schemas for Mixture of Agents (MoA) presets: reference models, the aggregator and the preset create/update bodies.
 *
 * Shape-only. Whether a member's `providerId` names an enabled, non-MoA API
 * provider is a LIVE question (providers are toggled and deleted after a
 * preset is saved), so `services/moaPresets.js` answers it on every save and
 * `services/moaRunner.js` answers it again on every run, both through
 * `lib/moaConfig.js#moaMemberRefusal`. The `moa:` prefix refusal here is the
 * cheap structural half of the recursion guard: a member can never even be
 * stored pointing at another MoA preset.
 */

import { z } from 'zod';
import { MOA_ID_PREFIX, MOA_PRIVACY_FILTERS } from './moaConfig.js';

export const MAX_MOA_REFERENCE_MODELS = 5;
export const MOA_PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const moaPresetIdSchema = z.string().regex(MOA_PRESET_ID_RE);

const memberProviderId = z.string().trim().min(1).max(200)
  .refine((id) => !id.startsWith(MOA_ID_PREFIX), { message: 'An MoA member cannot be another MoA preset' });
const memberModel = z.string().trim().min(1).max(200).optional();

/** One advisor: always a bounded, tool-free completion, so it carries its own sampling. */
export const moaReferenceModelSchema = z.object({
  providerId: memberProviderId,
  model: memberModel,
  temperature: z.number().min(0).max(2).optional(),
}).strict();

/**
 * The acting, billed model. No temperature: on the streamed path the
 * aggregator runs with the caller's own options, and a stored value that only
 * sometimes applied would be a silently ignored setting.
 */
export const moaAggregatorSchema = z.object({
  providerId: memberProviderId,
  model: memberModel,
}).strict();

const presetFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  referenceModels: z.array(moaReferenceModelSchema).min(1).max(MAX_MOA_REFERENCE_MODELS),
  aggregator: moaAggregatorSchema,
  privacyFilter: z.enum(MOA_PRIVACY_FILTERS),
  advisorMaxTokens: z.number().int().min(64).max(8192),
  enabled: z.boolean(),
};

export const moaPresetCreateSchema = z.object({
  id: z.string().regex(MOA_PRESET_ID_RE, 'Use lowercase letters, digits and dashes').optional(),
  ...presetFields,
  privacyFilter: presetFields.privacyFilter.default('off'),
  advisorMaxTokens: presetFields.advisorMaxTokens.default(1024),
  enabled: presetFields.enabled.default(true),
}).strict();

/** Every field optional; an absent key keeps the stored value. The id is the record's address and never changes. */
export const moaPresetUpdateSchema = z.object(Object.fromEntries(
  Object.entries(presetFields).map(([key, schema]) => [key, schema.optional()]),
)).strict();

/** The stored record: what `services/moaPresets.js` reads back, so a hand-edited file is refused rather than run. */
export const moaPresetRecordSchema = z.object({
  id: z.string().regex(MOA_PRESET_ID_RE),
  ...presetFields,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
