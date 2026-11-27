// Validates series, season, arc planning and autopilot requests.

import { z } from 'zod';
import { optionalBooleanMap } from './zodCompat.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { characterEvolutionSchema } from './characterEvolutionValidation.js';
import { recordRenderPinFields, seriesDesignSchema, llmSchema } from './sharedSchemas.js';
import { TRIM_SIZES, INTERIOR_FONTS } from './proseExportSettings.js';
import {
  CANDIDATE_COUNT_MIN,
  CANDIDATE_COUNT_MAX,
  LOCKABLE_STAGES,
  ARC_LOCKABLE_FIELDS,
  SERIES_NAME_MAX,
  UNIVERSE_ID_MAX,
  WRITERS_ROOM_WORK_ID_MAX,
  FACT_REFERENCE_MAX,
  AUTHOR_MAX,
  AUTHOR_ID_MAX,
  STYLE_PROMPT_OVERRIDE_MAX,
  STYLE_PROMPT_OVERRIDE_MODES,
  TARGET_FORMATS,
  MANUSCRIPT_TYPES,
  ISSUE_COUNT_TARGET_MAX,
  VOLUME_BEATS_MODES,
  AUTOPILOT_LLM_STAGE_KINDS,
} from './pipelineSeriesConfig.js';
import { ARC_LIMITS, ARC_STATUSES, ARC_SHAPE_IDS, SEASON_STATUSES } from './storyArc.js';
import { CHARACTER_ARC_LIMITS, CHARACTER_ARC_STATUSES, TRANSITION_KINDS } from './seriesCharacterArc.js';
import {
  STYLE_GUIDE_LIMITS,
  STYLE_GUIDE_TENSES,
  STYLE_GUIDE_POV_PERSONS,
  STYLE_GUIDE_AUDIENCES,
  STYLE_GUIDE_RATINGS,
  STYLE_GUIDE_PROFANITY,
  STYLE_GUIDE_SPELLING,
} from './styleGuide.js';
import { LOGLINE_MAX, PREMISE_MAX, STYLE_NOTES_MAX } from './universeBibleLimits.js';
import { TITLE_LOGO_MAX } from './storyArcLimits.js';
import { READINESS_GATES } from './editorial/severityConfig.js';
import { MAX_CONVERGENCE_ROUNDS } from './editorialValidation.js';

// Arc planning and related LLM calls share provider/model override limits.
export const providerOverrideShape = {
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(200).optional(),
};

// Series and season request schemas

