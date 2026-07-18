import { z } from 'zod';

// =============================================================================
// CREATIVE COMMISSION SCHEMAS (Autonomous Creation Engine — #2657, Phase 1)
// =============================================================================
// A CreativeCommission is a *standing, recurring creative brief* that fires on a
// schedule and drives the Creative Director's directive pipeline unattended. It
// is the sanctioned scheduled-automation exception to the "no cold LLM calls"
// policy: it only ever runs because the user created it, and it never generates
// at boot (the scheduler arms a cron; nothing fires until the cadence elapses).
//
// This module is a leaf (like creativeDirectorValidation.js): it must NOT import
// back from validation.js — validation.js re-exports it, and ESM hoists
// `export * from`, so a read-back here would hit the TDZ. It also stays free of
// heavy service imports (eventScheduler, etc.) so pulling it into a mocked test
// suite doesn't drag the scheduler graph along. The authoritative cron-validity
// check (isValidCron) lives in the service layer, not here.

// Supported creative-output types (#2769). Each is backed by an ability adapter
// (server/services/creativeCommissions/abilityAdapters.js) that owns its
// generation params, its CD directive, and its createProject mapping. `video`
// stays first so it remains the default and pre-#2769 records (which have no
// explicit type or default to `video`) keep running unchanged. The broader set
// the original Phase-1 note named (`universe`, `story`, `writers-room`) stays
// future work under epic #2657 — only the five the request enumerated ship here.
export const CREATIVE_COMMISSION_ABILITIES = Object.freeze(['video', 'image', 'music', 'music-video', 'series']);

// Schedule cadence kinds. DAILY/WEEKLY are composed into a cron by the service;
// CUSTOM carries a raw 5-field cron the service validates via isValidCron.
export const CREATIVE_COMMISSION_SCHEDULE_KINDS = Object.freeze(['DAILY', 'WEEKLY', 'CUSTOM']);

export const CREATIVE_COMMISSION_QUALITIES = Object.freeze(['draft', 'standard', 'high']);
export const CREATIVE_COMMISSION_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);

// Per-KEY generation descriptor — the SINGLE SOURCE OF TRUTH for a generation
// param's type, bounds, and default. Everything else derives from this: the Zod
// superset (`creativeCommissionGenerationSchema`), the per-ability key lists +
// defaults (`ABILITY_GENERATION_SPEC`), and the ability adapter's data-driven
// `sanitizeGeneration`. Keeping the bounds here (not re-typed in the schema AND
// the adapter AND the client) is what stops the four-way drift. The client
// (commissionForm.js) mirrors these values in its own package — kept in sync by
// hand; there is no cross-package import.
export const GENERATION_KEY_DEFS = Object.freeze({
  quality: { type: 'enum', values: CREATIVE_COMMISSION_QUALITIES, default: 'standard' },
  aspectRatio: { type: 'enum', values: CREATIVE_COMMISSION_ASPECT_RATIOS, default: '16:9' },
  targetDurationSeconds: { type: 'int', min: 5, max: 600, default: 10 },
  imageCount: { type: 'int', min: 1, max: 6, default: 1 },
  lengthSeconds: { type: 'int', min: 5, max: 600, default: 30 },
  episodeCount: { type: 'int', min: 1, max: 6, default: 1 },
});

// Which keys each output type carries (the universal `model` is added separately
// — every type accepts an optional engine/model override). The adapter fills
// these keys' defaults and preserves only them.
const ABILITY_GENERATION_KEYS = Object.freeze({
  video: ['quality', 'aspectRatio', 'targetDurationSeconds'],
  image: ['quality', 'aspectRatio', 'imageCount'],
  music: ['lengthSeconds'],
  'music-video': ['quality', 'aspectRatio', 'targetDurationSeconds'],
  series: ['episodeCount'],
});

// Derived per-ability { keys, defaults } view — the shape the store sanitizer and
// tests consume. Built from GENERATION_KEY_DEFS so a default only ever lives in
// one place.
export const ABILITY_GENERATION_SPEC = Object.freeze(
  Object.fromEntries(Object.entries(ABILITY_GENERATION_KEYS).map(([ability, keys]) => [ability, {
    keys,
    defaults: Object.fromEntries(keys.map((k) => [k, GENERATION_KEY_DEFS[k].default])),
  }])),
);

// Keys allowed for a given ability (the spec keys + the universal `model`). Used
// by the create-path superRefine to flag a param that doesn't belong to the type.
export function generationKeysForAbility(ability) {
  const spec = ABILITY_GENERATION_SPEC[ability] || ABILITY_GENERATION_SPEC.video;
  return ['model', ...spec.keys];
}

// Build a Zod field for one generation-key descriptor (optional in the superset;
// per-ability strictness is applied by the create-path superRefine, not here).
function generationFieldSchema(def) {
  return def.type === 'enum'
    ? z.enum(def.values).optional()
    : z.number().int().min(def.min).max(def.max).optional();
}

export const COMMISSION_NAME_MAX = 200;
export const COMMISSION_INTENT_MAX = 2000;

// The brief the commission steers by. `intent` is the free-text core ("something
// surreal, dreamlike, unsettlingly beautiful"); `genre`/`category` are optional
// lightweight tags (a real taxonomy arrives in Phase 5); `styleSpec` maps to the
// CD project's styleSpec; `constraints` scopes the run to a universe/series.
export const creativeCommissionBriefSchema = z.object({
  intent: z.string().trim().min(1).max(COMMISSION_INTENT_MAX),
  genre: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  styleSpec: z.string().max(5000).default(''),
  constraints: z.object({
    universeId: z.string().max(120).nullable().optional(),
    seriesId: z.string().max(120).nullable().optional(),
  }).default({}),
  // Catalog ingredient ids to seed future generations from (Phase 3+ folds these
  // into the CD cast). Accepted now so the record shape is forward-stable.
  seedRefs: z.array(z.string().trim().max(64)).max(50).default([]),
});

// A cadence descriptor. Per-kind fields are validated in `superRefine` so a
// DAILY schedule can't omit its time and a CUSTOM one can't omit its cron. The
// resulting cron string (and its final isValidCron check) is computed in the
// service; here we only assert the shape is internally consistent.
export const creativeCommissionScheduleSchema = z.object({
  kind: z.enum(CREATIVE_COMMISSION_SCHEDULE_KINDS),
  // 'HH:MM' 24h local time for DAILY/WEEKLY.
  atLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)').optional(),
  // 0 (Sunday) .. 6 (Saturday) for WEEKLY.
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  // DAILY only: restrict to Mon–Fri.
  weekdaysOnly: z.boolean().optional().default(false),
  // CUSTOM only: a raw 5-field cron. Loosely bounded here; isValidCron is the
  // authority (service layer).
  cron: z.string().trim().max(120).optional(),
  // IANA tz; null/absent falls back to the user's configured timezone at fire.
  timezone: z.string().max(64).nullable().optional(),
}).superRefine((val, ctx) => {
  if (val.kind === 'DAILY' && !val.atLocalTime) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['atLocalTime'], message: 'DAILY schedule requires atLocalTime' });
  }
  if (val.kind === 'WEEKLY') {
    if (!val.atLocalTime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['atLocalTime'], message: 'WEEKLY schedule requires atLocalTime' });
    if (val.weekday == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['weekday'], message: 'WEEKLY schedule requires weekday (0–6)' });
  }
  if (val.kind === 'CUSTOM' && !val.cron) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cron'], message: 'CUSTOM schedule requires a cron expression' });
  }
  // Reject an invalid IANA timezone at the request boundary — eventScheduler
  // passes it to Intl.DateTimeFormat, which throws RangeError on a bad zone; a
  // bad value persisted here would wedge the whole scheduler sync at register
  // time. Intl is a global, so this keeps the module a dependency-free leaf.
  if (val.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: val.timezone }); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timezone'], message: 'invalid IANA timezone' }); }
  }
});

// Render knobs handed to the CD project the commission mints each fire. This is
// a SUPERSET over every output type's params (#2769) — each field is validated
// for type/enum/range but left optional, and which fields actually apply is
// decided per-ability by the create-path superRefine (below) and the adapter's
// `sanitizeGeneration`. `model` is a universal optional engine/model override
// (the CD video modelId — an LTX variant — for video; absent → the install's
// default at fire time).
// No object-level `.default({})` and NO per-field defaults here: a `.default({})`
// would inject a `generation: {}` key even when the caller omits generation,
// making an empty PATCH body parse non-empty (defeating the update schema's "at
// least one field" refine), and field defaults would overwrite stored values on
// a partial PATCH (the absent-vs-empty footgun). sanitizeCommission fills the
// per-ability defaults instead. The create and update paths share the same
// superset (the create-path per-ability strictness is added by the superRefine
// on the create schema, not here) so a type-specific key like `imageCount` or
// `episodeCount` is never silently stripped before it reaches sanitizeCommission.
export const creativeCommissionGenerationSchema = z.object({
  model: z.string().trim().max(64).nullable().optional(),
  // Every generation key, derived from GENERATION_KEY_DEFS so the bounds live in
  // exactly one place (see the drift note there).
  ...Object.fromEntries(Object.entries(GENERATION_KEY_DEFS).map(([key, def]) => [key, generationFieldSchema(def)])),
});

// The UPDATE path shares the same superset — every field optional, no defaults —
// so a partial `PATCH { generation: { quality: 'draft' } }` doesn't materialize
// other keys that would overwrite stored values in the service merge, and a
// type-specific key still round-trips. (A PATCH may omit `targetAbility`, so the
// per-ability strictness the create superRefine adds can't run here; the
// adapter's `sanitizeGeneration` is the backstop that drops off-type keys.)
export const creativeCommissionGenerationUpdateSchema = creativeCommissionGenerationSchema;

// Reusable superRefine: when `generation` is present, reject any key that does
// not belong to the chosen `targetAbility` (per ABILITY_GENERATION_SPEC), so a
// mistaken param (e.g. `targetDurationSeconds` on an `image` commission, or
// `episodeCount` on a `video` one) is a 400 at the boundary rather than silently
// dropped by the sanitizer. Runs only where the ability is known (the create
// schema, whose `targetAbility` defaults to `video`).
function pushOffTypeKeyIssues(generation, ability, ctx) {
  const allowed = new Set(generationKeysForAbility(ability));
  for (const key of Object.keys(generation)) {
    if (!allowed.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['generation', key],
        message: `'${key}' is not a valid generation param for a '${ability}' commission`,
      });
    }
  }
}

// Create path: `targetAbility` always resolves (defaults to `video`), so the
// generation keys are always checkable.
function refineGenerationForAbility(data, ctx) {
  if (!data || typeof data.generation !== 'object' || data.generation === null) return;
  pushOffTypeKeyIssues(data.generation, data.targetAbility || 'video', ctx);
}

// Update path: only check when the PATCH ALSO sets `targetAbility` — then the
// pairing is unambiguous (e.g. `{ targetAbility: 'image', generation: {
// targetDurationSeconds } }` is a mistake we can reject). When the PATCH omits
// `targetAbility`, the effective type is the stored record's, which the schema
// can't see; the adapter's `sanitizeGeneration` drops any off-type key as the
// backstop (a harmless no-op, not a corruption).
function refineGenerationForAbilityIfTargetPresent(data, ctx) {
  if (!data || typeof data.generation !== 'object' || data.generation === null) return;
  if (!data.targetAbility) return;
  pushOffTypeKeyIssues(data.generation, data.targetAbility, ctx);
}

// The LLM provider/model that PROCESSES the commission — i.e. the Creative
// Director cognitive stages (treatment + production plan) the scheduled fire
// runs as CoS agent tasks. `providerId`/`model` are the same shape the CD
// project carries as `modelOverrides.{treatment,plan}` (a `{ providerId, model }`
// pin); the scheduler fans this single pin onto both cognitive stages at fire
// time. Both keys nullable/optional — an unset `providerId` means "inherit the
// install's default AI Assignment" (preserving the pre-#2657 system-default
// behavior). The picker only shows agent-harness (CLI/TUI) providers because an
// API-type provider injected into an agent task trips the harness-boundary guard
// (see agentBridge.js). Bounded to 120 chars like the CD project pin.
export const creativeCommissionAssignmentSchema = z.object({
  providerId: z.string().trim().max(120).nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
});

