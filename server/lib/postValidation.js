import { z } from 'zod';
import { CACHEABLE_TYPES, COGNITIVE_DRILL_TYPES } from './postDrillTypes.js';
import { TOPIC_IDS } from './postTopics.js';
import { HHMM_STRICT_RE } from './timezone.js';
import { POST_LLM_MAX_SEMANTIC_CANDIDATES, postLlmEvaluationSchema } from './postLlmContracts.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { RHETORIC_DRILL_TYPES, RHETORIC_MODE_IDS, rhetoricEvaluationSchema } from './postRhetoric.js';

// =============================================================================
// POST (Power On Self Test) VALIDATION SCHEMAS
// =============================================================================

// Legacy free-text tags for session conditions (sleep, caffeine, stress, etc.).
// Superseded by `postConditionsSchema` below — kept only so historical session
// records (and any client that still sends it) remain valid; the launcher no
// longer writes free-text values here.
export const postTagsSchema = z.record(z.string().max(200));

// Structured session conditions (issue #4442): fixed enums instead of free
// text so values are filterable/comparable across sessions, plus an optional
// note for anything the enums don't capture. Every field is optional — a
// session with no conditions filled in submits `{}`/`undefined`, not a
// placeholder-filled object.
export const postConditionsSchema = z.object({
  sleepQuality: z.enum(['poor', 'fair', 'good']).optional(),
  caffeine: z.enum(['none', 'low', 'moderate', 'high']).optional(),
  stress: z.enum(['low', 'moderate', 'high']).optional(),
  note: z.string().trim().max(500).optional(),
});

// 24h "HH:MM" time-of-day — HHMM_STRICT_RE is timezone.js's single source of
// truth for this exact zero-padded pattern (shared with dashboardLayouts.js's
// activateWindow validator); don't re-derive a local copy.

// Individual question result (math + memory drills)
// Math: server recomputes expected/correct via scoreDrill (numeric values)
// Memory: client scores with string comparison (text values)
const fillBlankAnswerSchema = z.object({
  // `index` is the source question's answer index, not the position in the
  // submitted array. Keeping it stable makes partial answers attributable even
  // when a client submits them out of order.
  index: z.number().int().min(0),
  value: z.string().nullable(),
  expected: z.string().optional(),
  correct: z.boolean().optional(),
  element: z.string().nullable().optional(),
});

const questionResultSchema = z.object({
  prompt: z.string(),
  // Cognitive drills key each trial back to its position in the generated
  // drillData (n-back sequence index, digit-span/stroop trial index) so the
  // server can recompute the answer key. Absent for math/memory drills.
  index: z.number().int().min(0).optional(),
  expected: z.union([z.number(), z.string()]).optional(),
  // Fill-blank now submits one indexed entry per generated blank. The scalar
  // forms remain valid for old clients and are intentionally treated as one
  // attributable attempt by the memory service, never as a full prompt pass.
  answered: z.union([z.number(), z.string(), z.array(fillBlankAnswerSchema)]).nullable(),
  correct: z.boolean().optional(),
  responseMs: z.number().min(0),
  // Reaction-time drill only: player pressed before the stimulus appeared.
  // Always scored wrong server-side regardless of any client-supplied correct.
  falseStart: z.boolean().optional(),
  // Executive-control drill evidence. These are server-recomputed from the
  // seeded generated trial, but remain in the stored per-question record so
  // progress/history can explain switch and congruency costs.
  rule: z.enum(['color', 'shape', 'fill']).optional(),
  switched: z.boolean().optional(),
  incongruent: z.boolean().optional(),
  congruent: z.boolean().optional(),
  noGo: z.boolean().optional(),
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
  prompt: z.string().max(5000).optional(),
  response: z.string().max(10000).optional(),
  answers: z.array(z.string().max(1000)).max(100).optional(),
  items: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  responseMs: z.number().min(0).optional().default(0),
  llmScore: z.number().min(0).max(100).optional(),
  llmFeedback: z.string().max(2000).optional()
});

// Drill type configuration
const MATH_DRILL_TYPES = ['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation', 'applied-numeracy'];
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
// of being rejected. Morse and rhetoric only ever post through
// trainingEntrySchema below.
const MORSE_DRILL_TYPES = ['morse-copy', 'morse-head-copy', 'morse-send'];
// Rhetoric is a standalone training surface. It never enters a scored POST
// session; its self-score and optional evaluator report use the shared training
// log endpoint for streaks and progress reporting.

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
  // Executive-control generators support up to 60 trials. This shared config
  // schema must accept every generated config on the scored-session round-trip.
  count: z.number().int().min(1).max(60).optional(),
  maxDigits: z.number().int().min(1).max(4).optional(),
  // Progressive multiplication ladder (server/lib/postMultiplicationLadder.js).
  // `progressive` is the config toggle; `level`/`factors` are server-computed
  // effective config stamped into the generated drill (and stored per-task on
  // session submit), so they must survive validation on the round-trip.
  progressive: z.boolean().optional(),
  level: z.number().int().min(0).max(50).optional(),
  technique: z.string().max(100).optional(),
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
  // Applied Numeracy uses an unsigned numeric replay key while the cognitive
  // generators use bounded string seeds. This shared config must preserve both
  // shapes on the request and scored-session round-trips.
  seed: z.union([
    z.string().max(100),
    z.number().int().min(0).max(0xFFFFFFFF),
  ]).optional(),
  difficulty: z.number().int().min(1).max(3).optional(),
  family: z.enum(['percentage', 'ratio', 'unit', 'rate', 'estimate', 'mixed']).optional(),
  // --- Cognitive drill knobs (n-back / digit-span / stroop) ---
  // Bounds match the generator clamps in meatspacePostCognitive.js so the UI /
  // API can't accept a value the generator will silently narrow. Exception:
  // `length`'s effective floor is `n + 5` (dynamic, up to 8) inside the
  // generator — Zod can't express a cross-field minimum here, so this schema
  // keeps a conservative fixed floor of 6 and lets the generator clamp up.
  // (timeLimitSec above is validated but NOT enforced for these drill types —
  // they're self-paced/stimulus-driven; see PostCognitiveDrillRunner.jsx.)
  // stimulusMs (n-back / Go-No-Go) and showMs (digit-span) are the
  // presentation-speed knobs. The lower bound covers Go/No-Go's brief signals;
  // each generator still applies its drill-specific clamp.
  // The progressive ladder (default ON) drives them per rung; manual mode
  // (progressive off) exposes them in the config UI (issue #2095), so they must
  // survive validation. Bounds span the generator clamps in
  // meatspacePostCognitive.js (generateNBack / generateGoNoGo).
  n: z.number().int().min(1).max(3).optional(),
  stimulusMs: z.number().int().min(100).max(5000).optional(),
  showMs: z.number().int().min(400).max(4000).optional(),
  length: z.number().int().min(6).max(60).optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  startLength: z.number().int().min(3).max(9).optional(),
  maxLength: z.number().int().min(3).max(12).optional(),
  // --- Cognitive drill knobs (schulte-table / mental-rotation / reaction-time) ---
  size: z.number().int().min(3).max(7).optional(),
  incongruentPct: z.number().int().min(0).max(100).optional(),
  rotationComplexity: z.number().int().min(1).max(3).optional(),
  optionCount: z.number().int().min(2).max(4).optional(),
  mode: z.enum(['simple', 'choice']).optional(),
  minDelayMs: z.number().int().min(300).max(5000).optional(),
  maxDelayMs: z.number().int().min(300).max(8000).optional(),
  choices: z.number().int().min(2).max(4).optional(),
  ruleCount: z.number().int().min(2).max(3).optional(),
  switchRatePct: z.number().int().min(0).max(100).optional(),
  cueStimulusIntervalMs: z.number().int().min(100).max(2000).optional(),
  responseDeadlineMs: z.number().int().min(500).max(5000).optional(),
  noGoPct: z.number().int().min(5).max(80).optional(),
  lureSimilarity: z.enum(['low', 'high']).optional(),
  congruentPct: z.number().int().min(0).max(100).optional(),
  flankerDistance: z.number().int().min(1).max(4).optional(),
  flankerStrength: z.number().int().min(1).max(3).optional(),
});

