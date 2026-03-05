import { z } from 'zod';

// =============================================================================
// POST (Power On Self Test) VALIDATION SCHEMAS
// =============================================================================

// Tags for session conditions (sleep, caffeine, stress, etc.)
export const postTagsSchema = z.record(z.string().max(200));

// Individual question result (math drills)
// expected and correct are optional — the server recomputes both via scoreDrill
const questionResultSchema = z.object({
  prompt: z.string(),
  expected: z.number().optional(),
  answered: z.number().nullable(),
  correct: z.boolean().optional(),
  responseMs: z.number().min(0)
});

// LLM drill response (text-based)
const llmResponseSchema = z.object({
  prompt: z.string().optional(),
  response: z.string().optional(),
  answers: z.array(z.string()).optional(),
  items: z.array(z.string()).optional(),
  responseMs: z.number().min(0).optional().default(0),
  llmScore: z.number().min(0).max(100).optional(),
  llmFeedback: z.string().optional()
});

// Drill type configuration
const MATH_DRILL_TYPES = ['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation'];
const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay'];
const DRILL_TYPES = [...MATH_DRILL_TYPES, ...LLM_DRILL_TYPES];

const drillTypeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  steps: z.number().int().min(1).max(50).optional(),
  subtrahend: z.number().int().min(1).max(100).optional(),
  startValue: z.number().int().min(1).optional(),
  startRange: z.array(z.number()).length(2).optional(),
  timeLimitSec: z.number().int().min(10).max(600).optional(),
  count: z.number().int().min(1).max(50).optional(),
  maxDigits: z.number().int().min(1).max(4).optional(),
  bases: z.array(z.number().int().min(2).max(20)).min(1).optional(),
  maxExponent: z.number().int().min(2).max(20).optional(),
  tolerancePct: z.number().min(1).max(50).optional()
});

// Task result within a session
// score is optional — the server recomputes it via scoreDrill
const taskResultSchema = z.object({
  module: z.string(),
  type: z.enum(DRILL_TYPES),
  config: drillTypeConfigSchema.optional().default({}),
  questions: z.array(questionResultSchema).optional().default([]),
  responses: z.array(llmResponseSchema).optional().default([]),
  drillData: z.any().optional(),
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

// LLM drill type configuration
const llmDrillTypeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  count: z.number().int().min(1).max(20).optional(),
  timeLimitSec: z.number().int().min(10).max(600).optional(),
  providerId: z.string().optional(),
  model: z.string().optional()
});

// Config update (partial)
export const postConfigUpdateSchema = z.object({
  mentalMath: z.object({
    enabled: z.boolean().optional(),
    drillTypes: z.record(z.enum(MATH_DRILL_TYPES), drillTypeConfigSchema).optional()
  }).optional(),
  llmDrills: z.object({
    enabled: z.boolean().optional(),
    providerId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    drillTypes: z.record(z.enum(LLM_DRILL_TYPES), llmDrillTypeConfigSchema).optional()
  }).optional(),
  sessionModules: z.array(z.string()).optional(),
  scoring: z.object({
    weights: z.record(z.number().min(0).max(1)).optional()
  }).optional()
}).partial();

// Drill generation request
export const postDrillRequestSchema = z.object({
  type: z.enum(DRILL_TYPES),
  config: drillTypeConfigSchema.optional().default({}),
  providerId: z.string().optional(),
  model: z.string().optional()
});

// LLM drill scoring request
export const postLlmScoreRequestSchema = z.object({
  type: z.enum(LLM_DRILL_TYPES),
  drillData: z.any(),
  responses: z.array(llmResponseSchema),
  timeLimitMs: z.number().min(1000),
  providerId: z.string().optional(),
  model: z.string().optional()
});

export { LLM_DRILL_TYPES, MATH_DRILL_TYPES };