export const creativeCommissionCreateSchema = z.object({
  name: z.string().trim().min(1).max(COMMISSION_NAME_MAX),
  enabled: z.boolean().default(true),
  targetAbility: z.enum(CREATIVE_COMMISSION_ABILITIES).default('video'),
  brief: creativeCommissionBriefSchema,
  schedule: creativeCommissionScheduleSchema,
  generation: creativeCommissionGenerationSchema.optional(),
  // Optional LLM provider/model pin for the CD cognitive stages. Absent → the
  // install default AI Assignment processes the commission.
  assignment: creativeCommissionAssignmentSchema.optional(),
  // How many recent feedback reactions the directive builder folds into the next
  // run's prompt (Phase 2 populates `feedback`; kept here so the field is stable
  // and editable from creation). 0 disables conditioning.
  feedbackWindow: z.number().int().min(0).max(50).default(5),
}).superRefine(refineGenerationForAbility);

// Brief schema for the UPDATE path: every field optional and — critically — NO
// defaults. The create-path `creativeCommissionBriefSchema` defaults
// `constraints`/`seedRefs`/`styleSpec`, which on a PATCH would inject those keys
// even when the client omitted them, so the service's `{ ...current.brief,
// ...patch.brief }` merge would overwrite a stored `constraints.universeId` with
// an empty default (the absent-vs-empty footgun). With no defaults here, an
// omitted key stays omitted and the merge preserves the stored value.
export const creativeCommissionBriefUpdateSchema = z.object({
  intent: z.string().trim().min(1).max(COMMISSION_INTENT_MAX).optional(),
  genre: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  styleSpec: z.string().max(5000).optional(),
  constraints: z.object({
    universeId: z.string().max(120).nullable().optional(),
    seriesId: z.string().max(120).nullable().optional(),
  }).optional(),
  seedRefs: z.array(z.string().trim().max(64)).max(50).optional(),
});

// A user reaction to a specific commission run (#2657, Phase 2 — the taste
// feedback loop). `runId` is required: the UI always rates a specific run, and
// the service verifies the run exists on the record. `rating` is 'up'/'down' or
// a non-zero score (numeric ratings are preserved verbatim so the directive
// digest's >0/<0 test still applies); a 0 score is rejected as meaningless. The
// note is the steering signal ("less horror, more Magritte") folded into the
// next run's prompt.
export const COMMISSION_FEEDBACK_NOTE_MAX = 1000;
export const commissionFeedbackSchema = z.object({
  runId: z.string().trim().min(1).max(120),
  rating: z.union([z.enum(['up', 'down']), z.number().int().min(-5).max(5)]),
  note: z.string().trim().max(COMMISSION_FEEDBACK_NOTE_MAX).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
}).superRefine((val, ctx) => {
  if (typeof val.rating === 'number' && val.rating === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rating'], message: 'rating must be non-zero (up/down)' });
  }
});

// PATCH: every field optional; at least one must be present. `.partial()` on a
// ZodEffects (the schedule uses superRefine) isn't available, so we rebuild the
// object rather than call `.partial()` on the whole create schema.
export const creativeCommissionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(COMMISSION_NAME_MAX).optional(),
  enabled: z.boolean().optional(),
  targetAbility: z.enum(CREATIVE_COMMISSION_ABILITIES).optional(),
  brief: creativeCommissionBriefUpdateSchema.optional(),
  schedule: creativeCommissionScheduleSchema.optional(),
  generation: creativeCommissionGenerationUpdateSchema.optional(),
  // Whole-object replace on the service side (a clear sends `{ providerId: null,
  // model: null }`), so no separate no-defaults update variant is needed.
  assignment: creativeCommissionAssignmentSchema.optional(),
  feedbackWindow: z.number().int().min(0).max(50).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' })
  .superRefine(refineGenerationForAbilityIfTargetPresent);
