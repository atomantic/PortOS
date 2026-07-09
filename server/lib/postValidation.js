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
  responseMs: z.number().min(0),
  // Reaction-time drill only: player pressed before the stimulus appeared.
  // Always scored wrong server-side regardless of any client-supplied correct.
  falseStart: z.boolean().optional(),
  // Memory drill questions only: which chunk (memory-sequence) / element
  // (memory-element-flash) this answer attributes to, so submitPostSession can
  // merge per-chunk/per-element mastery (mergeMasteryFromSession in
  // meatspacePostMemory.js) the same way MemoryBuilder's submitPractice does.
  // Absent for math/LLM/cognitive drills.
  chunkId: z.string().nullable().optional(),
  element: z.string().nullable().optional()
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
// Memory drills supported by the POST runner (client-side scoring with string
// comparison) — trusted for score + schedule/mastery advancement on session
// submit (issue #2099). Currently identical to MEMORY_DRILL_TYPES; kept as a
// separate list (rather than aliasing MEMORY_DRILL_TYPES directly) so a FUTURE
// memory drill type can ship generation-only, ahead of its scoring support,
// without silently trusting a client-supplied score for it.
const POST_SUPPORTED_MEMORY_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
// Canonical set of coarse "module" tags a scored POST task/session can carry
// (mental-math / llm-drills / cognitive drills / memory drills). Shared by the
// session-submit schema (below) and sessionModules config so a typo'd module
// string is rejected at validation instead of silently creating a phantom
// `byModule` stats bucket (issue #2099). Morse is deliberately excluded — it
// only ever posts through the separate, unrestricted `trainingEntrySchema`.
const POST_MODULES = ['mental-math', 'llm-drills', 'cognitive', 'memory'];
// Cognitive drills (deterministic, no LLM) — n-back / digit-span / stroop.
// Sourced from meatspacePostCognitive.js so the type list has one owner.
const DRILL_TYPES = [...MATH_DRILL_TYPES, ...LLM_DRILL_TYPES, ...MEMORY_DRILL_TYPES, ...COGNITIVE_DRILL_TYPES];
// Morse trainer drill types (client-side scoring — exact-match copy/send comparison).
// Deliberately NOT spliced into DRILL_TYPES: that array also backs
// taskResultSchema.type (the *scored* full-session submit endpoint,
// postSessionSubmitSchema) and postDrillRequestSchema.type (server-side drill
// generation). meatspacePost.js's scoring dispatch only special-cases
// LLM/MEMORY/COGNITIVE types and falls through everything else to scoreDrill's
// math-expression parser (computeExpectedFromPrompt) — a Morse task type would
// pass validation there but silently mis-score as a failed math drill instead
// of being rejected. Morse only ever posts through trainingEntrySchema below.
const MORSE_DRILL_TYPES = ['morse-copy', 'morse-head-copy', 'morse-send'];

const drillTypeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  // Memory drills: the target memory item to drill (falls back to lowest-mastery
  // item when absent). The /post/drill route threads config.memoryItemId into
  // generateMemoryDrill, so it must survive validation rather than being stripped.
  memoryItemId: z.string().optional(),
  steps: z.number().int().min(1).max(50).optional(),
  subtrahend: z.number().int().min(1).max(100).optional(),
  startValue: z.number().int().min(1).optional(),
  startRange: z.array(z.number()).length(2).optional(),
  timeLimitSec: z.number().int().min(10).max(600).optional(),
  count: z.number().int().min(1).max(50).optional(),
  maxDigits: z.number().int().min(1).max(4).optional(),
  // Progressive multiplication ladder (server/lib/postMultiplicationLadder.js).
  // `progressive` is the config toggle; `level`/`factors` are server-computed
  // effective config stamped into the generated drill (and stored per-task on
  // session submit), so they must survive validation on the round-trip.
  progressive: z.boolean().optional(),
  level: z.number().int().min(0).max(50).optional(),
  factors: z.array(z.number().int().min(1).max(4)).min(2).max(6).optional(),
  // Maintenance-review rep (issue #2096): `review` bypasses the progression
  // override so a specific mastered-but-inactive rung is re-verified at its own
  // level; `reviewSkillId` ties the scored task back to the review scheduler so
  // session-submit records the pass/fail. Both survive validation on the drill
  // request AND the session-submit round-trip.
  review: z.boolean().optional(),
  reviewSkillId: z.string().max(200).optional(),
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
  // stimulusMs (n-back) / showMs (digit-span) are the presentation-speed knobs.
  // The progressive ladder (default ON) drives them per rung; manual mode
  // (progressive off) exposes them in the config UI (issue #2095), so they must
  // survive validation. Bounds mirror the generator clamps in
  // meatspacePostCognitive.js (generateNBack / generateDigitSpan).
  n: z.number().int().min(1).max(3).optional(),
  stimulusMs: z.number().int().min(1000).max(5000).optional(),
  showMs: z.number().int().min(400).max(4000).optional(),
  length: z.number().int().min(6).max(60).optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  startLength: z.number().int().min(3).max(9).optional(),
  maxLength: z.number().int().min(3).max(12).optional(),
  // --- Cognitive drill knobs (schulte-table / mental-rotation / reaction-time) ---
  size: z.number().int().min(3).max(7).optional(),
  mode: z.enum(['simple', 'choice']).optional(),
  minDelayMs: z.number().int().min(300).max(5000).optional(),
  maxDelayMs: z.number().int().min(300).max(8000).optional(),
  choices: z.number().int().min(2).max(4).optional()
});