// Task result within a session
// score is optional — the server recomputes it via scoreDrill
const taskResultSchema = z.object({
  // Stable client attempt id. Optional for legacy scored-session clients; the
  // store derives a deterministic id from run id + position when absent.
  id: z.string().min(1).max(200).optional(),
  module: z.enum(POST_MODULES),
  type: z.enum(DRILL_TYPES),
  config: drillTypeConfigSchema.optional().default({}),
  questions: z.array(questionResultSchema).optional().default([]),
  responses: z.array(llmResponseSchema).max(50).optional().default([]),
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
  attemptCount: z.number().int().min(0).optional(),
  errorCount: z.number().int().min(0).optional(),
  medianMs: z.number().min(0).nullable().optional(),
  bestMs: z.number().min(0).nullable().optional(),
  span: z.number().int().min(0).optional(),
  hits: z.number().int().min(0).optional(),
  misses: z.number().int().min(0).optional(),
  falseAlarms: z.number().int().min(0).optional(),
  correctRejections: z.number().int().min(0).optional(),
  omissions: z.number().int().min(0).optional(),
  commissionErrors: z.number().int().min(0).optional(),
  switchCostMs: z.number().nullable().optional(),
  switchAccuracy: z.number().min(0).max(1).nullable().optional(),
  repeatAccuracy: z.number().min(0).max(1).nullable().optional(),
  congruencyCostMs: z.number().nullable().optional(),
  congruentAccuracy: z.number().min(0).max(1).nullable().optional(),
  incongruentAccuracy: z.number().min(0).max(1).nullable().optional(),
  falseAlarmRate: z.number().min(0).max(1).nullable().optional(),
  latencyDistributionMs: z.array(z.number().min(0)).max(500).optional(),
  hintUsed: z.boolean().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  inputMode: z.string().min(1).max(50).optional(),
  scorerProvenance: z.string().min(1).max(100).optional(),
  evaluation: postLlmEvaluationSchema.optional(),
  totalMs: z.number().min(0)
}).superRefine((task, ctx) => {
  if (!LLM_DRILL_TYPES.includes(task.type)) return;
  if (!task.evaluation) {
    ctx.addIssue({ code: 'custom', path: ['evaluation'], message: 'scored LLM drills require an evaluation' });
  }
  if (task.score === undefined) {
    ctx.addIssue({ code: 'custom', path: ['score'], message: 'scored LLM drills require a score' });
  }
  if (task.evaluation && task.evaluation.scores.length !== task.responses.length) {
    ctx.addIssue({ code: 'custom', path: ['evaluation', 'scores'], message: 'evaluation score count must match response count' });
  }
  task.responses.forEach((response, index) => {
    if (response.llmScore === undefined) {
      ctx.addIssue({ code: 'custom', path: ['responses', index, 'llmScore'], message: 'scored LLM responses require llmScore' });
    }
  });
});

// Full session submission
export const POST_QUICK_DURATION_MINUTES = [3, 5, 10, 15];
const postQuickDurationSchema = z.union(POST_QUICK_DURATION_MINUTES.map(minutes => z.literal(minutes)));

export const postQuickSessionPlanSchema = z.object({
  targetDurationSec: z.number().int().min(1).max(3600),
  estimatedDurationSec: z.number().min(0).max(3600),
  toleranceSec: z.number().int().min(0).max(600),
  omittedDomains: z.array(z.string().max(100)).max(20),
  omittedReviews: z.array(z.string().max(200)).max(10).optional(),
  selectedTypes: z.array(z.string().max(100)).max(50),
});

// A benchmark is a versioned, fixed-form assessment. It is deliberately
// separate from the adaptive/Quick plan so benchmark history remains
// comparable even when a user's normal POST configuration changes.
export const postBenchmarkSchema = z.object({
  protocolId: z.string().trim().min(1).max(100),
  protocolVersion: z.number().int().min(1).max(100),
  scorerVersion: z.string().trim().min(1).max(100),
  formId: z.string().trim().min(1).max(100),
});

export const postSessionSubmitSchema = z.object({
  // Client-generated session id (uuid) — keys the idempotent upsert in
  // submitPostSession so a retry after a dropped response can't double-record.
  // Optional for back-compat: legacy clients and direct service callers that
  // omit it get a server-assigned uuid.
  id: z.string().uuid().optional(),
  cadence: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
  modules: z.array(z.enum(POST_MODULES)).min(1),
  tasks: z.array(taskResultSchema).min(1),
  tags: postTagsSchema.optional().default({}),
  conditions: postConditionsSchema.optional(),
  startedAt: z.string().datetime().optional(),
  plan: postQuickSessionPlanSchema.optional(),
  benchmark: postBenchmarkSchema.optional(),
});

