import { z } from 'zod';
import { CACHEABLE_TYPES } from '../services/meatspacePostDrillCache.js';
import { COGNITIVE_DRILL_TYPES } from '../services/meatspacePostCognitive.js';
import { HHMM_STRICT_RE } from './timezone.js';

// =============================================================================
// POST (Power On Self Test) VALIDATION SCHEMAS
// =============================================================================

// Tags for session conditions (sleep, caffeine, stress, etc.)
export const postTagsSchema = z.record(z.string().max(200));

// 24h "HH:MM" time-of-day — HHMM_STRICT_RE is timezone.js's single source of
// truth for this exact zero-padded pattern (shared with dashboardLayouts.js's
// activateWindow validator); don't re-derive a local copy.

// Individual question result (math + memory drills)
// Math: server recomputes expected/correct via scoreDrill (numeric values)
// Memory: client scores with string comparison (text values)
const questionResultSchema = z.object({
  prompt: z.string(),
  // Cognitive drills key each trial back to its position in the generated
  // drillData (n-back sequence index, digit-span/stroop trial index) so the
  // server can recompute the answer key. Absent for math/memory drills.
  index: z.number().int().min(0).optional(),
  expected: z.union([z.number(), z.string()]).optional(),
  answered: z.union([z.number(), z.string()]).nullable(),
  correct: z.boolean().optional(),
  responseMs: z.number().min(0)
});

// LLM drill response (text-based)
const llmResponseSchema = z.object({
  // questionIndex pairs the response with the correct prompt in drillData.
  // Without it Zod's default strip would drop the field, the scorer would fall
  // back to the array index (always 0 for single-response submits), and every
  // answer would be evaluated against the first prompt.
  questionIndex: z.number().int().min(0).optional(),
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
const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist', 'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'];
const MEMORY_DRILL_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
// Memory drills supported by the POST runner (client-side scoring with string comparison)
const POST_SUPPORTED_MEMORY_TYPES = ['memory-sequence', 'memory-element-flash'];
// Cognitive drills (deterministic, no LLM) — n-back / digit-span / stroop.
// Sourced from meatspacePostCognitive.js so the type list has one owner.
// Morse trainer drill types (client-side scoring — exact-match copy/send comparison).
const MORSE_DRILL_TYPES = ['morse-copy', 'morse-head-copy', 'morse-send'];
const DRILL_TYPES = [...MATH_DRILL_TYPES, ...LLM_DRILL_TYPES, ...MEMORY_DRILL_TYPES, ...COGNITIVE_DRILL_TYPES, ...MORSE_DRILL_TYPES];

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
  tolerancePct: z.number().min(1).max(50).optional(),
  // --- Cognitive drill knobs (n-back / digit-span / stroop) ---
  // Bounds match the generator clamps in meatspacePostCognitive.js so the UI /
  // API can't accept a value the generator will silently narrow. Exception:
  // `length`'s effective floor is `n + 5` (dynamic, up to 8) inside the
  // generator — Zod can't express a cross-field minimum here, so this schema
  // keeps a conservative fixed floor of 6 and lets the generator clamp up.
  // (timeLimitSec above is validated but NOT enforced for these drill types —
  // they're self-paced/stimulus-driven; see PostCognitiveDrillRunner.jsx.)
  // No stimulusMs/showMs here — no UI ever set them (issue #2008), so they were
  // dead validated-but-unreachable knobs; the generators (meatspacePostCognitive.js)
  // keep their own internal defaults regardless.
  n: z.number().int().min(1).max(3).optional(),
  length: z.number().int().min(6).max(60).optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  startLength: z.number().int().min(3).max(9).optional(),
  maxLength: z.number().int().min(3).max(12).optional()
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
  // Deterministic cognitive drills — no provider, so no provider/model fields.
  cognitive: z.object({
    enabled: z.boolean().optional(),
    drillTypes: z.record(z.enum(COGNITIVE_DRILL_TYPES), drillTypeConfigSchema).optional()
  }).optional(),
  sessionModules: z.array(z.string()).optional(),
  scoring: z.object({
    weights: z.record(z.number().min(0).max(1)).optional()
  }).optional(),
  // Opt-in adaptive difficulty: when enabled, math drill params are nudged at
  // generation time from recent scored performance (server/lib/postAdaptive.js).
  // Default OFF so existing installs are unchanged — additive, no migration.
  adaptive: z.object({
    enabled: z.boolean().optional()
  }).optional(),
  // Opt-in daily reminder (default OFF, off by default). `time` is a 24h
  // "HH:MM" string interpreted in the user's configured timezone. The native
  // <input type="time"> can be cleared to '' by the user; treat that as
  // "no change" (absent) rather than a validation failure that would reject
  // the whole config PUT — same UI-sentinel-tolerance pattern CLAUDE.md
  // documents for CLI provider endpoints.
  reminder: z.object({
    enabled: z.boolean().optional(),
    time: z.preprocess(
      v => (v === '' ? undefined : v),
      z.string().regex(HHMM_STRICT_RE, 'Must be HH:MM format').optional()
    )
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

// Explicit, user-consented request to warm the wordplay drill cache
export const postDrillCacheFillSchema = z.object({
  types: z.array(z.enum(CACHEABLE_TYPES)).min(1).optional(),
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

// Spaced-repetition schedule (SM-2 inspired). Server-managed via practice, but
// accepted on both POST (seed an imported item's progress) and PUT (persist an
// out-of-band reschedule). When absent the service stamps a fresh default.
export const memoryScheduleSchema = z.object({
  ease: z.number().min(1.3).max(5),
  intervalDays: z.number().min(0),
  nextReview: z.string(),
  lastReviewed: z.string().nullable().optional(),
});

export const memoryItemCreateSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['song', 'poem', 'speech', 'sequence', 'text']).optional().default('text'),
  lines: z.array(z.union([z.string(), memoryLineSchema])).min(1),
  chunks: z.array(memoryChunkSchema).optional(),
  schedule: memoryScheduleSchema.optional(),
});

export const memoryItemUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  type: z.enum(['song', 'poem', 'speech', 'sequence', 'text']).optional(),
  lines: z.array(z.union([z.string(), memoryLineSchema])).optional(),
  chunks: z.array(memoryChunkSchema).optional(),
  schedule: memoryScheduleSchema.optional(),
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

// Training log entry submission
export const trainingEntrySchema = z.object({
  module: z.string(),
  drillType: z.enum(DRILL_TYPES),
  questionCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  totalMs: z.number().min(0),
});

export { LLM_DRILL_TYPES, MATH_DRILL_TYPES, MEMORY_DRILL_TYPES, POST_SUPPORTED_MEMORY_TYPES, COGNITIVE_DRILL_TYPES, MORSE_DRILL_TYPES };
