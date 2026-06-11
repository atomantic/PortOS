import { z } from 'zod';
import { STEP_IDS as STORY_STEP_IDS } from './storyBuilderSteps.js';
import { emptyToUndefined } from './zodCompat.js';

// =============================================================================
// UNIFIED STORY BUILDER SCHEMAS
// =============================================================================
// Split out of validation.js (issue #1151); validation.js re-exports
// everything here so existing deep imports keep working. The import from
// zodCompat.js (not validation.js) supplies emptyToUndefined — see
// creativeDirectorValidation.js for the cycle rationale.

const storyProviderField = z.preprocess(emptyToUndefined, z.string().trim().max(120).optional());
const storyModelField = z.preprocess(emptyToUndefined, z.string().trim().max(200).optional());

export const storySessionCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  intakeMode: z.enum(['seed', 'import']).optional().default('seed'),
  seedIdea: z.string().trim().max(4000).optional().default(''),
  // Import mode supplies pre-created ids; seed mode mints shells server-side.
  universeId: z.preprocess(emptyToUndefined, z.string().trim().max(64).optional()),
  seriesId: z.preprocess(emptyToUndefined, z.string().trim().max(64).optional()),
  // Picker choice that drives every Story Builder operation; nullable so the
  // UI can send "use the stage default" explicitly.
  llm: z.object({
    provider: z.string().trim().max(80).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
  }).optional(),
}).strict();

export const storySessionUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  seedIdea: z.string().trim().max(4000).optional(),
  // Reject removed/unknown step ids loudly — the sanitizer would otherwise
  // silently coerce them to STEP_IDS[0], landing a stale client on the first
  // step with no error.
  currentStep: z.enum(STORY_STEP_IDS).optional(),
  llm: z.object({
    provider: z.string().trim().max(80).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
  }).optional(),
}).strict();

// Cross-machine resume opt-in toggle (#730). Sessions are local-only by
// default; flipping this on snapshots a staleness baseline that travels with
// the session so a peer's universe edit can't false-positive-stale it.
export const storySessionSyncSchema = z.object({
  sync: z.boolean(),
}).strict();

export const storyStepGenerateSchema = z.object({
  providerId: storyProviderField,
  model: storyModelField,
  // Backfill toggle: synthesize this (upstream) step from the series' existing
  // downstream issue content instead of its conventional upstream. Honored by
  // the idea + plotArc generators (see services/storyBuilder.js generateStep).
  fromDownstream: z.boolean().optional(),
}).strict();

export const storyStepRefineSchema = z.object({
  feedback: z.string().trim().max(4000).optional().default(''),
  // For per-entry refine (e.g. a single character on the characters step).
  entryId: z.preprocess(emptyToUndefined, z.string().trim().max(64).optional()),
  providerId: storyProviderField,
  model: storyModelField,
}).strict();

export const storyIssueLockSchema = z.object({
  locked: z.boolean(),
}).strict();

export const storyIssuesGenerateSchema = z.object({
  providerId: storyProviderField,
  model: storyModelField,
  // Optional: scope generation to a single season; omit to cover every season
  // on the arc.
  seasonId: z.preprocess(emptyToUndefined, z.string().trim().max(64).optional()),
}).strict();