// LLM drill type configuration
const llmDrillTypeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  count: z.number().int().min(1).max(20).optional(),
  timeLimitSec: z.number().int().min(10).max(600).optional(),
  providerId: z.string().optional(),
  model: z.string().optional()
});

// The evaluator is deliberately a separate opt-in block. Saving a provider or
// effort here must never make an existing POST screen start spending tokens:
// callers still have to set `enabled: true`, and the default config keeps it
// false.
export const postRhetoricEvaluatorConfigSchema = z.object({
  enabled: z.boolean().optional(),
  providerId: z.string().trim().max(300).nullable().optional(),
  model: z.string().trim().max(300).nullable().optional(),
  effort: z.preprocess(
    value => (value === '' ? undefined : value),
    z.enum(EFFORT_LEVELS).nullable().optional(),
  ),
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
  rhetoricEvaluator: postRhetoricEvaluatorConfigSchema.optional(),
  // Deterministic cognitive drills — no provider, so no provider/model fields.
  // Partial so an older browser's complete pre-executive-control map remains a
  // valid patch after newer drill types are added to the enum (Zod 4 records
  // with enum keys are otherwise exhaustive).
  cognitive: z.object({
    enabled: z.boolean().optional(),
    drillTypes: z.partialRecord(z.enum(COGNITIVE_DRILL_TYPES), drillTypeConfigSchema).optional()
  }).optional(),
  // Memory practice (issue #3252). Mirrors the other module blocks, plus an
  // `items` map so an INDIVIDUAL memorized text — e.g. the seeded Elements Song
  // — can be dropped from the daily rotation without deleting it (which would
  // throw away its mastery/schedule history). Keys are memory item ids, so this
  // is an open `z.string()` record rather than an enum.
  // `partialRecord`, not `record`: an enum-keyed `z.record` is EXHAUSTIVE in
  // zod 4 (every enum member required), which is why the sibling module blocks
  // above force their UI to write a complete drillTypes map. These blocks are
  // new, so they take the more forgiving contract — a patch may carry just the
  // one flag it is changing.
  memory: z.object({
    enabled: z.boolean().optional(),
    drillTypes: z.partialRecord(z.enum(MEMORY_DRILL_TYPES), drillTypeConfigSchema).optional(),
    // Keys are memory item ids — an open record, capped at the same 200 chars
    // every other id field here uses so a hand-edited config can't grow unbounded.
    items: z.record(z.string().max(200), z.object({ enabled: z.boolean().optional() })).optional()
  }).optional(),
  // Morse (issue #3252). Morse has no drill-type knobs here — its trainer owns
  // its own Koch settings — so the block is just the participation toggle that
  // suppresses the `morse-copy` stalled-progression recommendation.
  morse: z.object({
    enabled: z.boolean().optional()
  }).optional(),
  // Practice-topic participation (issue #3252) — the fine-grained "what am I
  // studying?" layer that sits ON TOP of the coarse `sessionModules` filter.
  // Absent entry = enabled (see server/lib/postTopics.js), so a config that
  // predates this key behaves exactly as before — additive, no migration.
  topics: z.partialRecord(z.enum(TOPIC_IDS), z.object({
    enabled: z.boolean().optional()
  })).optional(),
  sessionModules: z.array(z.enum(POST_MODULES)).optional(),
  quickDurationMin: postQuickDurationSchema.optional(),
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
  // the whole config PUT — same UI-sentinel-tolerance pattern AGENTS.md
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
  drillData: z.unknown(),
  responses: z.array(llmResponseSchema).min(1).max(50),
  timeLimitMs: z.number().min(1000),
  providerId: z.string().min(1).max(300).optional(),
  model: z.string().min(1).max(300).optional()
}).superRefine((request, ctx) => {
  if (!['compound-chain', 'verbal-fluency'].includes(request.type)) return;
  const itemCount = request.responses.reduce((sum, response) => sum + (response.items?.length || 0), 0);
  if (itemCount > POST_LLM_MAX_SEMANTIC_CANDIDATES) {
    ctx.addIssue({
      code: 'custom',
      path: ['responses'],
      message: `semantic drill responses support at most ${POST_LLM_MAX_SEMANTIC_CANDIDATES} items per scoring batch`,
    });
  }
});

