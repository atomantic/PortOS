/**
 * Pipeline series routes — Series CRUD (the long-lived narrative bible),
 * duplicate detection/merge, title-logo generation, the per-series issue
 * list/create pair, and season CRUD.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest, optionalBooleanMap, llmSchema } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import { TRIM_SIZES, INTERIOR_FONTS } from '../../lib/proseExportSettings.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as seasonsSvc from '../../services/pipeline/seasons.js';
import { findDuplicateSeriesGroups, findSameNameSeries } from '../../services/duplicateDetection.js';
import { mergeSeries } from '../../services/recordMerge.js';
import { mergeFieldsWithAI } from '../../services/recordMergeAI.js';
import { generateSeriesTitleLogo } from '../../services/pipeline/seriesTitleLogo.js';
import { generateSeriesConcept } from '../../services/pipeline/seriesGenerate.js';
import { discoverSeriesVoice } from '../../services/pipeline/seriesVoiceDiscover.js';
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../../lib/issueLength.js';
import { ARC_LIMITS, ARC_STATUSES, ARC_SHAPE_IDS, SEASON_STATUSES } from '../../lib/storyArc.js';
import {
  CHARACTER_ARC_LIMITS, CHARACTER_ARC_STATUSES, TRANSITION_KINDS,
} from '../../lib/seriesCharacterArc.js';
import {
  STYLE_GUIDE_LIMITS, STYLE_GUIDE_TENSES, STYLE_GUIDE_POV_PERSONS, STYLE_GUIDE_AUDIENCES,
  STYLE_GUIDE_RATINGS, STYLE_GUIDE_PROFANITY, STYLE_GUIDE_SPELLING,
} from '../../lib/styleGuide.js';
import { mapServiceError } from './shared.js';

// Inline until better/code-quality lands and exports this from validation.js
const issuesListQuerySchema = z.object({
  offset: z.preprocess((v) => (v === undefined ? 0 : Number(v)), z.number().int().min(0)).default(0),
  limit: z.preprocess((v) => (v === undefined ? 1000 : Number(v)), z.number().int().min(1).max(1000)).default(1000),
});

const router = Router();

// ---- Series schemas ----
//
// Canon (characters / places / objects) is no longer carried on a series
// payload — it lives on the linked universe (Phase B.4). The bible-entry
// Zod shapes (`characterSchema` et al.) and the `BIBLE_KIND` plumbing moved
// out of this file when the series-side canon routes were retired.

// Arc + Season — phase 2 of Story Arc Planning. The arc lives on the series
// record itself; seasons get their own resource so the route layer can take
// per-record CRUD without forcing the caller to PATCH the whole series.
const arcSchema = z.object({
  logline: z.string().trim().max(ARC_LIMITS.LOGLINE_MAX).optional().default(''),
  summary: z.string().trim().max(ARC_LIMITS.SUMMARY_MAX).optional().default(''),
  protagonistArc: z.string().trim().max(ARC_LIMITS.PROTAGONIST_ARC_MAX).optional().default(''),
  themes: z.array(z.string().trim().min(1).max(ARC_LIMITS.THEME_MAX))
    .max(ARC_LIMITS.THEMES_PER_ARC_MAX).optional(),
  shape: z.enum(ARC_SHAPE_IDS).nullable().optional(),
  // Reader map (audience-experience roadmap). Accepted as an opaque object and
  // validated/sanitized server-side by sanitizeReaderMap (storyArc.js) — mirrors
  // how visualStageInputSchema defers artifact validation to the service. Must
  // be listed here or Zod's default key-stripping would silently drop it on any
  // arc PATCH, and updateSeries's wholesale arc replace would then wipe it.
  readerMap: z.object({}).passthrough().nullable().optional(),
  // Ticking clock (the countdown the reader anticipates). Same defer-to-service
  // pattern as readerMap above: accepted as an opaque object and sanitized by
  // sanitizeTickingClock (storyArc.js). Listed here so Zod doesn't strip it on
  // an arc PATCH and updateSeries's wholesale arc replace doesn't wipe it.
  tickingClock: z.object({}).passthrough().nullable().optional(),
  // Foreshadowing ledger (#2172): the plant → reinforce → payoff seeds. Same
  // defer-to-service pattern — an ARRAY of opaque entries sanitized by
  // sanitizeForeshadowing (storyArc.js). Listed here so Zod doesn't strip it on
  // an arc PATCH and updateSeries's wholesale arc replace doesn't wipe it.
  foreshadowing: z.array(z.object({}).passthrough()).nullable().optional(),
  status: z.enum(ARC_STATUSES).optional(),
});

// Per-character story arc (#1293). The arc lives on the series record as
// `series.characterArcs[]`; every field optional so a partial save or an
// intentional clear both round-trip, and the service-side
// `sanitizeCharacterArcList` stays the authority (drops empty arcs/beats,
// dedupes by character identity). Mirrors the arcSchema defer-to-sanitizer
// pattern — Zod validates shape + caps, the sanitizer normalizes.
const characterArcTransitionSchema = z.object({
  id: z.string().trim().max(64).optional(),
  kind: z.enum(TRANSITION_KINDS),
  label: z.string().trim().max(CHARACTER_ARC_LIMITS.TRANSITION_LABEL_MAX).optional(),
  atIssue: z.number().int().min(0).max(CHARACTER_ARC_LIMITS.ISSUE_MAX).nullable().optional(),
  atSceneAnchor: z.string().trim().max(CHARACTER_ARC_LIMITS.TRANSITION_ANCHOR_MAX).optional(),
  note: z.string().trim().max(CHARACTER_ARC_LIMITS.TRANSITION_NOTE_MAX).optional(),
});

const characterArcSchema = z.object({
  characterId: z.string().trim().max(64).optional(),
  characterName: z.string().trim().max(CHARACTER_ARC_LIMITS.CHARACTER_NAME_MAX).optional(),
  want: z.string().trim().max(CHARACTER_ARC_LIMITS.WANT_MAX).optional(),
  need: z.string().trim().max(CHARACTER_ARC_LIMITS.NEED_MAX).optional(),
  startState: z.string().trim().max(CHARACTER_ARC_LIMITS.START_STATE_MAX).optional(),
  endState: z.string().trim().max(CHARACTER_ARC_LIMITS.END_STATE_MAX).optional(),
  transitions: z.array(characterArcTransitionSchema)
    .max(CHARACTER_ARC_LIMITS.TRANSITIONS_PER_ARC_MAX).optional(),
  status: z.enum(CHARACTER_ARC_STATUSES).optional(),
});

const characterArcsSchema = z.array(characterArcSchema).max(CHARACTER_ARC_LIMITS.ARCS_PER_SERIES_MAX);

// Per-series style guide (house style) — #1303. Structured Zod parity for the
// `series.styleGuide` field; every field optional + nullable so a partial
// update or an intentional clear (null) both round-trip, and the service-side
// `sanitizeStyleGuide` stays the authority (collapses an all-empty guide to
// null). `tone` and `conventions` mirror the sanitizer's shape.
const styleGuideSchema = z.object({
  tense: z.enum(STYLE_GUIDE_TENSES).nullable().optional(),
  povPerson: z.enum(STYLE_GUIDE_POV_PERSONS).nullable().optional(),
  targetAudience: z.enum(STYLE_GUIDE_AUDIENCES).nullable().optional(),
  contentRating: z.enum(STYLE_GUIDE_RATINGS).nullable().optional(),
  profanity: z.enum(STYLE_GUIDE_PROFANITY).nullable().optional(),
  readingLevel: z.number()
    .min(STYLE_GUIDE_LIMITS.READING_LEVEL_MIN).max(STYLE_GUIDE_LIMITS.READING_LEVEL_MAX)
    .nullable().optional(),
  tone: z.array(z.string().trim().min(1).max(STYLE_GUIDE_LIMITS.TONE_MAX))
    .max(STYLE_GUIDE_LIMITS.TONES_MAX).optional(),
  conventions: z.object({
    oxfordComma: z.boolean().nullable().optional(),
    spelling: z.enum(STYLE_GUIDE_SPELLING).nullable().optional(),
    italicizeThoughts: z.boolean().nullable().optional(),
  }).nullable().optional(),
  // Voice exemplars / anti-exemplars (#2179, CWQE Phase 14). Concrete prose
  // anchors ("the tuning fork") injected into every draft/revision prompt.
  // `note` is optional (a passage can stand on its own); the service-side
  // `cleanExemplars` drops empty passages, trims to the char caps, and caps the
  // list length, so the schema only bounds the outer shape. `passage` is NOT
  // `.min(1)`: the editor keeps a blank `{ passage: '', note: '' }` row while
  // the user is still filling it in, and a save that flushes before the row is
  // typed (or after a passage is cleared) must not 400 the whole series PATCH —
  // `cleanExemplars` prunes the empty row on the server instead.
  voiceExemplars: z.array(z.object({
    passage: z.string().trim().max(STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX),
    note: z.string().trim().max(STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX).optional(),
  })).max(STYLE_GUIDE_LIMITS.EXEMPLARS_MAX).optional(),
  voiceAntiExemplars: z.array(z.object({
    passage: z.string().trim().max(STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX),
    note: z.string().trim().max(STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX).optional(),
  })).max(STYLE_GUIDE_LIMITS.EXEMPLARS_MAX).optional(),
});

// Volume-cover / back-cover sub-schema — accepts the script text plus the
// pre-split legacy fields. Render-slot details (`proofImage`, `finalImage`)
// arrive only from the render route's PATCH path, which builds them
// server-side; PATCHes of the season metadata only carry the user-editable
// `script`. `.passthrough()` keeps the door open for a "save full series"
// round-trip echoing back server-built render fields (proofImage /
// finalImage) without 400'ing — the parent seasonSchema is already
// passthrough for the same reason.
const seasonCoverSchema = z.object({
  script: z.string().max(8000).optional(),
  imageJobId: z.string().trim().max(200).nullable().optional(),
  prompt: z.string().max(16_000).nullable().optional(),
}).passthrough();

const seasonSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  number: z.number().int().min(0).max(ARC_LIMITS.SEASON_NUMBER_MAX).optional(),
  title: z.string().trim().max(ARC_LIMITS.SEASON_TITLE_MAX).optional(),
  logline: z.string().trim().max(ARC_LIMITS.SEASON_LOGLINE_MAX).optional(),
  synopsis: z.string().trim().max(ARC_LIMITS.SEASON_SYNOPSIS_MAX).optional(),
  episodeCountTarget: z.number().int().min(0).max(ARC_LIMITS.SEASON_EPISODE_COUNT_MAX).optional(),
  themes: z.array(z.string().trim().min(1).max(ARC_LIMITS.THEME_MAX))
    .max(ARC_LIMITS.THEMES_PER_ARC_MAX).optional(),
  endingHook: z.string().trim().max(ARC_LIMITS.SEASON_ENDING_HOOK_MAX).optional(),
  cover: seasonCoverSchema.nullable().optional(),
  backCover: seasonCoverSchema.nullable().optional(),
  status: z.enum(SEASON_STATUSES).optional(),
  // Per-season editorial lock. Enforced by `seasonsSvc.updateSeason` (refuses
  // content patches while locked) and `arcPlanner.generateSeasonEpisodes` /
  // `issuesSvc.bulkReassignSeason` / `seasonsSvc.deleteSeason` (refuse on
  // locked seasons). The sibling arc-level lock lives on `series.locked.arc`.
  locked: z.boolean().optional(),
}).passthrough();

// `.passthrough` keeps the door open for future per-season locks without a
// schema bump — the series sanitizer is the source of truth. `arcFields`
// holds the per-field arc locks (logline / summary / themes / etc.) that
// `commitSeasonsWithRemap` honors when rewriting `series.arc`.
const seriesLockedSchema = z.object({
  ...optionalBooleanMap(seriesSvc.LOCKABLE_STAGES),
  arcFields: z.object(optionalBooleanMap(seriesSvc.ARC_LOCKABLE_FIELDS)).optional(),
}).passthrough();

// Per-series autopilot severity config (#1616). `severityWeights` overrides the
// health-score weights (high/medium/low → nonnegative number, all optional);
// `blockingSeverities` overrides which severities block each autopilot gate
// (arc/beatContinuity/editorial → array of high|medium|low, all optional, an
// explicit `[]` = "nothing blocks this gate"). Both are re-bounded by the
// sanitizers (sanitizeSeverityWeights / sanitizeBlockingSeverities) on persist;
// `null`/`{}` clears the override (frozen defaults apply). Shared between create
// + patch so the two can't drift.
const severityWeightsSchema = z.object({
  high: z.number().nonnegative().optional(),
  medium: z.number().nonnegative().optional(),
  low: z.number().nonnegative().optional(),
}).strict();
const blockingSeverityEnum = z.enum(['high', 'medium', 'low']);
const blockingSeveritiesSchema = z.object({
  arc: z.array(blockingSeverityEnum).optional(),
  beatContinuity: z.array(blockingSeverityEnum).optional(),
  editorial: z.array(blockingSeverityEnum).optional(),
}).strict();

// Per-series prose-export settings (#2181). All fields optional so a partial
// PATCH tunes one knob; `null` clears the whole sub-object (defaults apply).
// Re-bounded by sanitizeProseExportSettings on persist. `trimSize`/`interiorFont`
// validated against their allow-lists; the title-page fields are free text.
const exportSettingsSchema = z.object({
  trimSize: z.enum(Object.keys(TRIM_SIZES)).optional(),
  interiorFont: z.enum(INTERIOR_FONTS).optional(),
  titlePageTitle: z.string().trim().max(200).optional(),
  titlePageSubtitle: z.string().trim().max(300).optional(),
  titlePageAuthor: z.string().trim().max(120).optional(),
  copyright: z.string().trim().max(500).optional(),
  dedication: z.string().trim().max(2000).optional(),
}).strict();

const seriesCreateSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional().default(''),
  // Series in PortOS are expected to be linked to a universe — canon
  // (characters, places, objects, style) lives on the universe and an
  // orphan series has nothing to render against. The UI's create form
  // enforces this; the route stays permissive so the importer and
  // share-bucket sync paths (which preserve remote data fidelity) can
  // still land legacy orphans.
  universeId: z.string().trim().max(seriesSvc.UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  characterArcs: characterArcsSchema.optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional().default(''),
  // Per-series editorial-check config overrides (#1591). Free-form blob (re-validated
  // per check at run time, bounded by sanitizeEditorialCheckConfig); forwarded so an
  // importer / share-bucket create that seeds tuned thresholds keeps them.
  editorialCheckConfig: z.record(z.record(z.unknown())).nullable().optional(),
  // Per-series autopilot severity config (#1616). null/{} clears.
  severityWeights: severityWeightsSchema.nullable().optional(),
  blockingSeverities: blockingSeveritiesSchema.nullable().optional(),
  // Fact-checking opt-in + author fact reference (#1588).
  factCritical: z.boolean().optional().default(false),
  factReference: z.string().trim().max(seriesSvc.FACT_REFERENCE_MAX).optional().default(''),
  styleGuide: styleGuideSchema.nullable().optional(),
  exportSettings: exportSettingsSchema.nullable().optional(),
  titleLogo: z.string().trim().max(seriesSvc.TITLE_LOGO_MAX).optional().default(''),
  author: z.string().trim().max(seriesSvc.AUTHOR_MAX).optional().default(''),
  authorId: z.string().trim().max(seriesSvc.AUTHOR_ID_MAX).nullable().optional(),
  stylePromptOverride: z.string().trim().max(seriesSvc.STYLE_PROMPT_OVERRIDE_MAX).optional().default(''),
  stylePromptOverrideMode: z.enum(seriesSvc.STYLE_PROMPT_OVERRIDE_MODES).optional(),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  primaryManuscriptType: z.enum(seriesSvc.MANUSCRIPT_TYPES).nullable().optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
  // Local-only "don't sync to peers" marker.
  ephemeral: z.boolean().optional(),
});

const seriesPatchSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX).optional(),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional(),
  universeId: z.string().trim().max(seriesSvc.UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  characterArcs: characterArcsSchema.optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional(),
  // Fact-checking opt-in + author fact reference (#1588).
  factCritical: z.boolean().optional(),
  factReference: z.string().trim().max(seriesSvc.FACT_REFERENCE_MAX).optional(),
  styleGuide: styleGuideSchema.nullable().optional(),
  exportSettings: exportSettingsSchema.nullable().optional(),
  titleLogo: z.string().trim().max(seriesSvc.TITLE_LOGO_MAX).optional(),
  author: z.string().trim().max(seriesSvc.AUTHOR_MAX).optional(),
  authorId: z.string().trim().max(seriesSvc.AUTHOR_ID_MAX).nullable().optional(),
  stylePromptOverride: z.string().trim().max(seriesSvc.STYLE_PROMPT_OVERRIDE_MAX).optional(),
  stylePromptOverrideMode: z.enum(seriesSvc.STYLE_PROMPT_OVERRIDE_MODES).optional(),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  primaryManuscriptType: z.enum(seriesSvc.MANUSCRIPT_TYPES).nullable().optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
  ephemeral: z.boolean().optional(),
  // Per-series editorial-check config overrides (#1591): { [checkId]: { [key]: value } }.
  // A free-form blob (like the global per-check `config`) — re-validated against each
  // check's own Zod configSchema at run time (applySeriesCheckConfig) and bounded by
  // sanitizeEditorialCheckConfig on persist; this gate just keeps the wire shape sane.
  // `null`/`{}` clears all overrides.
  editorialCheckConfig: z.record(z.record(z.unknown())).nullable().optional(),
  // Per-series autopilot severity config (#1616): { high?, medium?, low? } weights
  // and { arc?, beatContinuity?, editorial? } blocking-severity arrays. Re-bounded
  // by the sanitizers on persist; `null`/`{}` clears (frozen defaults apply). An
  // explicit empty array on a gate = "nothing blocks this gate".
  severityWeights: severityWeightsSchema.nullable().optional(),
  blockingSeverities: blockingSeveritiesSchema.nullable().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });
const arcFieldLockSchema = z.object({ locked: z.boolean() });

// Season-resource schemas: dedicated CRUD on a sibling resource so the
// client can edit one season without resending the whole series patch.
const seasonCreateSchema = seasonSchema.refine(
  (p) => (p.title && p.title.trim().length > 0) || (Number.isFinite(p.number) && p.number > 0),
  { message: 'season requires a non-empty title or a number > 0' },
);
const seasonPatchSchema = seasonSchema.refine(
  (p) => Object.keys(p).length > 0,
  { message: 'patch must include at least one field' },
);
const seasonDeleteSchema = z.object({
  reassignTo: z.string().trim().min(1).max(64).nullable().optional(),
});

// ---- Issue schemas ----

const issueCreateSchema = z.object({
  title: z.string().trim().min(1).max(issuesSvc.TITLE_MAX),
  number: z.number().int().min(1).max(9999).optional(),
  // Per-issue length profile — can be set at create time so a user creating
  // a standalone oversized issue (e.g. an annual) doesn't have to open the
  // picker after the fact. Defaults server-side to 'standard'.
  lengthProfile: z.enum(LENGTH_PROFILE_NAMES).optional(),
  pageTarget: z.number().int().min(CUSTOM_PAGE_MIN).max(CUSTOM_PAGE_MAX).nullable().optional(),
  minutesTarget: z.number().int().min(CUSTOM_MINUTE_MIN).max(CUSTOM_MINUTE_MAX).nullable().optional(),
  ephemeral: z.boolean().optional(),
});

// =====================
// Series routes
// =====================

router.get('/series', asyncHandler(async (_req, res) => {
  res.json(await seriesSvc.listSeries());
}));

router.post('/series', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesCreateSchema, req.body ?? {});
  // Hierarchy invariant: every series belongs to exactly one universe. Enforce
  // it for all HTTP callers here (the UI already enforces it client-side).
  // The schema stays permissive (nullable) so the importer + mergeSeriesFromSync,
  // which call createSeries directly, can still land legacy orphans from peers.
  if (!body.universeId || !String(body.universeId).trim()) {
    throw new ServerError('A universe is required — a series must belong to a universe.', {
      status: 400, code: seriesSvc.ERR_VALIDATION,
    });
  }
  const created = await seriesSvc.createSeries(body);
  // Non-blocking same-name warning, scoped within the universe (route layer
  // only, so the importer's direct createSeries never pays for the scan).
  const duplicateName = await findSameNameSeries(created.name, created.universeId, { excludeId: created.id });
  res.status(201).json(duplicateName.length ? { ...created, _warnings: { duplicateName } } : created);
}));

// ---- Series duplicate resolution (static paths — keep BEFORE `/series/:id`) ----

const seriesMergeSchema = z.object({
  survivorId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  loserId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  fieldChoices: z.record(z.enum(['survivor', 'loser'])).optional().default({}),
  // Free-form per-field values that win over the survivor/loser binary —
  // populated by the AI-merge flow (a third unified option) and optionally
  // tweaked by the user before submit.
  fieldOverrides: z.record(z.string()).optional().default({}),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

const seriesMergeAIResolveSchema = z.object({
  survivorId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  loserId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

router.get('/series/duplicates', asyncHandler(async (_req, res) => {
  res.json(await findDuplicateSeriesGroups());
}));

router.post('/series/merge/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeSchema, req.body ?? {});
  const preview = await mergeSeries(body.survivorId, body.loserId, body.fieldChoices, { dryRun: true, fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(preview);
}));

router.post('/series/merge', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeSchema, req.body ?? {});
  const result = await mergeSeries(body.survivorId, body.loserId, body.fieldChoices, { fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Ask the configured AI provider to merge specific conflicting text fields
// into a single unified value per field. Same shape as the universe-side
// /universe-builder/merge/ai-resolve route.
router.post('/series/merge/ai-resolve', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeAIResolveSchema, req.body ?? {});
  const [survivor, loser] = await Promise.all([
    seriesSvc.getSeries(body.survivorId).catch((err) => { throw mapServiceError(err); }),
    seriesSvc.getSeries(body.loserId).catch((err) => { throw mapServiceError(err); }),
  ]);
  const result = await mergeFieldsWithAI({
    kind: 'series',
    survivor,
    loser,
    fields: body.fields,
    providerId: body.providerId,
    model: body.model,
  });
  res.json(result);
}));

// Generate a fresh series concept (name / logline / premise / story shape)
// from a universe, used as seed material. Returns the concept WITHOUT
// persisting it — the New Series form pre-fills these for the user to edit
// before creating. Static path: keep BEFORE `/series/:id`.
const seriesGenerateSchema = z.object({
  universeId: z.string().trim().min(1).max(seriesSvc.UNIVERSE_ID_MAX),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});
router.post('/series/generate-concept', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesGenerateSchema, req.body ?? {});
  const result = await generateSeriesConcept(body.universeId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.get('/series/:id', asyncHandler(async (req, res) => {
  const s = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.patch('/series/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesPatchSchema, req.body ?? {});
  const s = await seriesSvc.updateSeries(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  if ('name' in body || 'universeId' in body) {
    const duplicateName = await findSameNameSeries(s.name, s.universeId, { excludeId: req.params.id });
    if (duplicateName.length) { res.json({ ...s, _warnings: { duplicateName } }); return; }
  }
  res.json(s);
}));

router.patch('/series/:id/arc-fields/:field/lock', asyncHandler(async (req, res) => {
  const body = validateRequest(arcFieldLockSchema, req.body ?? {});
  const s = await seriesSvc.setArcFieldLock(req.params.id, req.params.field, body.locked)
    .catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.delete('/series/:id', asyncHandler(async (req, res) => {
  const r = await seriesSvc.deleteSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

// Generate (or regenerate) the series.titleLogo description via the
// `pipeline-series-title-logo` stage. Returns the updated series so the
// client can swap state without a follow-up GET.
const titleLogoGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});
router.post('/series/:id/generate-title-logo', asyncHandler(async (req, res) => {
  const body = validateRequest(titleLogoGenerateSchema, req.body ?? {});
  const result = await generateSeriesTitleLogo(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Voice discovery (#2179, CWQE Phase 14): write the same scene beat in several
// distinct registers so the author picks the series voice by ear. Returns the
// candidate passages WITHOUT persisting — the user's pick is committed via the
// ordinary series PATCH (styleGuide.voiceExemplars). Reuses the LLM
// provider/model override shape.
const voiceDiscoverSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});
router.post('/series/:id/discover-voice', asyncHandler(async (req, res) => {
  const body = validateRequest(voiceDiscoverSchema, req.body ?? {});
  const result = await discoverSeriesVoice(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.get('/series/:id/issues', asyncHandler(async (req, res) => {
  // Validate the series exists so a typo returns 404 instead of [] (less
  // confusing for the UI).
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const hasPagination = req.query.offset !== undefined || req.query.limit !== undefined;
  // List endpoints strip per-stage runHistory; the UI never renders it on
  // these views and a maxed-out issue can otherwise ship ~12MB of payload.
  // Detail reads (`GET /issues/:id`) stay on the full shape.
  if (hasPagination) {
    const { offset, limit } = validateRequest(issuesListQuerySchema, req.query);
    res.json(await issuesSvc.listIssues({ seriesId: req.params.id, offset, limit, paginated: true, withHistory: false }));
  } else {
    res.json(await issuesSvc.listIssues({ seriesId: req.params.id, withHistory: false }));
  }
}));

router.post('/series/:id/issues', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(issueCreateSchema, req.body ?? {});
  const created = await issuesSvc.createIssue({ ...body, seriesId: req.params.id });
  res.status(201).json(created);
}));

// =====================
// Season routes — Phase 2 of Story Arc Planning. Seasons live inside
// `series.seasons[]` but get their own resource so a single-season edit
// doesn't have to re-PATCH the entire series record.
// =====================

router.get('/series/:id/seasons', asyncHandler(async (req, res) => {
  const seasons = await seasonsSvc.listSeasons(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.json(seasons);
}));

router.post('/series/:id/seasons', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(seasonCreateSchema, req.body ?? {});
  const created = await seasonsSvc.createSeason(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.status(201).json(created);
}));

router.patch('/series/:id/seasons/:seasonId', asyncHandler(async (req, res) => {
  const body = validateRequest(seasonPatchSchema, req.body ?? {});
  const updated = await seasonsSvc.updateSeason(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

router.delete('/series/:id/seasons/:seasonId', asyncHandler(async (req, res) => {
  // Reassign target arrives via the request body so HTTP DELETE stays valid;
  // a query-param fallback would invite the same content twice in different
  // shapes. Body is optional — omitting it un-groups every child issue.
  const body = validateRequest(seasonDeleteSchema, req.body ?? {});
  const result = await seasonsSvc.deleteSeason(req.params.id, req.params.seasonId, {
    reassignTo: body.reassignTo ?? null,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
