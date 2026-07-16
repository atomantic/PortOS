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

// Phase 1 supports `video` only. The enum is deliberately narrow so a user can't
// create a commission that silently never runs — Phase 3/4 widen it (image,
// universe, series, story, writers-room, music) alongside the ability adapter.
export const CREATIVE_COMMISSION_ABILITIES = Object.freeze(['video']);

// Schedule cadence kinds. DAILY/WEEKLY are composed into a cron by the service;
// CUSTOM carries a raw 5-field cron the service validates via isValidCron.
export const CREATIVE_COMMISSION_SCHEDULE_KINDS = Object.freeze(['DAILY', 'WEEKLY', 'CUSTOM']);

export const CREATIVE_COMMISSION_QUALITIES = Object.freeze(['draft', 'standard', 'high']);
export const CREATIVE_COMMISSION_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);

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

// Render knobs handed to the CD project the commission mints each fire. `model`
// is the CD video modelId (an LTX variant); absent → the install's default video
// model at fire time.
// No object-level `.default({})` here: it would inject a `generation: {}` key
// even when the caller omits generation, which makes an empty PATCH body parse
// non-empty (defeating the update schema's "at least one field" refine) and
// forces every update to rewrite generation. sanitizeCommission fills the
// generation defaults instead; the per-field defaults still apply when the
// object IS present but partial.
export const creativeCommissionGenerationSchema = z.object({
  model: z.string().trim().max(64).nullable().optional(),
  quality: z.enum(CREATIVE_COMMISSION_QUALITIES).default('standard'),
  aspectRatio: z.enum(CREATIVE_COMMISSION_ASPECT_RATIOS).default('16:9'),
  targetDurationSeconds: z.number().int().min(5).max(600).default(10),
});

// Generation schema for the UPDATE path: no per-field defaults, so a partial
// `PATCH { generation: { quality: 'draft' } }` doesn't materialize `aspectRatio`
// / `targetDurationSeconds` defaults that would overwrite stored values in the
// service merge — same absent-vs-empty rule as the brief update schema.
export const creativeCommissionGenerationUpdateSchema = z.object({
  model: z.string().trim().max(64).nullable().optional(),
  quality: z.enum(CREATIVE_COMMISSION_QUALITIES).optional(),
  aspectRatio: z.enum(CREATIVE_COMMISSION_ASPECT_RATIOS).optional(),
  targetDurationSeconds: z.number().int().min(5).max(600).optional(),
});

export const creativeCommissionCreateSchema = z.object({
  name: z.string().trim().min(1).max(COMMISSION_NAME_MAX),
  enabled: z.boolean().default(true),
  targetAbility: z.enum(CREATIVE_COMMISSION_ABILITIES).default('video'),
  brief: creativeCommissionBriefSchema,
  schedule: creativeCommissionScheduleSchema,
  generation: creativeCommissionGenerationSchema.optional(),
  // How many recent feedback reactions the directive builder folds into the next
  // run's prompt (Phase 2 populates `feedback`; kept here so the field is stable
  // and editable from creation). 0 disables conditioning.
  feedbackWindow: z.number().int().min(0).max(50).default(5),
});

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
  feedbackWindow: z.number().int().min(0).max(50).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });
