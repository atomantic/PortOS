/**
 * Zod schemas for the Quota Burn routes.
 *
 * Two layers on purpose: these schemas REJECT a malformed request with a 400,
 * while `normalizeQuotaBurnConfig` (lib/quotaBurnConfig.js) CLAMPS on the way to
 * disk so a plan written by an older PortOS still loads. Both read their numbers
 * from the one `QUOTA_BURN_BOUNDS` table — when the bounds were literals in both
 * files, raising a cap in one meant the PUT 400'd on a plan the normalizer would
 * happily have accepted.
 *
 * Per the domain-validation convention this module must NOT import from
 * `validation.js` (ESM hoisting would put that read in the TDZ); it re-exports
 * from there instead.
 */

import { z } from 'zod';
import {
  QUOTA_BURN_BOUNDS,
  QUOTA_BURN_FAMILIES,
  QUOTA_BURN_JOB_TYPES,
  QUOTA_BURN_UNLIMITED_DISPATCHES,
} from './quotaBurnConfig.js';

const B = QUOTA_BURN_BOUNDS;

// A job's params bag is per-job-type, so it stays a flat scalar map here — the
// job module owns which keys it reads. Depth is what's rejected: a nested blob
// in a config file is either a mistake or an attempt to smuggle state past the
// normalizer.
const paramValueSchema = z.union([z.string().max(B.paramLength.max), z.number().finite(), z.boolean(), z.null()]);

const quotaBurnJobSchema = z.object({
  id: z.string().max(B.idLength.max).optional(),
  enabled: z.boolean().optional(),
  label: z.string().max(B.labelLength.max).optional(),
  jobType: z.enum(QUOTA_BURN_JOB_TYPES),
  model: z.string().max(B.labelLength.max).nullable().optional(),
  providerId: z.string().max(B.labelLength.max).nullable().optional(),
  effort: z.string().max(B.labelLength.max).nullable().optional(),
  // One-shot work: dispatch this step at most once, then drop it out of the
  // rotation until the user re-arms it. Absent reads as `false`, so plans
  // written before this field keep repeating.
  runOnce: z.boolean().optional(),
  params: z.record(paramValueSchema).optional(),
}).strict();

const quotaBurnFamilySchema = z.object({
  enabled: z.boolean().optional(),
  resetWithinHours: z.number().min(B.resetWithinHours.min).max(B.resetWithinHours.max).optional(),
  reservePercent: z.number().min(B.reservePercent.min).max(B.reservePercent.max).optional(),
  // The unlimited sentinel sits below the field's own minimum, so it is spelled
  // as its own branch rather than by widening `min` — which would also let 0
  // through, and 0 would read as "never burn" where the family switch belongs.
  maxDispatchesPerWindow: z.union([
    z.literal(QUOTA_BURN_UNLIMITED_DISPATCHES),
    z.number().int().min(B.maxDispatchesPerWindow.min).max(B.maxDispatchesPerWindow.max),
  ]).optional(),
  priority: z.number().int().min(B.priority.min).max(B.priority.max).optional(),
  // Replaced wholesale, never merged element-wise — it is an ordered list, and
  // a positional merge would make reordering and deletion inexpressible.
  jobs: z.array(quotaBurnJobSchema).max(B.jobsPerFamily.max).optional(),
}).strict();

// Spelled out per family rather than z.record so an unknown family key is a 400
// (a typo'd card id would otherwise round-trip and silently never burn).
export const quotaBurnConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  checkIntervalMinutes: z.number().int().min(B.checkIntervalMinutes.min).max(B.checkIntervalMinutes.max).optional(),
  families: z.object(
    Object.fromEntries(QUOTA_BURN_FAMILIES.map((id) => [id, quotaBurnFamilySchema.optional()])),
  ).strict().optional(),
}).strict();

export const quotaBurnRunSchema = z.object({
  familyId: z.enum(QUOTA_BURN_FAMILIES).optional(),
  jobId: z.string().max(B.idLength.max).optional(),
  // Bypasses the reset-window / reserve / cap gates for ONE named job. Only
  // meaningful with `familyId` — the route rejects it otherwise.
  force: z.boolean().optional(),
}).strict();

/**
 * Re-arm a spent `run once` step. `familyId` is required — a bare "clear
 * everything" would silently re-queue every one-shot job on the install, which
 * is real spend nobody asked for. Omitting `jobId` re-arms that family's whole
 * plan, which is how "run that series again" is expressed.
 */
export const quotaBurnRearmSchema = z.object({
  familyId: z.enum(QUOTA_BURN_FAMILIES),
  jobId: z.string().max(B.idLength.max).optional(),
}).strict();