// Task result within a session
// score is optional — the server recomputes it via scoreDrill
const taskResultSchema = z.object({
  module: z.enum(POST_MODULES),
  type: z.enum(DRILL_TYPES),
  config: drillTypeConfigSchema.optional().default({}),
  questions: z.array(questionResultSchema).optional().default([]),
  responses: z.array(llmResponseSchema).optional().default([]),
  drillData: z.any().optional(),
  // Memory drills: which memory item this task drilled, so the session-submit
  // path can map the result back and advance that item's spaced-repetition
  // schedule (mirrors the dedicated MemoryBuilder practice flow). Absent for
  // every other drill type.
  memoryItemId: z.string().optional(),
  score: z.number().min(0).max(100).optional(),
  // Separated performance metrics stored alongside the blended `score` (issue
  // #2094). The server always recomputes these from the drill answer key on
  // submit, so an incoming client value is advisory — accepted (optional,
  // nullable where a metric can be genuinely absent) rather than rejected, to
  // keep the request/stored shapes in parity. `accuracy`/`completion` are 0-1
  // fractions; `avgResponseMs`/`medianMs`/`bestMs` are milliseconds. The n-back
  // signal-detection counts and reaction-time latency extremes ride along too.
  accuracy: z.number().min(0).max(1).nullable().optional(),
  completion: z.number().min(0).max(1).nullable().optional(),
  avgResponseMs: z.number().min(0).nullable().optional(),
  answeredCount: z.number().int().min(0).optional(),
  totalCount: z.number().int().min(0).optional(),
  medianMs: z.number().min(0).nullable().optional(),
  bestMs: z.number().min(0).nullable().optional(),
  span: z.number().int().min(0).optional(),
  hits: z.number().int().min(0).optional(),
  misses: z.number().int().min(0).optional(),
  falseAlarms: z.number().int().min(0).optional(),
  correctRejections: z.number().int().min(0).optional(),
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
  // Client-generated session id (uuid) — keys the idempotent upsert in
  // submitPostSession so a retry after a dropped response can't double-record.
  // Optional for back-compat: legacy clients and direct service callers that
  // omit it get a server-assigned uuid.
  id: z.string().uuid().optional(),
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
  modules: z.array(z.enum(POST_MODULES)).min(1),
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

// Optional practice goals (issue #2100). Every field is optional so a config
// with no goals — or a legacy config that predates this block entirely — stays
// valid; bounds keep a hand-edited config from persisting a nonsensical target.
// Exported so the settings route / tests can validate a `goals` slice directly.
export const postGoalsSchema = z.object({
  dailyMinutes: z.number().int().min(1).max(1440).optional(),
  weeklySessions: z.number().int().min(1).max(100).optional(),
  streakTarget: z.number().int().min(1).max(3650).optional(),
  morseWpmTarget: z.number().min(1).max(100).optional(),
}).partial();

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
  sessionModules: z.array(z.enum(POST_MODULES)).optional(),
  // Optional practice goals (issue #2100) — see postGoalsSchema above.
  goals: postGoalsSchema.optional(),
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

// =============================================================================
// MORSE TRAINER PROGRESS VALIDATION
// =============================================================================

// Server-side ceiling for a Koch level — KOCH_ORDER in MorseTrainer.jsx has 41
// entries. Mirrors MAX_KOCH_LEVEL in meatspacePostMorse.js.
const MORSE_MAX_KOCH_LEVEL = 41;

// One recorded prompt→guess character within a Morse round. `guessed` is
// nullable ('' or null = a miss, distinct from a wrong character); `sent` may be
// '' for an insertion (an extra typed character with no transmitted counterpart)
// — the server drops empty-sent items from the confusion matrix but still counts
// them against round accuracy. The `sent` key must still be present (a missing
// key is rejected); the server recomputes `correct` from the pair, so it's
// advisory here.
const morseRoundItemSchema = z.object({
  sent: z.string().max(8),
  guessed: z.string().max(16).nullable().optional(),
  correct: z.boolean().optional(),
  responseMs: z.number().min(0).optional().default(0),
});

// A completed copy/head-copy/send round the client submits on finish.
export const morseRoundSchema = z.object({
  mode: z.enum(['copy', 'head-copy', 'send']),
  kochLevel: z.number().int().min(1).max(MORSE_MAX_KOCH_LEVEL).optional(),
  wpm: z.number().min(1).max(100).optional(),
  farnsworthWpm: z.number().min(1).max(100).optional(),
  // Bounded so a malformed client can't write (and then re-aggregate on every
  // progress read) an unbounded array. A legit round tops out well under this:
  // copy is 10 questions × ≤5-char groups (≈50, doubled by insertions), send is
  // one short prompt — 200 leaves generous headroom.
  items: z.array(morseRoundItemSchema).min(1).max(200),
  durationMs: z.number().min(0).optional().default(0),
});

// Explicit Koch level change (advance/reset) or a one-time localStorage adoption
// (`adopt: true` — server only applies it when it has never had a level).
export const morseLevelUpdateSchema = z.object({
  kochLevel: z.number().int().min(1).max(MORSE_MAX_KOCH_LEVEL),
  adopt: z.boolean().optional().default(false),
  settings: z.object({
    wpm: z.number().min(1).max(100).optional(),
    farnsworthWpm: z.number().min(1).max(100).optional(),
    toneHz: z.number().min(100).max(2000).optional(),
  }).optional(),
});

// =============================================================================
// PROGRESS DASHBOARD QUERY (issue #2091)
// =============================================================================

// GET /post/progress query params. `days` clamps like /post/stats: a NaN /
// missing value falls back to the 90-day default, a value >365 is clamped, and
// <=0 means all-time (0). `bucket` is forward-compat (only day buckets today).
export const postProgressQuerySchema = z.object({
  days: z.preprocess((v) => {
    if (v == null || v === '') return 90;
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return 90;
    if (n <= 0) return 0;
    return Math.min(n, 365);
  }, z.number().int()),
  bucket: z.enum(['day']).optional().default('day'),
});

// Per-question breakdown for a training-log entry (issue #2114 — follow-up to
// #2097, which only persisted round-level aggregates). Optional and additive:
// entries without it (legacy rows, and non-wordplay training modules that
// never populate it) must stay valid. Field names mirror llmResponseSchema
// above (the shape scored POST sessions store per LLM-drill question) so a
// future progress dashboard can render training-log and scored-session
// breakdowns with the same renderer rather than inventing a training-only shape.
const trainingQuestionSchema = z.object({
  prompt: z.string().optional(),
  response: z.string().optional(),
  items: z.array(z.string()).optional(),
  responseMs: z.number().min(0).optional(),
  score: z.number().min(0).max(100).optional(),
  feedback: z.string().optional(),
  correct: z.boolean().optional(),
});

// Training log entry submission
export const trainingEntrySchema = z.object({
  module: z.string(),
  // Training log entries also cover Morse (client-side scored, never a scored
  // POST session) — union in MORSE_DRILL_TYPES here rather than in the shared
  // DRILL_TYPES so postSessionSubmitSchema/postDrillRequestSchema can't accept
  // a Morse type (see the MORSE_DRILL_TYPES comment above).
  drillType: z.enum([...DRILL_TYPES, ...MORSE_DRILL_TYPES]),
  questionCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  totalMs: z.number().min(0),
  questions: z.array(trainingQuestionSchema).optional(),
});

export { LLM_DRILL_TYPES, MATH_DRILL_TYPES, MEMORY_DRILL_TYPES, POST_SUPPORTED_MEMORY_TYPES, POST_MODULES, COGNITIVE_DRILL_TYPES, MORSE_DRILL_TYPES };
