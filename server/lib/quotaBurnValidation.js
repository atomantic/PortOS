/**
 * Zod schemas for the Quota Burn routes.
 *
 * Shape-only: the bounds here reject a malformed request, while
 * `normalizeQuotaBurnConfig` (lib/quotaBurnConfig.js) is what the store applies
 * on the way to disk. Both exist on purpose — a PUT gets a 400 instead of a
 * silent clamp, and a config file written by an older PortOS still loads.
 *
 * Per the domain-validation convention this module must NOT import from
 * `validation.js` (ESM hoisting would put that read in the TDZ); it re-exports
 * from there instead.
 */

import { z } from 'zod';
import {
  CHECK_INTERVAL_MINUTES_MAX,
  CHECK_INTERVAL_MINUTES_MIN,
  QUOTA_BURN_FAMILIES,
  QUOTA_BURN_JOB_TYPES,
} from './quotaBurnConfig.js';

// A job's params bag is per-job-type, so it stays a flat scalar map here — the
// job module owns which keys it reads. Depth is what's rejected: a nested blob
// in a config file is either a mistake or an attempt to smuggle state past the
// normalizer.
const paramValueSchema = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);

export const quotaBurnJobSchema = z.object({
  id: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  label: z.string().max(120).optional(),
  jobType: z.enum(QUOTA_BURN_JOB_TYPES),
  model: z.string().max(120).nullable().optional(),
  providerId: z.string().max(120).nullable().optional(),
  params: z.record(paramValueSchema).optional(),
}).strict();

export const quotaBurnFamilySchema = z.object({
  enabled: z.boolean().optional(),
  providerId: z.string().max(120).nullable().optional(),
  scope: z.string().max(60).nullable().optional(),
  resetWithinHours: z.number().min(0).max(168).optional(),
  reservePercent: z.number().min(0).max(100).optional(),
  maxDispatchesPerWindow: z.number().int().min(1).max(50).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  // Replaced wholesale, never merged element-wise — it is an ordered list, and
  // a positional merge would make reordering and deletion inexpressible.
  jobs: z.array(quotaBurnJobSchema).max(25).optional(),
}).strict();

// Spelled out per family rather than z.record so an unknown family key is a 400
// (a typo'd card id would otherwise round-trip and silently never burn).
export const quotaBurnConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  checkIntervalMinutes: z.number().int().min(CHECK_INTERVAL_MINUTES_MIN).max(CHECK_INTERVAL_MINUTES_MAX).optional(),
  families: z.object(
    Object.fromEntries(QUOTA_BURN_FAMILIES.map((id) => [id, quotaBurnFamilySchema.optional()])),
  ).strict().optional(),
}).strict();

export const quotaBurnRunSchema = z.object({
  familyId: z.enum(QUOTA_BURN_FAMILIES).optional(),
  jobId: z.string().max(64).optional(),
  // Bypasses the reset-window / reserve / cap gates for ONE named job. Only
  // meaningful with `familyId` — the route rejects it otherwise.
  force: z.boolean().optional(),
}).strict();
