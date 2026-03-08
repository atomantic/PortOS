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
const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay', 'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'];
const MEMORY_DRILL_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
const DRILL_TYPES = [...MATH_DRILL_TYPES, ...LLM_DRILL_TYPES, ...MEMORY_DRILL_TYPES];

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
  evaluation: z.object({
    score: z.number().min(0).max(100).optional(),
    breakdown: z.array(z.object({
      question: z.string().optional(),
      score: z.number().min(0).max(100).optional(),
      feedback: z.string().optional()
    })).optional()
  }).optional(),
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

// =============================================================================
// MEMORY BUILDER VALIDATION
// =============================================================================

const memoryLineSchema = z.object({
  text: z.string().min(1),
  elements: z.array(z.string()).optional(),
});

const memoryChunkSchema = z.object({
  id: z.string(),
  lineRange: z.array(z.number().int().min(0)).length(2),
  label: z.string(),
});

export const memoryItemCreateSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['song', 'poem', 'speech', 'sequence', 'text']).optional().default('text'),
  lines: z.array(z.union([z.string(), memoryLineSchema])).min(1),
  chunks: z.array(memoryChunkSchema).optional(),
});

export const memoryItemUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  type: z.enum(['song', 'poem', 'speech', 'sequence', 'text']).optional(),
  lines: z.array(z.union([z.string(), memoryLineSchema])).optional(),
  chunks: z.array(memoryChunkSchema).optional(),
  mastery: z.object({
    overallPct: z.number().min(0).max(100).optional(),
    chunks: z.record(z.object({
      correct: z.number().int().min(0),
      attempts: z.number().int().min(0),
      lastPracticed: z.string().nullable().optional(),
    })).optional(),
    elements: z.record(z.object({
      correct: z.number().int().min(0),
      attempts: z.number().int().min(0),
    })).optional(),
  }).optional(),
});

const practiceResultSchema = z.object({
  correct: z.boolean(),
  word: z.string().optional(),
  element: z.string().nullable().optional(),
  expected: z.string().optional(),
  answered: z.string().optional(),
});

export const memoryPracticeSchema = z.object({
  mode: z.enum(['fill-blank', 'sequence', 'element-flash', 'learn', 'speed-run']),
  chunkId: z.string().nullable().optional(),
  results: z.array(practiceResultSchema).min(1),
  totalMs: z.number().min(0).optional(),
});

export const memoryDrillRequestSchema = z.object({
  mode: z.enum(['fill-blank', 'sequence', 'element-flash']).optional().default('fill-blank'),
  memoryItemId: z.string().optional(),
  count: z.number().int().min(1).max(30).optional().default(5),
});

export { LLM_DRILL_TYPES, MATH_DRILL_TYPES, MEMORY_DRILL_TYPES };
