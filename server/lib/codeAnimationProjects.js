/** Machine-local Production persistence contracts; no execution authority. */
import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { codeAnimationManifestSchema } from './codeAnimationPackage.js';
import { partialWithoutDefaults } from './zodCompat.js';

export const codeAnimationBudgetsSchema = z.object({
  iterations: z.number().int().min(1).max(1000).default(8),
  timeSeconds: z.number().int().min(1).max(86400).default(900),
  tokens: z.number().int().min(1).max(100000000).default(128000),
  renderSeconds: z.number().int().min(1).max(86400).default(300),
  diskBytes: z.number().int().min(1).max(1000000000000).default(512 * 1024 * 1024),
}).strict();

const localSettingsSchema = z.object({
  providerId: z.string().max(128).nullable().default(null),
  connectionId: z.string().max(128).nullable().default(null),
  mode: z.enum(['api', 'cli', 'tui']).nullable().default(null),
  model: z.string().max(256).nullable().default(null),
  effort: z.enum(EFFORT_LEVELS).nullable().default(null),
  // 'pinned' (default): the selected route must run the work; a fallback or
  // swapped route is an error. 'allowed': substitution is an explicit decision
  // that the effective-route record carries.
  substitution: z.enum(['pinned', 'allowed']).default('pinned'),
}).strict();

export const codeAnimationProjectSchema = z.object({
  manifest: codeAnimationManifestSchema,
  budgets: codeAnimationBudgetsSchema.prefault({}),
  localSettings: localSettingsSchema.prefault({}),
  referenceIntent: z.object({
    universeId: z.string().max(128).nullable().default(null),
    moodBoardId: z.string().max(128).nullable().default(null),
    notes: z.string().max(16000).default(''),
  }).strict().prefault({}),
}).strict();

export const codeAnimationProjectPatchSchema = partialWithoutDefaults(codeAnimationProjectSchema);

// POST /projects/:id/stage-runs. Starting is an explicit user action; the body
// can only name which stored revision to work from or which stopped run to resume.
export const codeAnimationStageRunSchema = z.object({
  revisionId: z.string().uuid().optional(),
  resumeFromRunId: z.string().uuid().optional(),
}).strict().refine(value => !(value.revisionId && value.resumeFromRunId), 'Choose a revision or a run to resume, not both');