// One attempt is sent at a time by the trainer. The browser deliberately does
// not await this request before advancing to the next prompt, so this is a
// bounded single-item contract rather than a batch evaluator endpoint.
export const postRhetoricEvaluationRequestSchema = z.object({
  attemptId: z.string().trim().min(1).max(200),
  mode: z.enum(RHETORIC_MODE_IDS),
  prompt: z.string().trim().min(1).max(1000),
  response: z.string().trim().min(1).max(10000),
  providerId: z.string().trim().min(1).max(300).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  effort: z.preprocess(
    value => (value === '' ? undefined : value),
    z.enum(EFFORT_LEVELS).nullable().optional(),
  ),
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
      recent: z.array(z.union([z.literal(0), z.literal(1)])).max(10).optional(),
      masteredAt: z.string().optional(),
      masterySource: z.enum(['verified', 'attested']).optional(),
    })).optional(),
    elements: z.record(z.object({
      correct: z.number().int().min(0),
      attempts: z.number().int().min(0),
      recent: z.array(z.union([z.literal(0), z.literal(1)])).max(10).optional(),
      masteredAt: z.string().optional(),
      masterySource: z.enum(['verified', 'attested']).optional(),
    })).optional(),
    retention: z.object({
      status: z.enum(['learning', 'attested', 'mastered', 'lapsed']),
      attestedAt: z.string().nullable().optional(),
      masteredAt: z.string().nullable().optional(),
      spotCheckAt: z.string().nullable().optional(),
      spotCheckCompletedAt: z.string().nullable().optional(),
      lapsedAt: z.string().nullable().optional(),
    }).optional(),
  }).optional(),
});

const practiceResultSchema = z.object({
  correct: z.boolean(),
  word: z.string().optional(),
  element: z.string().nullable().optional(),
  expected: z.string().optional(),
  answered: z.string().optional(),
  chunkId: z.string().optional(),
});

export const memoryPracticeSchema = z.object({
  // `element-study` is the standalone flash-card study mode (ElementsSong.jsx) —
  // logged like `learn` and intentionally does not advance mastery. It is NOT a
  // POST-session drill type (no server generator, see generateMemoryDrill).
  mode: z.enum(['fill-blank', 'sequence', 'element-flash', 'element-study', 'learn', 'speed-run']),
  chunkId: z.string().nullable().optional(),
  // Learn mode is an exposure event and legitimately has no scored results.
  // Every retrieval mode still needs at least one result.
  results: z.array(practiceResultSchema),
  totalMs: z.number().min(0).optional(),
}).superRefine((value, ctx) => {
  if (!['learn', 'element-study'].includes(value.mode) && value.results.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      minimum: 1,
      inclusive: true,
      origin: 'array',
      path: ['results'],
      message: 'Retrieval practice requires at least one result',
    });
  }
});

export const memoryMasteryAttestationSchema = z.object({
  acknowledged: z.literal(true),
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
  samplerVersion: z.string().max(40).optional(),
  materialMode: z.enum(['groups', 'words', 'callsigns', 'qso']).optional(),
  targetedChars: z.array(z.string().max(8)).max(41).optional(),
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
  id: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  response: z.string().optional(),
  items: z.array(z.string()).optional(),
  responseMs: z.number().min(0).optional(),
  selfRating: z.number().int().min(1).max(5).optional(),
  score: z.number().min(0).max(100).optional(),
  feedback: z.string().optional(),
  correct: z.boolean().optional(),
  evaluation: rhetoricEvaluationSchema.optional(),
  evaluationError: z.string().max(500).optional(),
});

// Training log entry submission
export const trainingEntrySchema = z.object({
  // Optional stable ids let newer callers retry through the legacy one-entry
  // adapter without duplication. Old callers remain valid and get server ids.
  id: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
  module: z.string(),
  // Training log entries also cover Morse (client-side scored, never a scored
  // POST session) — union in MORSE_DRILL_TYPES here rather than in the shared
  // DRILL_TYPES so postSessionSubmitSchema/postDrillRequestSchema can't accept
  // a Morse or rhetoric type (see the standalone-type comment above).
  drillType: z.enum([...DRILL_TYPES, ...MORSE_DRILL_TYPES, ...RHETORIC_DRILL_TYPES]),
  questionCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  totalMs: z.number().min(0),
  questions: z.array(trainingQuestionSchema).optional(),
  difficulty: z.record(z.string(), z.unknown()).nullable().optional(),
  configVersion: z.string().max(100).nullable().optional(),
  correct: z.boolean().nullable().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
  completion: z.number().min(0).max(1).nullable().optional(),
  hintUsed: z.boolean().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  inputMode: z.string().min(1).max(50).optional(),
  scorerProvenance: z.string().min(1).max(100).optional(),
});