// Arc + Season — phase 2 of Story Arc Planning. The arc lives on the series
// record itself; seasons get their own resource so the route layer can take
// per-record CRUD without forcing the caller to PATCH the whole series.
const arcSchema = z.object({
  seriesDesign: seriesDesignSchema.nullable().optional(),
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
  // The OPTIONAL five-stage evolution lens (#6440). `characterArcs` is a
  // wholesale replace, so a client sends each arc whole — an omitted or null
  // `evolution` is a real clear here, exactly like an omitted `want`. The
  // absent-key-preserves rule applies one level up, on the sync-merge path
  // (`ADDITIVE_SERIES_FIELDS` already lists `characterArcs`).
  evolution: characterEvolutionSchema.nullable().optional(),
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
  ...optionalBooleanMap(LOCKABLE_STAGES),
  arcFields: z.object(optionalBooleanMap(ARC_LOCKABLE_FIELDS)).optional(),
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

export const seriesCreateSchema = z.object({
  name: z.string().trim().min(1).max(SERIES_NAME_MAX),
  logline: z.string().trim().max(LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(PREMISE_MAX).optional().default(''),
  // Series in PortOS are expected to be linked to a universe — canon
  // (characters, places, objects, style) lives on the universe and an
  // orphan series has nothing to render against. The UI's create form
  // enforces this; the route stays permissive so the importer and
  // share-bucket sync paths (which preserve remote data fidelity) can
  // still land legacy orphans.
  universeId: z.string().trim().max(UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  characterArcs: characterArcsSchema.optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  // Per-series editorial-check config overrides (#1591). Free-form blob (re-validated
  // per check at run time, bounded by sanitizeEditorialCheckConfig); forwarded so an
  // importer / share-bucket create that seeds tuned thresholds keeps them.
  editorialCheckConfig: z.record(z.record(z.unknown())).nullable().optional(),
  // Per-series autopilot severity config (#1616). null/{} clears.
  severityWeights: severityWeightsSchema.nullable().optional(),
  blockingSeverities: blockingSeveritiesSchema.nullable().optional(),
  // Fact-checking opt-in + author fact reference (#1588).
  factCritical: z.boolean().optional().default(false),
  factReference: z.string().trim().max(FACT_REFERENCE_MAX).optional().default(''),
  styleGuide: styleGuideSchema.nullable().optional(),
  exportSettings: exportSettingsSchema.nullable().optional(),
  titleLogo: z.string().trim().max(TITLE_LOGO_MAX).optional().default(''),
  author: z.string().trim().max(AUTHOR_MAX).optional().default(''),
  authorId: z.string().trim().max(AUTHOR_ID_MAX).nullable().optional(),
  stylePromptOverride: z.string().trim().max(STYLE_PROMPT_OVERRIDE_MAX).optional().default(''),
  stylePromptOverrideMode: z.enum(STYLE_PROMPT_OVERRIDE_MODES).optional(),
  targetFormat: z.enum(TARGET_FORMATS).optional(),
  primaryManuscriptType: z.enum(MANUSCRIPT_TYPES).nullable().optional(),
  issueCountTarget: z.number().int().min(0).max(ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
  // Per-record render pin (#3231 Phase 3) — this series' default image
  // backend + cloud model for pipeline visual renders.
  ...recordRenderPinFields,
  // Local-only "don't sync to peers" marker.
  ephemeral: z.boolean().optional(),
});

export const seriesPatchSchema = z.object({
  name: z.string().trim().min(1).max(SERIES_NAME_MAX).optional(),
  logline: z.string().trim().max(LOGLINE_MAX).optional(),
  premise: z.string().trim().max(PREMISE_MAX).optional(),
  universeId: z.string().trim().max(UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  characterArcs: characterArcsSchema.optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional(),
  // Fact-checking opt-in + author fact reference (#1588).
  factCritical: z.boolean().optional(),
  factReference: z.string().trim().max(FACT_REFERENCE_MAX).optional(),
  styleGuide: styleGuideSchema.nullable().optional(),
  exportSettings: exportSettingsSchema.nullable().optional(),
  titleLogo: z.string().trim().max(TITLE_LOGO_MAX).optional(),
  author: z.string().trim().max(AUTHOR_MAX).optional(),
  authorId: z.string().trim().max(AUTHOR_ID_MAX).nullable().optional(),
  stylePromptOverride: z.string().trim().max(STYLE_PROMPT_OVERRIDE_MAX).optional(),
  stylePromptOverrideMode: z.enum(STYLE_PROMPT_OVERRIDE_MODES).optional(),
  targetFormat: z.enum(TARGET_FORMATS).optional(),
  primaryManuscriptType: z.enum(MANUSCRIPT_TYPES).nullable().optional(),
  issueCountTarget: z.number().int().min(0).max(ISSUE_COUNT_TARGET_MAX).optional(),
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
  // Per-record render pin (#3231 Phase 3). Key-present with 'auto'/''/null
  // clears; key-absent preserves.
  ...recordRenderPinFields,
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

export const arcFieldLockSchema = z.object({ locked: z.boolean() });

// Season-resource schemas: dedicated CRUD on a sibling resource so the
// client can edit one season without resending the whole series patch.
export const seasonCreateSchema = seasonSchema.refine(
  (p) => (p.title && p.title.trim().length > 0) || (Number.isFinite(p.number) && p.number > 0),
  { message: 'season requires a non-empty title or a number > 0' },
);

export const seasonPatchSchema = seasonSchema.refine(
  (p) => Object.keys(p).length > 0,
  { message: 'patch must include at least one field' },
);

export const seasonDeleteSchema = z.object({
  reassignTo: z.string().trim().min(1).max(64).nullable().optional(),
});

export const seriesMergeSchema = z.object({
  survivorId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  loserId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  fieldChoices: z.record(z.enum(['survivor', 'loser'])).optional().default({}),
  // Free-form per-field values that win over the survivor/loser binary —
  // populated by the AI-merge flow (a third unified option) and optionally
  // tweaked by the user before submit.
  fieldOverrides: z.record(z.string()).optional().default({}),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

export const seriesMergeAIResolveSchema = z.object({
  survivorId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  loserId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

export const seriesGenerateSchema = z.object({
  universeId: z.string().trim().min(1).max(UNIVERSE_ID_MAX),
  count: z.number().int().min(CANDIDATE_COUNT_MIN).max(CANDIDATE_COUNT_MAX).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Arc planning request schemas

// The first two arc passes also accept `commit: true` to persist the LLM
// output (skipping the preview/confirm step).
export const arcGenerateSchema = z.object({ ...providerOverrideShape, commit: z.boolean().optional() });

export const seasonEpisodesGenerateSchema = z.object({ ...providerOverrideShape, commit: z.boolean().optional() });

export const arcVerifySchema = z.object(providerOverrideShape);

// Volume / season verify shares the same provider/model override shape.
export const volumeVerifySchema = z.object(providerOverrideShape);

// Volume beat-sheets bulk generator. `mode` defaults to skip-existing so a
// rerun on a partially-expanded volume only fills empty slots; the explicit
// 'regenerate-all' is the "blow away every beat sheet" path.
export const volumeBeatsGenerateSchema = z.object({
  ...providerOverrideShape,
  mode: z.enum(VOLUME_BEATS_MODES).optional().default('skip-existing'),
});

// Auto-resolve verification findings. `findings` empty/omitted = re-verify
// first then resolve everything; otherwise the LLM only addresses the
// caller-supplied subset (per-finding "Resolve" buttons).
const verifyFindingSchema = z.object({
  severity: z.enum(['high', 'medium', 'low']).optional(),
  location: z.string().trim().max(200).optional(),
  problem: z.string().trim().min(1).max(2000),
  suggestion: z.string().trim().max(2000).optional(),
});

export const arcResolveSchema = z.object({
  ...providerOverrideShape,
  findings: z.array(verifyFindingSchema).max(50).optional(),
});

// Back-derive arc/bible/structure from the existing issue manuscripts. The
// preview pass just needs the override shape; the commit pass carries the
// (possibly user-edited) proposal so the LLM is NOT re-run on confirm.
export const arcDeriveSchema = z.object(providerOverrideShape);

export const arcDeriveCommitSchema = z.object({
  arc: z.object({
    logline: z.string().max(500).optional(),
    summary: z.string().max(8000).optional(),
    protagonistArc: z.string().max(8000).optional(),
    themes: z.array(z.string().max(200)).max(50).optional(),
    shape: z.string().max(80).nullable().optional(),
  }).optional(),
  bible: z.object({
    logline: z.string().max(500).optional(),
    premise: z.string().max(PREMISE_MAX).optional(),
    issueCountTarget: z.number().int().min(0).max(9999).optional(),
  }).optional(),
  volume: z.object({
    title: z.string().max(300).optional(),
    logline: z.string().max(1000).optional(),
    synopsis: z.string().max(8000).optional(),
  }).optional(),
  issues: z.array(z.object({
    id: z.string().min(1).max(120),
    title: z.string().max(300).optional(),
    synopsis: z.string().max(8000).optional(),
  })).max(200).optional(),
});

// Autopilot request schemas

const effortOverrideSchema = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.enum(EFFORT_LEVELS).optional(),
);

const autopilotLlmRouteSchema = z.object({
  ...providerOverrideShape,
  effortOverride: effortOverrideSchema,
}).strict();

const autopilotStageLlmSchema = z.partialRecord(
  z.enum(AUTOPILOT_LLM_STAGE_KINDS),
  z.object({
    creative: autopilotLlmRouteSchema.optional(),
    judge: autopilotLlmRouteSchema.optional(),
  }).strict(),
);

export const autopilotStartSchema = z.object({
  ...providerOverrideShape,
  // Per-run reasoning effort: applies to stages with no `effort` pin; stageRunner clamps it to the
  // provider ladder. '' (UI "provider default") means no override.
  effortOverride: effortOverrideSchema,
  // Optional per-run critic route for judges, verification, analytical passes and diagnosis;
  // creation/repair keeps the run's provider/model/effort. Exact Prompts stage pins still win.
  judgeLlm: autopilotLlmRouteSchema.optional(),
  // Optional per-step routes; a stage route beats learned and run-wide routes, while an exact Prompts-stage pin stays authoritative in stageRunner.
  stageLlm: autopilotStageLlmSchema.optional(),
  // Draft cover + all interior pages once a story is ready; honored when VISUAL_DRAFT_ENABLED ships.
  includeVisual: z.boolean().optional().default(true),
  // 'auto' derives the terminal from the series targetFormat.
  target: z.enum(['auto', 'text', 'visual']).optional().default('auto'),
  // Create CoS tasks for capability gaps (Phase 3).
  fileGaps: z.boolean().optional().default(false),
  // Restrict a multi-format series to these formats' scripts (e.g. ['comic'] skips teleplay); absent/empty = all.
  targetFormats: z.array(z.enum(['comic', 'tv'])).optional(),
  // Bound production while retaining the full series plan as editorial context.
  productionScope: z.enum(['series', 'first-issue']).optional(),
  // Per-run convergence bounds for the verify/review loops (0 = skip that gate); omitted falls back to
  // pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds,maxBeatContinuityRounds}, then
  // the module default. Cap mirrors the settings schema.
  maxArcVerifyRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxEditorialRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxBeatContinuityRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Foundation-quality gate: `foundationGate` toggles the pre-draft judge, `foundationThreshold` is
  // the weighted [0,10] bar, `maxFoundationRounds` bounds the improve loop (0 = skip). Each falls
  // back to the persisted pipelineEditorialChecks setting, then the module default.
  foundationGate: z.boolean().optional(),
  foundationThreshold: z.number().min(0).max(10).optional(),
  maxFoundationRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Retry budget for a failed delegated child runner before pausing (0 = single attempt).
  // Per-run only; falls back to MAX_CHILD_RETRIES. Shares the convergence ceiling.
  maxChildRetries: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Corrective-pass budget for the arc-verify regression guard: re-attempts of a reverted resolve
  // round before pausing for a human (0 = revert and pause on first regression). Per-run only;
  // falls back to MAX_ARC_RESOLVE_RETRIES.
  maxArcResolveRetries: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Cap on the arc-verify gate's one-at-a-time per-finding isolation attempts once corrective
  // passes are spent (each patch kept only if it closes its target without worsening the set).
  // 0 = no isolation. Per-run only; when omitted the gate derives a budget from
  // MAX_ARC_ISOLATION_CALLS, and `maxArcResolveRetries: 0` opts out of isolation too.
  maxArcIsolationAttempts: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Run ONLY these editorial check ids instead of all enabled ones; absent/empty = every enabled
  // check. Per-run only; unknown/disabled ids are silently ignored by the runner.
  editorialCheckIds: z.array(z.string().min(1)).optional(),
  // Readiness gate override; falls back to pipelineEditorialChecks.readinessGate, then the service
  // default. Shares READINESS_GATES so the API and scorer can't drift.
  readinessGate: z.enum(READINESS_GATES).optional(),
  // Pause for human review at >= N high-severity check findings. Falls back to
  // pipelineEditorialChecks.checkFindingsPauseThreshold, then 0 (off); no upper bound.
  checkFindingsPauseThreshold: z.number().int().min(0).optional(),
  // Post an in-app notification with a resume link when the run pauses. Falls back to
  // pipelineEditorialChecks.notifyOnPause, then true.
  notifyOnPause: z.boolean().optional(),
  // Mint + start a Creative Director teaser video per issue once every comic issue is drafted. Falls back to pipelineEditorialChecks.produceTeaser, then off.
  produceTeaser: z.boolean().optional(),
  // Unlock-everything pre-pass: clears every lock this SERIES owns (arc freeze, per-field arc
  // locks, volume, issue stage locks, owned universe-canon entries) so editorial fixes can apply.
  // Canon shared with another series stays locked; nothing is deleted. Unlike every other option
  // there is NO saved-setting fallback, so one tick can't arm lock-clearing for an unattended
  // scheduled run (seriesAutopilot/config.js#resolveAutopilotUnlockForRun).
  unlockForRun: z.boolean().optional(),
  // Iterate-to-quality revision loop (CWQE Phase 7): after the editorial-health gate, cycles the
  // weakest drafted issue through adversarial cuts + a judge-gated keep/revert until plateau,
  // hedged convergence or maxCycles (cost ceiling). Falls back to pipelineEditorialChecks.revision*,
  // then off. Caps share MAX_CONVERGENCE_ROUNDS.
  revisionEnabled: z.boolean().optional(),
  revisionMinCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionMaxCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionPlateauDelta: z.number().min(0).max(10).optional(),
  // Pipeline self-improvement: a run whose telemetry shows the AUTOMATION limped spends one
  // diagnosis call at its terminal and may file a PortOS fix task, always awaiting human
  // approval. Falls back to pipelineEditorialChecks.selfImprove, then off.
  selfImprove: z.boolean().optional(),
  // Observing orchestrator: watches its own telemetry step by step and, on misbehaving
  // automation, spends a bounded diagnosis call and dispatches an AUTO-APPROVED PortOS fix task
  // (worktree-isolated, no human gate; the explicit opt-in IS the consent, see
  // seriesAutopilot/observer.js). Supersedes selfImprove when both are on. Falls back to
  // pipelineEditorialChecks.observer, then off.
  observer: z.boolean().optional(),
  // Use the best sufficiently sampled provider/model/effort per step and role; explicit run choices and stage pins still win.
  autoSelectModels: z.boolean().optional(),
  // Force this run's provider/model/effort onto EVERY stage, ignoring Prompts-page pins
  // (lib/stagePinPolicy.js). Falls back to pipelineEditorialChecks.overrideStagePins, then off.
  overrideStagePins: z.boolean().optional(),
});
