import { z } from 'zod';

// =============================================================================
// POST (Power On Self Test) VALIDATION SCHEMAS
// =============================================================================

// Tags for session conditions (sleep, caffeine, stress, etc.)
export const postTagsSchema = z.record(z.string().max(200));

// Individual question result
// correct is optional — the server recomputes it via scoreDrill
const questionResultSchema = z.object({
  prompt: z.string(),
  expected: z.number(),
  answered: z.number().nullable(),
  correct: z.boolean().optional(),
  responseMs: z.number().min(0)
});

// Task result within a session
// score is optional — the server recomputes it via scoreDrill
const taskResultSchema = z.object({
  module: z.string(),
  type: z.string(),
  config: z.record(z.unknown()).optional().default({}),
  questions: z.array(questionResultSchema),
  score: z.number().min(0).max(100).optional(),
  totalMs: z.number().min(0)
});

// Full session submission
export const postSessionSubmitSchema = z.object({
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
  modules: z.array(z.string()).min(1),
  tasks: z.array(taskResultSchema).min(1),
  tags: postTagsSchema.optional().default({})
});

// Drill type configuration
const DRILL_TYPES = ['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation'];

const drillTypeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  steps: z.number().int().min(1).max(50).optional(),
  subtrahend: z.number().int().min(1).max(100).optional(),
  startValue: z.number().int().min(1).optional(),
  startRange: z.array(z.number()).length(2).optional(),
  timeLimitSec: z.number().int().min(10).max(600).optional(),
  count: z.number().int().min(1).max(50).optional(),
  maxDigits: z.number().int().min(1).max(4).optional(),
  bases: z.array(z.number().int().min(2).max(20)).optional(),
  maxExponent: z.number().int().min(2).max(20).optional(),
  tolerancePct: z.number().min(1).max(50).optional()
});

// Config update (partial)
export const postConfigUpdateSchema = z.object({
  mentalMath: z.object({
    enabled: z.boolean().optional(),
    drillTypes: z.record(z.enum(DRILL_TYPES), drillTypeConfigSchema).optional()
  }).optional(),
  sessionModules: z.array(z.string()).optional(),
  scoring: z.object({
    weights: z.record(z.number().min(0).max(1)).optional()
  }).optional()
}).partial();

// Drill generation request
export const postDrillRequestSchema = z.object({
  type: z.enum(['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation']),
  config: drillTypeConfigSchema.optional().default({})
});