const trainingAttemptSchema = z.object({
  id: z.string().min(1).max(200),
  module: z.string().min(1).max(100),
  drillType: z.enum([...DRILL_TYPES, ...MORSE_DRILL_TYPES, ...RHETORIC_DRILL_TYPES]),
  memoryItemId: z.string().min(1).max(200).nullable().optional(),
  difficulty: z.record(z.string(), z.unknown()).nullable().optional(),
  configVersion: z.string().max(100).nullable().optional(),
  questionCount: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  latencyMs: z.number().min(0),
  drillData: z.any().optional(),
  // Deterministic drills retain answer/latency detail for ladder/adaptive
  // evidence; wordplay keeps its established compact training-question shape.
  questions: z.array(z.union([questionResultSchema, trainingQuestionSchema])).max(500).optional(),
  correct: z.boolean().nullable().optional(),
  score: z.number().min(0).max(100).nullable().optional(),
  completion: z.number().min(0).max(1).nullable().optional(),
  hintUsed: z.boolean().optional().default(false),
  confidence: z.number().min(0).max(1).nullable().optional(),
  inputMode: z.string().min(1).max(50).optional().default('unknown'),
  scorerProvenance: z.string().min(1).max(100).optional().default('post-client'),
  accuracy: z.number().min(0).max(1).nullable().optional(),
  avgResponseMs: z.number().min(0).nullable().optional(),
  answeredCount: z.number().int().min(0).optional(),
  totalCount: z.number().int().min(0).optional(),
  attemptCount: z.number().int().min(0).optional(),
  errorCount: z.number().int().min(0).optional(),
  medianMs: z.number().min(0).nullable().optional(),
  bestMs: z.number().min(0).nullable().optional(),
  span: z.number().int().min(0).optional(),
  hits: z.number().int().min(0).optional(),
  misses: z.number().int().min(0).optional(),
  omissions: z.number().int().min(0).optional(),
  commissionErrors: z.number().int().min(0).optional(),
  falseAlarms: z.number().int().min(0).optional(),
  correctRejections: z.number().int().min(0).optional(),
  switchCostMs: z.number().nullable().optional(),
  switchAccuracy: z.number().min(0).max(1).nullable().optional(),
  repeatAccuracy: z.number().min(0).max(1).nullable().optional(),
  congruencyCostMs: z.number().nullable().optional(),
  congruentAccuracy: z.number().min(0).max(1).nullable().optional(),
  incongruentAccuracy: z.number().min(0).max(1).nullable().optional(),
  falseAlarmRate: z.number().min(0).max(1).nullable().optional(),
  latencyDistributionMs: z.array(z.number().min(0)).max(500).optional(),
}).superRefine((attempt, ctx) => {
  if (attempt.correctCount > attempt.questionCount) {
    ctx.addIssue({ code: 'custom', path: ['correctCount'], message: 'correctCount cannot exceed questionCount' });
  }
});

// Complete training-run batch. Validation finishes before the service opens a
// transaction, so malformed attempt N can never leave attempts 0..N-1 saved.
export const trainingRunSubmitSchema = z.object({
  id: z.string().uuid(),
  mode: z.literal('training').optional().default('training'),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  planned: z.object({
    modules: z.array(z.string().min(1).max(100)).max(20).optional(),
    drillTypes: z.array(z.enum([...DRILL_TYPES, ...MORSE_DRILL_TYPES])).max(100).optional(),
  }).optional(),
  attempts: z.array(trainingAttemptSchema).min(1).max(100),
}).superRefine((run, ctx) => {
  const ids = new Set();
  run.attempts.forEach((attempt, index) => {
    if (ids.has(attempt.id)) ctx.addIssue({ code: 'custom', path: ['attempts', index, 'id'], message: 'attempt ids must be unique within a run' });
    ids.add(attempt.id);
  });
  if (run.startedAt && run.completedAt && Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
    ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'completedAt cannot precede startedAt' });
  }
});

export { LLM_DRILL_TYPES, MATH_DRILL_TYPES, MEMORY_DRILL_TYPES, POST_SUPPORTED_MEMORY_TYPES, POST_MODULES, COGNITIVE_DRILL_TYPES, MORSE_DRILL_TYPES };
