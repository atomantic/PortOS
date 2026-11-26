// Zod schemas for Pipeline production, Writers Room, story-bible records, and editorial checks.

import { z } from 'zod';
import { partialWithoutDefaults, optionalBooleanMap } from './zodCompat.js';
import { PAGE_SIZE_NAMES, DEFAULT_PAGE_SIZE } from './pdfPageSizes.js';
import { WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS } from './writersRoomPresets.js';
import { ALL_STYLE_IDS, STYLE_ID } from './writersRoomStylePresets.js';
import {
  BIBLE_LIMITS, RELATIONSHIP_LINK_TYPES, RELATIONSHIP_OPPOSITION_AXES,
  ATTACHMENT_ROLES, VOICE_CANON_SOURCE_POLICIES, IDENTITY_ASSET_ROLES,
} from './storyBible.js';
import {
  CHARACTER_ARC_TYPES,
  CHARACTER_FRAMEWORK_LIMITS,
  CHARACTER_PSYCHOLOGY_LIMITS,
  CHARACTER_PSYCHOLOGY_TEXT_FIELDS,
  CHARACTER_SLIDER_AXES,
  PSYCHOLOGY_ASSESSMENTS,
  PSYCHOLOGY_DRIVE_AXES,
} from './characterFramework.js';
import { MIN_TIMEOUT as STAGE_TIMEOUT_MIN_MS, MAX_TIMEOUT as STAGE_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { CHECK_SCOPES, CHECK_SEVERITIES } from './editorial/checkInfra/taxonomy.js';
import { SHOT_TYPES, SCREEN_DIRECTIONS } from './shotGrammar.js';
import { characterEvolutionSchema } from './characterEvolutionValidation.js';
import {
  nullishString,
  recordRenderPinFields,
  seriesDesignSchema,
  llmSchema,
  imageEdgeSchema,
  refineImagePixelCap,
  PIXEL_CAP_MESSAGE,
} from './sharedSchemas.js';
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
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN,
  CUSTOM_PAGE_MAX,
  CUSTOM_MINUTE_MIN,
  CUSTOM_MINUTE_MAX,
} from './issueLength.js';
import { ARC_LIMITS, ARC_STATUSES, ARC_SHAPE_IDS, ARC_ROLES, SEASON_STATUSES } from './storyArc.js';
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
import {
  ISSUE_TITLE_MAX,
  SEASON_ID_MAX,
  ARC_POSITION_MAX,
  IMAGE_PROMPT_CANDIDATE_MAX,
  COMIC_PAGE_VARIANTS,
  SOURCE_KIND,
  STAGE_STATUSES,
  STAGE_INPUT_MAX,
  STAGE_OUTPUT_MAX,
  STAGE_NOTES_MAX,
  AUDIO_CUE_ID_MAX,
  AUDIO_CUE_LABEL_MAX,
  AUDIO_CUE_PROMPT_MAX,
  AUDIO_CUE_ENGINE_MAX,
  AUDIO_FILENAME_MAX,
  AUDIO_MODES,
  AUDIO_CUES_MAX,
  ISSUE_STATUSES,
} from './pipelineIssueConfig.js';
import { ASPECT_RATIOS, QUALITIES } from './creativeDirectorPresets.js';
import { QUEUEABLE_IMAGE_MODES } from './generationModes.js';
import { TEXT_STAGE_IDS } from './pipelineStages.js';
import { READINESS_GATES } from './editorial/severityConfig.js';

// Print-PDF export options. `size` must name a catalog page size (an unknown one, including an
// Object.prototype key, is a 400); omitted means the default. The `skip` toggles only act on the
// literal value.
export const pipelinePdfQuerySchema = z.object({
  size: z.enum(PAGE_SIZE_NAMES).default(DEFAULT_PAGE_SIZE),
  cover: z.string().optional(),
  backCover: z.string().optional(),
  colophon: z.string().optional(),
});

export const pipelineStageRecoverySchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) });

// =============================================================================
// WRITERS ROOM SCHEMAS
// =============================================================================

export const writersRoomWorkKindSchema = z.enum(WORK_KINDS);
export const writersRoomWorkStatusSchema = z.enum(WORK_STATUSES);

// IDs are either null (unfiled / unattached) or a non-empty trimmed string.
// Zod runs chain steps in declared order, so .trim() MUST come before .min(1)
// — otherwise a whitespace-only string passes min(1), then trim() collapses
// it to '' after the guard already accepted it. Same gotcha applies to all
// the .min(1).trim() pairs below.
const wrIdNullable = z.string().trim().min(1).max(100).nullable();

export const writersRoomFolderCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: wrIdNullable.optional(),
  sortOrder: z.number().int().optional()
}).strict();

export const writersRoomWorkCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: writersRoomWorkKindSchema.optional().default('short-story'),
  folderId: wrIdNullable.optional()
}).strict();

export const writersRoomImageStyleSchema = z.object({
  // 'none' (no style applied), 'custom' (user-authored prompt with no preset),
  // or one of the curated preset ids. The resolved prompt text lives on the
  // work — picking a preset later doesn't retroactively change historical
  // works' rendering.
  presetId: z.enum(ALL_STYLE_IDS).default(STYLE_ID.NONE),
  prompt: z.string().max(2000).default(''),
  negativePrompt: z.string().max(2000).default(''),
}).strict();

// Phase 5 live-mode opt-in (per work). `enabled` gates the editor's
// background continuation suggestions; `debounceMs` is the client's
// idle-after-typing throttle before it asks; `dailyCallBudget` caps how many
// suggest calls the server will run per UTC day (0 = unlimited);
// `dailyRenderBudget` is the distinct cap on live render previews (renders cost
// materially more than text, so they get their own knob). The server-tracked
// `usage` / `renderUsage` counters are NOT user-editable — they're bumped by
// the suggest / render-reserve paths and reset on a new day — so they live
// outside this update schema (mirrors how `pipelineSeriesId` is set by
// linkToPipeline, not updateWork).
export const writersRoomLiveModeSchema = z.object({
  enabled: z.boolean().default(false),
  debounceMs: z.number().int().min(800).max(30_000).default(2500),
  dailyCallBudget: z.number().int().min(0).max(10_000).default(100),
  dailyRenderBudget: z.number().int().min(0).max(10_000).default(20),
}).strict();

// Voice exemplar / anti-exemplar passages on a Writers Room work (#2179 Writers
// Room parity). Same shape + caps as the series style guide's voice fields
// (STYLE_GUIDE_LIMITS in styleGuide.js) — `passage` is the concrete prose
// anchor ("the tuning fork"), `note` a one-line gloss of what it demonstrates
// (exemplar) or what's wrong with it (anti-exemplar). `note` is optional; the
// service sanitizer (sanitizeVoiceExemplars) drops empty passages, trims to the
// caps, and caps the list at 3 — this wire gate just bounds the shape so a
// crafted PATCH can't ship an unbounded blob. An explicit `[]` clears the list.
const writersRoomVoiceExemplarSchema = z.object({
  passage: z.string().max(2000),
  note: z.string().max(200).optional(),
}).strict();
const writersRoomVoiceExemplarsSchema = z.array(writersRoomVoiceExemplarSchema).max(3);

export const writersRoomWorkUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  kind: writersRoomWorkKindSchema.optional(),
  status: writersRoomWorkStatusSchema.optional(),
  folderId: wrIdNullable.optional(),
  imageStyle: writersRoomImageStyleSchema.optional(),
  // partialWithoutDefaults (not .partial()) so a single-knob PATCH doesn't inject
  // the other knobs' defaults and clobber their stored values (Zod 4 .partial()
  // keeps inner defaults — see zodCompat.js). The service field-merges each knob.
  liveMode: partialWithoutDefaults(writersRoomLiveModeSchema).optional(),
  voiceExemplars: writersRoomVoiceExemplarsSchema.optional(),
  voiceAntiExemplars: writersRoomVoiceExemplarsSchema.optional(),
}).strict();

// Cursor-context payload for the live continuation suggest route. The three
// prose slices are bounded so a runaway editor can't ship a multi-MB body on
// every keystroke — the server only needs a window around the cursor, not the
// whole manuscript.
export const writersRoomLiveSuggestSchema = z.object({
  before: z.string().max(12_000).optional().default(''),
  after: z.string().max(12_000).optional().default(''),
  selection: z.string().max(8_000).optional().default(''),
}).strict();

// Live render-preview reservation takes no body — the work id is in the path
// and the budget is server-owned. A strict empty object rejects any crafted
// payload (e.g. an attempt to smuggle a usage counter) instead of ignoring it.
export const writersRoomLiveRenderPreviewSchema = z.object({}).strict();

// =============================================================================
// EDITORIAL CHECKS (#1284) — registry-driven editorial review
// =============================================================================
// Per-check enable/config. `config` is a free-form blob validated a second time
// against the check's own Zod `configSchema` in the registry (resolveCheckConfig)
// — this gate just bounds the wire shape so a malformed PATCH can't write junk.
export const editorialCheckConfigSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  // Optional per-check severity override (#1596). Absent falls through to the
  // check's registry `severityDefault`; an explicit `null` CLEARS a previously
  // stored override (so the catalog "Default" option resets to the registry
  // value rather than pinning a level). Bounded to the registry's own severity
  // enum so the wire gate can't drift from resolveCheckState.
  severity: z.enum([...CHECK_SEVERITIES]).nullable().optional(),
}).strict();

// POST .../editorial/checks/run — run all enabled checks, or a named subset.
// providerId/model are optional overrides forwarded to LLM-kind checks.
export const editorialChecksRunSchema = z.object({
  checkIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).strict();

// User-defined editorial check (#1346). The base authored-field shapes carry NO
// `.default()` so the UPDATE schema (a `.partial()` of them) leaves an omitted
// field unchanged — a defaulted optional would silently RESET the stored value
// on a field-specific PATCH (Zod's `.partial()` keeps the inner `.default()`,
// which still fires when the key is absent). `scope`/`severityDefault` reuse the
// registry's own enums so the wire gate can't drift from `buildCustomCheck`.
const editorialCustomCheckShape = {
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  prompt: z.string().trim().min(1).max(8_000),
  scope: z.enum([...CHECK_SCOPES]),
  category: z.string().trim().max(60),
  severityDefault: z.enum([...CHECK_SEVERITIES]),
};

// Create: label + prompt required; the rest optional with sensible defaults (so
// a new check is fully-formed). The JSON output contract is enforced server-side
// (buildCustomCheckPrompt), so no schema field captures it.
export const editorialCustomCheckCreateSchema = z.object({
  ...editorialCustomCheckShape,
  description: editorialCustomCheckShape.description.optional().default(''),
  scope: editorialCustomCheckShape.scope.optional().default('issue'),
  category: editorialCustomCheckShape.category.optional().default('custom'),
  severityDefault: editorialCustomCheckShape.severityDefault.optional().default('medium'),
}).strict();

// Edit (the id is in the URL): every field optional, NO defaults, so an omitted
// field is left unchanged rather than reset.
export const editorialCustomCheckUpdateSchema = z.object(editorialCustomCheckShape).partial().strict();

// Dry-run preview (#1607): run an UNSAVED draft check against a series and return
// sample findings without persisting. Same authored fields as create (so the
// draft synthesizes into a runnable check), plus an optional per-run cap and the
// provider/model overrides the run route accepts.
export const editorialCustomCheckPreviewSchema = z.object({
  ...editorialCustomCheckShape,
  description: editorialCustomCheckShape.description.optional().default(''),
  scope: editorialCustomCheckShape.scope.optional().default('issue'),
  category: editorialCustomCheckShape.category.optional().default('custom'),
  severityDefault: editorialCustomCheckShape.severityDefault.optional().default('medium'),
  maxFindings: z.number().int().min(1).max(50).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).strict();

// settings.pipelineEditorialChecks slice (validated on PUT /api/settings when
// present). `checks` maps a checkId → its persisted enable/config; `customChecks`
// holds the user-defined check definitions (#1346).
//
// `customChecks` items are gated LENIENTLY (any object, unknown keys preserved):
// the authoring CRUD routes (editorialCustomCheck{Create,Update}Schema) are the
// strict input gate, while this wholesale-settings path must stay forward/older-
// peer compatible — a def carrying a future field (or a newer scope value) must
// not 400 an unrelated settings save. `buildCustomCheck`/`isValidCustomCheckDef`
// decide at read time which stored defs are actually runnable.
// `readinessGate` (#1316) is the editorial health convergence gate the autopilot
// loop + UI read as "manuscript clean": 'noOpenHigh' (default), the stricter
// 'noOpenHighOrMedium', or 'none' (disable). Optional + additive, so older peers
// and a never-configured install fall through to the service default.
// `maxArcVerifyRounds` / `maxEditorialRounds` bound the autopilot's verify→resolve
// convergence loops before it pauses for human review (0 = skip that gate
// entirely). Persisted defaults the autopilot reads when a run doesn't pass a
// per-run override; raised cap so a stubborn arc can be given more rounds. The
// cap is exported so the autopilot route schema (and any UI) share one ceiling
// instead of re-hardcoding it and drifting.
export const MAX_CONVERGENCE_ROUNDS = 20;
export const pipelineEditorialChecksSettingsSchema = z.object({
  checks: z.record(editorialCheckConfigSchema).optional(),
  customChecks: z.array(z.object({}).passthrough()).optional(),
  readinessGate: z.enum(READINESS_GATES).optional(),
  maxArcVerifyRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxEditorialRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Whole-manuscript beat-continuity convergence (#1510) — same bound + 0-skip
  // semantics. Optional + additive so older peers fall through to the default.
  maxBeatContinuityRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Foundation-quality gate (#2176, CWQE Phase 11). Before drafting, the
  // autopilot judges the whole foundation (world/characters/arc) against a
  // weighted rubric and iterates on the weakest dimension until it clears
  // `foundationThreshold` (a weighted [0,10] score), bounded by
  // `maxFoundationRounds` (0 = skip the gate). `foundationGate` toggles the gate
  // (defaults ON — the point of the phase). All three optional + additive so
  // older peers fall through to the defaults.
  foundationGate: z.boolean().optional(),
  foundationThreshold: z.number().min(0).max(10).optional(),
  maxFoundationRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Editorial-checks pause threshold (#1613). When the registry-driven editorial
  // checks pass surfaces ≥ N high-severity findings, the autopilot pauses the run
  // for human review instead of silently proceeding (the downstream health gate is
  // a backstop, but the per-step signal was misleading — a 50-high-finding pass
  // looked "complete"). 0 = off (default), so the behavior is opt-in and existing
  // installs are unchanged. Optional + additive so older peers fall through to off.
  // No upper bound mirrors the round caps — a large N just means "effectively off".
  checkFindingsPauseThreshold: z.number().int().min(0).optional(),
  // Pause-notification escalation (#1615). When an autopilot run pauses, post an
  // in-app notification (reason + resume link) so a paused run isn't missed until
  // the user opens the status page. Defaults ON (true) when unset — a zero-cost
  // informational signal — so this is the one autopilot setting that's opt-OUT.
  // Optional + additive so older peers fall through to the default.
  notifyOnPause: z.boolean().optional(),
  // Autopilot → CD teaser deliverable (CDO Phase 3, #2185). When on, once a comic
  // issue is text-ready + drafted the autopilot OPTIONALLY mints + starts a
  // Creative Director teaser/trailer video project seeded from it. Defaults OFF
  // (opt-in) — producing video is a fresh burst of LLM + render spend. Optional +
  // additive so older peers fall through to off.
  produceTeaser: z.boolean().optional(),
  // Iterate-to-quality revision loop (CWQE Phase 7, #2171). When on, the autopilot
  // cycles the weakest drafted issue through adversarial cuts + a judge-gated
  // keep/revert after the editorial-health gate, stopping on plateau /
  // hedged-convergence / maxCycles. Defaults OFF (opt-in) — a fresh burst of judge
  // + cut LLM spend. `revisionMaxCycles` is the cost ceiling; `revisionMinCycles`
  // floors the plateau/hedge stops; `revisionPlateauDelta` is the mean-score
  // movement below which the series counts as converged. All optional + additive.
  revisionEnabled: z.boolean().optional(),
  revisionMinCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionMaxCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionPlateauDelta: z.number().min(0).max(10).optional(),
  // NOTE: the autopilot's `unlockForRun` option is deliberately NOT stored here.
  // Every knob in this slice is a spend/quality default that is harmless to
  // reuse unattended; unlocking rewrites protection state the user set by hand,
  // and `seriesAutopilotScheduler` reads this slice — so a saved default would
  // arm lock-clearing for every scheduled run of every series. It is a per-run
  // option only (see seriesAutopilot/config.js#resolveAutopilotUnlockForRun).
  // Pipeline self-improvement. When on, a run that ends badly (or finishes with
  // unhealthy telemetry) spends ONE extra LLM call diagnosing whether the
  // AUTOMATION is at fault — a missing editorial step earlier in the pipeline, a
  // prompt producing unusable output, a runner swallowing a failure — and files
  // a CoS task against PortOS itself to fix it. Defaults OFF (opt-in): it is
  // fresh LLM spend AND it queues work that changes PortOS's own code.
  // The filed task always awaits human approval, runs in a worktree and opens a
  // PR — that is not configurable, matching every other autonomously generated
  // code-editing task in PortOS. Optional + additive so older peers fall
  // through to off.
  selfImprove: z.boolean().optional(),
  // Observing orchestrator — the continuous, self-dispatching sibling of
  // selfImprove. When on, an autopilot run watches its own telemetry step by
  // step and dispatches AUTO-APPROVED PortOS fix tasks (worktree + PR + review
  // loop + merge, no human gate) as pipeline defects surface, so unattended
  // runs continuously harden the pipeline itself. Defaults OFF (opt-in): it is
  // fresh LLM spend AND standing consent for unattended changes to PortOS's own
  // code — enabling it is that consent (see seriesAutopilot/observer.js for the
  // structural guards: execute-mode only, budget-gated, pass-capped, raised
  // confidence bar, full PR review loop). Persistable deliberately, unlike
  // unlockForRun: a scheduled unattended run is exactly where the user wants
  // the pipeline improving itself. Optional + additive so older peers fall
  // through to off.
  observer: z.boolean().optional(),
  // Evidence-based Series Autopilot routing. Metrics are collected regardless;
  // this opt-in permits sufficiently sampled recommendations to become the
  // run's soft provider/model/effort defaults. Explicit run/stage pins win.
  autoSelectModels: z.boolean().optional(),
  // Series Autopilot: run the whole pipeline on ONE provider/model/effort by
  // ignoring the per-stage pins set on the Prompts page. Defaults OFF (opt-in),
  // and persistable unlike unlockForRun — it re-routes spend but mutates
  // nothing, and an unattended scheduled run is exactly where "always use my
  // one provider" belongs. Optional + additive so older peers fall through to
  // off. See seriesAutopilot/config.js#resolveAutopilotOverrideStagePins and
  // lib/stagePinPolicy.js.
  overrideStagePins: z.boolean().optional(),
}).strict();

// Cursor-context payload for the CD-bridge suggest route — identical shape to
// the live continuation suggest (the server only needs a window around the
// cursor, not the whole manuscript).
export const writersRoomCdBridgeSuggestSchema = z.object({
  before: z.string().max(12_000).optional().default(''),
  after: z.string().max(12_000).optional().default(''),
  selection: z.string().max(8_000).optional().default(''),
}).strict();

// The reviewed CD-bridge proposal the writer sends into a new Creative Director
// project. Caps align with creativeDirectorTreatmentSchema / creativeDirectorSceneSchema
// so a gate-passing proposal always validates again at setTreatment time. The
// scene shape here is the PROPOSAL subset (intent/prompt/duration); the service
// assigns sceneId/order before calling setTreatment.
export const writersRoomCdBridgeSendSchema = z.object({
  proposal: z.object({
    logline: z.string().trim().min(1).max(500),
    synopsis: z.string().trim().min(1).max(5000),
    styleSpec: z.string().max(5000).optional().default(''),
    scenes: z.array(z.object({
      intent: z.string().trim().min(1).max(1000),
      prompt: z.string().trim().min(1).max(8000),
      durationSeconds: z.number().int().min(1).max(10),
      // Opt-in: continue from the prior scene's last frame (one continuous camera).
      continueFromPrior: z.boolean().optional(),
    }).strict()).min(1).max(120),
  }).strict(),
}).strict();

export const writersRoomDraftSaveSchema = z.object({
  body: z.string().max(5_000_000), // 5 MB ceiling — well over a long novel in plain text
  // Catalog ingredient ids this draft version references. Optional: when
  // absent the server scans the prose against the work's linked cast and
  // derives the list itself; when present (e.g. a client that already knows
  // the set) it's trusted as the snapshot. Bounded so a malformed body can't
  // balloon the manifest.
  referencedIngredientIds: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
}).strict();

export const writersRoomSnapshotSchema = z.object({
  label: z.string().trim().min(1).max(100).optional()
}).strict();

// A single storyboard shot within `stages.storyboards.scenes[].shots[]` (#1315).
// Validates the known shot fields and the new film-grammar enums (`shotType`,
// `screenDirection`) — each nullable + tolerant of the UI's "not captured"
// sentinel (null) and an empty-string clear (preprocessed to undefined). It is
// `.passthrough()` (NOT strip) because render-time hooks stamp extra fields onto
// a shot (`startFrameJobId`) that must survive a re-PATCH of the scenes array;
// the load-bearing normalization still happens in `sanitizeShot`
// (sceneExtractor.js) on the auto-extract path, but the route validates the
// enums up front so an invalid framing/direction is rejected, not silently kept.
export const storyboardShotSchema = z.object({
  // id / description are optional here (not at the sanitizer) so the route stays
  // as tolerant as `sanitizeShot`, which synthesizes a missing id and drops a
  // description-less shot — the route's job is only to reject a bad enum, not to
  // tighten the existing client contract.
  id: z.string().trim().max(80).optional(),
  // Bound loosely to the UI's textarea limit (maxLength=4000), NOT the
  // sanitizer's SHOT_DESCRIPTION_MAX (2000). The sanitizer truncates a long
  // description to 2000 downstream; the route must not REJECT one the UI lets a
  // user type (2001–4000) — that would turn the previously-passthrough scenes
  // contract into a 400. The route's job here is only to reject a bad enum.
  description: z.string().max(4000).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  continuityFromShotId: z.string().trim().max(80).nullable().optional(),
  shotType: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(SHOT_TYPES).nullable().optional(),
  ),
  screenDirection: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(SCREEN_DIRECTIONS).nullable().optional(),
  ),
}).passthrough();

// A storyboard scene as submitted through the visual-stage PATCH. Kept
// `.passthrough()` so the rich, evolving scene shape (heading, slugline,
// dialogue, sceneVideoJobId, …) flows through untouched — only `shots[]` is
// validated (through storyboardShotSchema) so a bad shotType/screenDirection
// is caught at the route instead of persisting unnormalized.
export const storyboardSceneSchema = z.object({
  shots: z.array(storyboardShotSchema).max(64).optional(),
}).passthrough();

export const writersRoomExerciseCreateSchema = z.object({
  workId: wrIdNullable.optional(),
  prompt: z.string().max(2000).optional().default(''),
  durationSeconds: z.number().int().min(60).max(3600).default(600),
  startingWords: z.number().int().min(0).default(0)
}).strict();

export const writersRoomExerciseFinishSchema = z.object({
  endingWords: z.number().int().min(0).optional(),
  appendedText: z.string().max(100000).nullable().optional()
}).strict();

export const writersRoomAnalysisCreateSchema = z.object({
  kind: z.enum(ANALYSIS_KINDS)
}).strict();

// Start options for the autonomous Polish loop (#2173). All bounds mirror the
// polish.js runtime clamps so a direct API call can't request an out-of-range
// run; the runner clamps again defensively.
export const writersRoomPolishStartSchema = z.object({
  cycles: z.number().int().min(1).max(3).optional(),
  plateauThreshold: z.number().min(0).max(100).optional(),
  cutTargetPercent: z.number().int().min(5).max(20).optional(),
  minCuts: z.number().int().min(1).max(50).optional(),
  maxCuts: z.number().int().min(1).max(50).optional(),
}).strict();

// Manual revert of a work body to an immutable Polish snapshot (#2173).
export const writersRoomPolishRevertSchema = z.object({
  snapshotId: z.string().trim().regex(/^wr-snap-[0-9a-f-]+$/i, 'Invalid snapshot id'),
}).strict();

// Character profile fields are all optional on update so the UI can PATCH
// one field at a time. `name` accepts trimmed non-empty when present; all
// other text fields tolerate '' so the writer can deliberately blank a field
// out and have the next analysis re-fill it.
const wrCharTextField = z.string().max(2000);
// Voice id namespace shared by writers-room + pipeline character routes:
// `engine:voiceName` (e.g. `kokoro:af_heart`). Nullable so a UI clear path
// can null it explicitly.
const wrVoiceIdField = z.string().trim().max(200).nullable();
// Portable production metadata. The nested schemas intentionally contain no
// provider/profile/path fields: those are machine-local voice/media concerns,
// not Universe canon and not wire-safe record data.
const voiceCanonField = z.object({
  version: z.number().int().min(1).max(BIBLE_LIMITS.VOICE_CANON_VERSION_MAX).optional(),
  description: z.string().max(BIBLE_LIMITS.VOICE_CANON_DESCRIPTION_MAX).optional(),
  defaultDelivery: z.string().max(BIBLE_LIMITS.VOICE_CANON_DELIVERY_MAX).optional(),
  emotionalRange: z.array(z.string().trim().min(1).max(BIBLE_LIMITS.VOICE_CANON_RANGE_ITEM_MAX)).max(BIBLE_LIMITS.VOICE_CANON_RANGE_MAX).optional(),
  avoid: z.array(z.string().trim().min(1).max(BIBLE_LIMITS.VOICE_CANON_AVOID_ITEM_MAX)).max(BIBLE_LIMITS.VOICE_CANON_AVOID_MAX).optional(),
  pronunciations: z.array(z.object({
    term: z.string().trim().min(1).max(BIBLE_LIMITS.VOICE_CANON_PRONUNCIATION_TERM_MAX),
    pronunciation: z.string().trim().min(1).max(BIBLE_LIMITS.VOICE_CANON_PRONUNCIATION_VALUE_MAX),
  }).strict()).max(BIBLE_LIMITS.VOICE_CANON_PRONUNCIATIONS_MAX).optional(),
  sourcePolicy: z.enum(VOICE_CANON_SOURCE_POLICIES).nullable().optional(),
  approved: z.boolean().optional(),
}).strict();
const identityPackField = z.object({
  assets: z.array(z.object({
    role: z.enum(IDENTITY_ASSET_ROLES),
    imageRef: z.string().trim().min(1).max(BIBLE_LIMITS.IMAGE_REF_MAX),
    approved: z.boolean().optional(),
  }).strict()).max(BIBLE_LIMITS.IDENTITY_PACK_ASSETS_MAX).optional(),
  avoid: z.array(z.string().trim().min(1).max(BIBLE_LIMITS.IDENTITY_PACK_AVOID_ITEM_MAX)).max(BIBLE_LIMITS.IDENTITY_PACK_AVOID_MAX).optional(),
}).strict();
// Wardrobe array (A2). `id` is omitted on POSTs by the UI — the sanitizer
// fills it from the server-side UUID factory. Limits sourced from
// BIBLE_LIMITS so bumping the constant updates Zod automatically.
const wrWardrobeField = z.array(z.object({
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(BIBLE_LIMITS.WARDROBE_NAME_MAX),
  description: z.string().max(BIBLE_LIMITS.WARDROBE_DESCRIPTION_MAX).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict()).max(BIBLE_LIMITS.WARDROBES_PER_CHARACTER_MAX);
// Structured relationship links (#1287). `id` is omitted on POSTs — the
// sanitizer mints it. `type` / `opposition.axis` accept the known enum tokens;
// an unrecognized value (legacy/peer payload) is coerced to `custom` by the
// sanitizer, not rejected here, so older clients never 400. Limits sourced
// from BIBLE_LIMITS so bumping a constant updates Zod automatically.
const wrOppositionField = z.object({
  axis: z.enum(RELATIONSHIP_OPPOSITION_AXES).or(z.string().trim().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_AXIS_MAX)),
  thisRole: z.string().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_ROLE_MAX).optional(),
  targetRole: z.string().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_ROLE_MAX).optional(),
  note: z.string().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_NOTE_MAX).optional(),
}).strict();
const wrRelationshipLinksField = z.array(z.object({
  id: z.string().trim().max(64).optional(),
  targetCharacterId: z.string().trim().min(1).max(BIBLE_LIMITS.RELATIONSHIP_TARGET_ID_MAX),
  type: z.enum(RELATIONSHIP_LINK_TYPES).or(z.string().trim().max(BIBLE_LIMITS.RELATIONSHIP_TYPE_MAX)).optional(),
  description: z.string().max(BIBLE_LIMITS.RELATIONSHIP_DESCRIPTION_MAX).optional(),
  opposition: wrOppositionField.nullable().optional(),
  locked: z.boolean().optional(),
}).strict()).max(BIBLE_LIMITS.RELATIONSHIP_LINKS_PER_CHARACTER_MAX);
// Optional psychology profile (#6414) and the Three Sliders (#2175) — the two
// structured surfaces the Universe cast editor already authors. Both are
// clearable: `psychology: null` (or an all-blank object) drops the profile so a
// character reads as unassessed again rather than keeping an empty husk, and a
// slider axis set to null un-rates it without disturbing the other two.
const wrPsychologyDriveField = z.object({
  desire: z.string().max(CHARACTER_PSYCHOLOGY_LIMITS.drive).nullable().optional(),
  fear: z.string().max(CHARACTER_PSYCHOLOGY_LIMITS.drive).nullable().optional(),
}).strict();
const wrPsychologyField = z.object({
  ...Object.fromEntries(CHARACTER_PSYCHOLOGY_TEXT_FIELDS.map((field) => [
    field, z.string().max(CHARACTER_PSYCHOLOGY_LIMITS[field]).nullable().optional(),
  ])),
  // '' and null both unset the assessment; the sanitizer's trimEnum maps an
  // unrecognized token to null rather than rejecting it.
  assessment: z.enum(PSYCHOLOGY_ASSESSMENTS).or(z.literal('')).nullable().optional(),
  assessmentNote: z.string().max(CHARACTER_PSYCHOLOGY_LIMITS.assessmentNote).nullable().optional(),
  drives: z.object(Object.fromEntries(
    PSYCHOLOGY_DRIVE_AXES.map((axis) => [axis, wrPsychologyDriveField.nullable().optional()]),
  )).strict().nullable().optional(),
}).strict();
const wrSlidersField = z.object(Object.fromEntries(CHARACTER_SLIDER_AXES.map((axis) => [
  axis,
  z.number().int().min(BIBLE_LIMITS.SLIDER_MIN).max(BIBLE_LIMITS.SLIDER_MAX).nullable().optional(),
]))).strict();
// Narrative character framework (#6417) — parity with what the Universe cast
// editor already authors and `sanitizeCharacter` already persists. Every field
// is optional AND tolerates its empty value ('' / [] / null) so a writer can
// deliberately clear one; absence leaves the stored value untouched, which is
// the absent-vs-intentionally-empty split the store relies on.
const wrCharFrameworkFields = Object.freeze({
  motivations: z.string().max(CHARACTER_FRAMEWORK_LIMITS.motivations).optional(),
  ghost: z.string().max(CHARACTER_FRAMEWORK_LIMITS.ghost).optional(),
  wound: z.string().max(CHARACTER_FRAMEWORK_LIMITS.wound).optional(),
  lie: z.string().max(CHARACTER_FRAMEWORK_LIMITS.lie).optional(),
  need: z.string().max(CHARACTER_FRAMEWORK_LIMITS.need).optional(),
  want: z.string().max(CHARACTER_FRAMEWORK_LIMITS.want).optional(),
  // '' and null both clear the declared arc; the sanitizer's trimEnum maps
  // anything it doesn't recognize to null rather than rejecting.
  arcType: z.enum(CHARACTER_ARC_TYPES).or(z.literal('')).nullable().optional(),
  secrets: z.array(z.string().trim().min(1).max(BIBLE_LIMITS.SECRET_MAX))
    .max(BIBLE_LIMITS.SECRETS_PER_CHARACTER_MAX).optional(),
  psychology: wrPsychologyField.nullable().optional(),
  sliders: wrSlidersField.nullable().optional(),
  // The optional five-stage evolution lens (#6445), reusing the SAME schema the
  // Pipeline series arc and the FableLoom plan validate against — a second
  // definition here would drift the stage vocabulary the moment one moved.
  // `null` (or an all-blank lens) is a real clear: `sanitizeCharacterEvolution`
  // collapses it to absent so the character reads as un-authored again.
  // Anything this object accepts must also appear in `editableFields` in
  // services/writersRoom/characters.js or the write is validated and dropped.
  evolution: characterEvolutionSchema.nullable().optional(),
});
// Shared between create and update — the two differ only in whether `name` is
// required, and drifting them apart is how `relationshipLinks` ended up
// accepted on one path and dropped on the other.
const wrCharacterFields = Object.freeze({
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  role: wrCharTextField.optional(),
  physicalDescription: wrCharTextField.optional(),
  personality: wrCharTextField.optional(),
  background: wrCharTextField.optional(),
  notes: wrCharTextField.optional(),
  voiceId: wrVoiceIdField.optional(),
  voiceCanon: voiceCanonField.optional(),
  identityPack: identityPackField.optional(),
  wardrobes: wrWardrobeField.optional(),
  relationshipLinks: wrRelationshipLinksField.optional(),
  ...wrCharFrameworkFields,
});
export const writersRoomCharacterCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  ...wrCharacterFields,
}).strict();
export const writersRoomCharacterUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  ...wrCharacterFields,
}).strict();

const wrPlaceTextField = z.string().max(2000);
// Inner ZodObject (without refine) — exposed so the Pipeline can `.extend()`
// it; `.refine()` returns a ZodEffects which has no `.extend()`.
const writersRoomPlaceCreateObject = z.object({
  name: z.string().trim().max(200).optional(),
  slugline: z.string().trim().max(200).optional(),
  description: wrPlaceTextField.optional(),
  palette: wrPlaceTextField.optional(),
  era: wrPlaceTextField.optional(),
  weather: wrPlaceTextField.optional(),
  recurringDetails: wrPlaceTextField.optional(),
  notes: wrPlaceTextField.optional(),
  // Cluster A — INT/EXT + time-of-day taxonomy. Case-insensitive accept
  // mirrors the sanitizer (`INT`/`int` both normalize to `INT`).
  intExt: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(['INT', 'EXT']),
  ).nullable().optional(),
  timeOfDay: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z.enum(['dawn', 'day', 'dusk', 'night']),
  ).nullable().optional(),
}).strict();
const placeHasIdentifier = (v) =>
  (v.name && v.name.trim()) || (v.slugline && v.slugline.trim());
export const writersRoomPlaceCreateSchema = writersRoomPlaceCreateObject.refine(
  placeHasIdentifier,
  { message: 'Place requires either a slugline or a name' },
);
export const writersRoomPlaceUpdateSchema = z.object({
  name: z.string().trim().max(200).optional(),
  slugline: z.string().trim().max(200).optional(),
  description: wrPlaceTextField.optional(),
  palette: wrPlaceTextField.optional(),
  era: wrPlaceTextField.optional(),
  weather: wrPlaceTextField.optional(),
  recurringDetails: wrPlaceTextField.optional(),
  notes: wrPlaceTextField.optional(),
  // Cluster A — INT/EXT + time-of-day taxonomy. Case-insensitive accept
  // mirrors the sanitizer (`INT`/`int` both normalize to `INT`).
  intExt: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(['INT', 'EXT']),
  ).nullable().optional(),
  timeOfDay: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z.enum(['dawn', 'day', 'dusk', 'night']),
  ).nullable().optional(),
}).strict();

const wrObjectTextField = z.string().max(2000);
// Structured object↔character attachment links (#1288). `id` is omitted on
// POSTs — the sanitizer mints it. `role` accepts the known archetype tokens; an
// unrecognized value (legacy/peer payload) is coerced to `custom` by the
// sanitizer, not rejected here, so older clients never 400. Limits sourced from
// BIBLE_LIMITS so bumping a constant updates Zod automatically.
const wrAttachmentsField = z.array(z.object({
  id: z.string().trim().max(64).optional(),
  characterId: z.string().trim().min(1).max(BIBLE_LIMITS.ATTACHMENT_CHARACTER_ID_MAX),
  emotion: z.string().max(BIBLE_LIMITS.ATTACHMENT_EMOTION_MAX).optional(),
  significance: z.string().max(BIBLE_LIMITS.ATTACHMENT_SIGNIFICANCE_MAX).optional(),
  origin: z.string().max(BIBLE_LIMITS.ATTACHMENT_ORIGIN_MAX).optional(),
  role: z.enum(ATTACHMENT_ROLES).or(z.string().trim().max(60)).optional(),
  locked: z.boolean().optional(),
}).strict()).max(BIBLE_LIMITS.ATTACHMENTS_PER_OBJECT_MAX);
export const writersRoomObjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  description: wrObjectTextField.optional(),
  significance: wrObjectTextField.optional(),
  attachments: wrAttachmentsField.optional(),
  notes: wrObjectTextField.optional(),
}).strict();
export const writersRoomObjectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  description: wrObjectTextField.optional(),
  significance: wrObjectTextField.optional(),
  attachments: wrAttachmentsField.optional(),
  notes: wrObjectTextField.optional(),
}).strict();

// Every story-bible route validates through the `writersRoom*` schemas above;
// there are no kind-neutral `*Bible*Schema` aliases beside them (#5730). If a
// Pipeline route needs one, add it next to that caller —
// `writersRoomPlaceCreateObject` is the un-refined ZodObject to `.extend()`.

// =============================================================================
// PROMPT STAGE CONFIG (server/routes/prompts.js PUT /:stage body)
// =============================================================================

// Per-call timeout bounds: STAGE_TIMEOUT_MIN_MS / STAGE_TIMEOUT_MAX_MS are
// imported (aliased) from aiToolkit/constants.js at the top of this file so
// the route validator, the runner (server/services/stageRunner.js), and the
// toolkit's own provider/run validation all share one source of truth. The
// client mirror in client/src/utils/formatters.js can't import across the
// server boundary — comments on both sides flag the requirement to keep
// them in lockstep.

// Accept either a number or a numeric string (UI inputs frequently serialize
// as strings) and validate the resulting integer. `nullable` lets the client
// clear the override explicitly with `null`; absence leaves it untouched.
export const stageConfigUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  // Writer/judge model split (#2167, CWQE Phase 3). A writer stage may pin a
  // DIFFERENT provider/model to grade its own output — `null`/'' clears the pin
  // so the judge falls back to the writer provider (see resolveJudgeForStage).
  // Without these keys the `.strip()` below would silently drop them from the
  // saved config, so schema parity is required in the same change.
  judgeProvider: z.string().nullable().optional(),
  judgeModel: z.string().nullable().optional(),
  // Per-stage reasoning-effort pin (#3641). Optional and opt-in: with no pin the
  // stage inherits a run-level `effortDefault` (Series Autopilot's run effort),
  // then the provider's own config. Validated against the union of every accepted
  // effort value across effort-capable CLIs — the runner clamps a level the chosen
  // provider doesn't offer down its ladder. `null`/'' clears the pin. Without this
  // key the `.strip()` below would silently drop a pin on save.
  effort: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(EFFORT_LEVELS).nullable().optional(),
  ),
  // Multi-candidate draft gate (#2169, CWQE Phase 5). Opt-in, DEFAULT OFF
  // (draftAttempts 1 = single generation, no gate) because each extra attempt
  // multiplies generation + judge cost. When > 1, generateStage re-rolls a fresh
  // draft while the composite qualityScore (#2167) is below draftGateThreshold,
  // up to the attempt cap, and keeps the best-scoring attempt. `null`/'' clears
  // the override. Only judgeable stages (prose/comicScript/teleplay) honor it.
  // Coerce digit-only strings (form inputs) the same way `timeout` does.
  draftAttempts: z.preprocess(
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
      return v;
    },
    z.number().int().min(1).max(3).nullable().optional(),
  ),
  draftGateThreshold: z.preprocess(
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
      return v;
    },
    z.number().min(0).max(10).nullable().optional(),
  ),
  timeout: z.preprocess(
    // Treat empty string as a "clear override" (null). Coerce digit-only
    // strings to numbers so form clients that send "900000" still parse —
    // but reject "1e3" / "1.5" / "0x10" by leaving them as the original
    // string so the inner `.number()` check fails. The digit-only rule
    // (and the `.trim()` before it) mirror `parseTimeoutMs` in
    // client/src/utils/formatters.js and `normalizeTimeout` in
    // server/services/stageRunner.js so all three reject the same shapes.
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed === '') return null;
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
      }
      return v;
    },
    z.number().int().min(STAGE_TIMEOUT_MIN_MS).max(STAGE_TIMEOUT_MAX_MS).nullable().optional()
  ),
  returnsJson: z.boolean().optional(),
  variables: z.array(z.string()).optional(),
}).strip();
// `.strip()` (Zod default) silently drops unknown keys instead of letting
// them flow into `updateStageConfig`'s `{...existing, ...updatedConfig}`
// spread. Stripping prevents prototype-pollution shapes (`__proto__`,
// `constructor`, `prototype`) and config-key squatting from a client that
// sends an unmodelled field. If a future stage field is added, extend the
// schema rather than reintroducing `.passthrough()`.

// =============================================================================
// PIPELINE ISSUE QUERY SCHEMAS
// =============================================================================

// Query params for GET /api/pipeline/series/:id/issues — both are optional;
// when either is present the route returns { items, total, offset, limit }
// instead of the legacy raw array so callers can page large series.
export const issuesListQuerySchema = z.object({
  offset: z.preprocess((v) => (v === undefined ? 0 : Number(v)), z.number().int().min(0)).default(0),
  limit: z.preprocess((v) => (v === undefined ? 1000 : Number(v)), z.number().int().min(1).max(1000)).default(1000),
});


// Query-less callers retain the legacy array; limit/offset opt into a snapshot.
export const writersRoomWorksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  cursor: z.string().regex(/^[0-9a-f-]{36}\.[0-9]+$/).max(80).optional(),
});
export const writersRoomWorkSummarySchema = z.object({
  id: z.string(), folderId: z.string().nullable().optional(), title: z.string(),
  kind: z.string(), status: z.string(), activeDraftVersionId: z.string().nullable().optional(),
  wordCount: z.number(), draftCount: z.number(),
  pipelineSeriesId: z.string().nullable(), pipelineIssueId: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export const writersRoomWorksResponseSchema = z.union([
  z.array(writersRoomWorkSummarySchema),
  z.object({
    items: z.array(writersRoomWorkSummarySchema), total: z.number().int(),
    limit: z.number().int(), offset: z.number().int(), nextCursor: z.string().nullable(),
  }),
]);

export const writersRoomSceneImageBodySchema = z.object({
  sceneId: nullishString, filename: nullishString, jobId: nullishString, prompt: nullishString,
});

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

export const issueCreateSchema = z.object({
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
  number: z.number().int().min(1).max(9999).optional(),
  // Per-issue length profile — can be set at create time so a user creating
  // a standalone oversized issue (e.g. an annual) doesn't have to open the
  // picker after the fact. Defaults server-side to 'standard'.
  lengthProfile: z.enum(LENGTH_PROFILE_NAMES).optional(),
  pageTarget: z.number().int().min(CUSTOM_PAGE_MIN).max(CUSTOM_PAGE_MAX).nullable().optional(),
  minutesTarget: z.number().int().min(CUSTOM_MINUTE_MIN).max(CUSTOM_MINUTE_MAX).nullable().optional(),
  ephemeral: z.boolean().optional(),
  // Arc pointers — same bounds as issuePatchSchema so the Arc Canvas can
  // create an issue directly inside a season (Zod would otherwise strip them).
  seasonId: z.string().trim().min(1).max(SEASON_ID_MAX).nullable().optional(),
  arcPosition: z.number().int().min(0).max(ARC_POSITION_MAX).nullable().optional(),
  arcRole: z.enum(ARC_ROLES).nullable().optional(),
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

export const titleLogoGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

export const voiceDiscoverSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Issue and stage request schemas

const stageInputSchema = z.object({
  status: z.enum(STAGE_STATUSES).optional(),
  input: z.string().max(STAGE_INPUT_MAX).optional(),
  output: z.string().max(STAGE_OUTPUT_MAX).optional(),
  errorMessage: z.string().max(STAGE_NOTES_MAX).optional(),
  locked: z.boolean().optional(),
});

// Strict base arm for the stage-record union below — a bare text-stage patch
// (only base fields) validates here, but a payload carrying any visual/audio
// extra key fails this arm and is routed to the matching specific arm instead
// of being silently key-stripped. The non-strict `stageInputSchema` stays the
// `.extend()` base for the specific arms (they re-apply `.strict()` themselves).
const baseStageStrictSchema = stageInputSchema.strict();

// Light per-cue arm for the audio stage (issue #863). The service-side
// `sanitizeAudioCue` enforces the real shape (ids, time sentinels, gain clamp);
// here we only bound sizes so a corrupt payload can't balloon the request.
const audioCueInputSchema = z.object({
  id: z.string().trim().max(AUDIO_CUE_ID_MAX).optional(),
  label: z.string().max(AUDIO_CUE_LABEL_MAX).nullable().optional(),
  prompt: z.string().max(AUDIO_CUE_PROMPT_MAX).nullable().optional(),
  engine: z.string().trim().max(AUDIO_CUE_ENGINE_MAX).nullable().optional(),
  startSec: z.number().nullable().optional(),
  endSec: z.number().nullable().optional(),
  trackFilename: z.string().trim().max(AUDIO_FILENAME_MAX).nullable().optional(),
  durationSec: z.number().nullable().optional(),
  gain: z.number().nullable().optional(),
}).strip();

// Visual stage records also accept pages/scenes/cdProjectId/videoPath — those
// are arbitrary structured artifacts written by the visual UI. Keep the
// validation light here so the artifact shape can evolve without a schema
// migration; the service-level sanitizer caps array length.
const visualStageInputSchema = stageInputSchema.extend({
  pages: z.array(z.any()).max(200).optional(),
  // Scenes stay passthrough (the rich scene shape evolves freely), but each
  // scene's shots[] is validated through storyboardSceneSchema so a bad
  // shotType/screenDirection enum is rejected at the route (#1315) instead of
  // persisting unnormalized. Non-storyboard visual stages simply carry no shots.
  scenes: z.array(storyboardSceneSchema).max(200).optional(),
  cdProjectId: z.string().trim().max(64).nullable().optional(),
  videoPath: z.string().trim().max(1000).nullable().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).nullable().optional(),
  quality: z.enum(QUALITIES).nullable().optional(),
  // Per-stage gen config — image mode + optional pinned model + optional
  // refine-LLM override. Sanitizer drops the field entirely when nothing
  // is set, so a `null` here clears it.
  genConfig: z.object({
    imageMode: z.enum(['auto', ...QUEUEABLE_IMAGE_MODES]).optional(),
    imageModelId: z.string().trim().max(200).nullable().optional(),
    refineProvider: z.string().trim().max(200).nullable().optional(),
    refineModel: z.string().trim().max(200).nullable().optional(),
    applyCharacterLoras: z.boolean().optional(),
  }).nullable().optional(),
  // Comic-issue front cover. Only meaningful on the comicPages stage; the
  // service-side sanitizer drops the field on other visual stages.
  cover: z.object({
    script: z.string().max(8000).optional(),
    imageJobId: z.string().trim().max(200).nullable().optional(),
    prompt: z.string().max(16_000).nullable().optional(),
  }).nullable().optional(),
  // Comic-issue back cover — identical shape to `cover`. Only meaningful
  // on the comicPages stage. The render route + filename hook treat the
  // two slots symmetrically; only the rendered prompt differs (no
  // masthead, explicit no-text negative — back covers are illustration-
  // only).
  backCover: z.object({
    script: z.string().max(8000).optional(),
    imageJobId: z.string().trim().max(200).nullable().optional(),
    prompt: z.string().max(16_000).nullable().optional(),
  }).nullable().optional(),
}).strict();

// Audio stage payloads carry lines[] (voice-over per dialogue line), a nullable
// music descriptor, the whole-episode `audioMode` selector, and arc-driven
// `cues[]` (issue #863). Light validation — the sanitizer in
// services/pipeline/issues.js enforces per-line / per-music / per-cue shape.
// Without this arm in the union below, audio PATCHes fall through and the
// base/visual arms strip lines/music/audioMode/cues.
//
// `.strict()` is load-bearing here: the union arms below all share the same
// optional base fields, so a plain object parses against *any* arm and Zod's
// default key-stripping would let an audio payload match the visual arm FIRST,
// silently dropping audioMode/cues. Strict arms reject unknown keys, so an
// audio payload (with audioMode/cues/lines/music) only validates against THIS
// arm and reaches the audio sanitizer intact.
const audioStageInputSchema = stageInputSchema.extend({
  lines: z.array(z.any()).max(1000).optional(),
  music: z.any().nullable().optional(),
  audioMode: z.enum(AUDIO_MODES).optional(),
  cues: z.array(audioCueInputSchema).max(AUDIO_CUES_MAX).optional(),
}).strict();

export const issuePatchSchema = z.object({
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX).optional(),
  number: z.number().int().min(1).max(9999).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  // Phase 2 of Story Arc Planning: optional pointer back to a season +
  // ordinal within that season. `null` clears the assignment.
  seasonId: z.string().trim().min(1).max(SEASON_ID_MAX).nullable().optional(),
  arcPosition: z.number().int().min(0).max(ARC_POSITION_MAX).nullable().optional(),
  arcRole: z.enum(ARC_ROLES).nullable().optional(),
  // Per-issue length profile. Drives the prompt-template size targets
  // (beats / prose words / page count / minute count). pageTarget +
  // minutesTarget are only meaningful when lengthProfile === 'custom'.
  lengthProfile: z.enum(LENGTH_PROFILE_NAMES).optional(),
  pageTarget: z.number().int().min(CUSTOM_PAGE_MIN).max(CUSTOM_PAGE_MAX).nullable().optional(),
  minutesTarget: z.number().int().min(CUSTOM_MINUTE_MIN).max(CUSTOM_MINUTE_MAX).nullable().optional(),
  // Stage-record arms are all `.strict()` (see audioStageInputSchema above):
  // every arm shares the same optional base fields, so a non-strict arm would
  // accept (and key-strip) a payload meant for a sibling arm. With strict arms
  // a payload only validates against the arm whose extra keys it actually
  // carries — visual payloads (pages/scenes/…) reach the visual arm, audio
  // payloads (lines/music/audioMode/cues) reach the audio arm, and bare
  // text-stage patches (status/output/locked only) fall through to the base.
  // Order is now defensive rather than load-bearing, but we still place the
  // more-specific arms first; the bare base last.
  stages: z.record(z.string(), z.union([visualStageInputSchema, audioStageInputSchema, baseStageStrictSchema])).optional(),
  ephemeral: z.boolean().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

export const generateSchema = z.object({
  seedInput: z.string().max(STAGE_INPUT_MAX).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  // Explicit source stages to feed the generation (backport support: generate
  // any stage FROM any other populated stage). Omit for the conventional
  // forward source. The service drops the target itself and empty stages.
  sourceStageIds: z.array(z.enum(TEXT_STAGE_IDS)).optional(),
});

// Path params for the text-stage progress stream. The stage must be a text
// stage — a visual/audio stage has no text-generation channel to attach to.
export const stageProgressParamsSchema = z.object({
  id: z.string().trim().min(1).max(200),
  stageId: z.enum(TEXT_STAGE_IDS),
});

export const visualGenerateSchema = z.object({
  description: z.string().trim().min(1).max(8000),
  // Matched against the series places bible when present.
  slugline: z.string().trim().max(200).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // Per-scene wardrobe picks threaded from the storyboards UI — the generic
  // visual route has no scene index, so the client sends the selected
  // appearances directly. Each pins one canon character to one of its
  // wardrobes; the prompt builder appends the wardrobe after the character's
  // physical description.
  characterAppearances: z.array(z.object({
    characterId: z.string().trim().min(1).max(120),
    wardrobeId: z.string().trim().min(1).max(120).nullable().optional(),
  })).max(50).optional(),
  // Per-render opt-out for trained character-LoRA auto-apply (local mode).
  applyCharacterLoras: z.boolean().optional().default(true),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

// Full-comic-page render: same knobs as panel render minus `description` /
// `slugline` (the prompt is built server-side from the page's panels[] so it
// stays in sync with whatever the script-extractor produced).
export const comicPageRenderSchema = z.object({
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // See covers.js's makeCoverRenderSchema for the proof/final semantics.
  target: z.enum(COMIC_PAGE_VARIANTS).optional().default('proof'),
  useProofAsBase: z.boolean().optional().default(false),
  // Consistency reference: re-render this page using an adjacent ('prior'/'next')
  // or explicit (0-based index) already-rendered page as a reference image, so a
  // continuing scene keeps incidental/un-described characters + environment
  // consistent. Resolved + bounds-checked in enqueueVisualComicPage.
  //   - omitted / 'auto' → auto-chain off the prior page within the same scene,
  //     render fresh across a scene boundary (the default).
  //   - 'none' → force a fresh render with no reference, even mid-scene.
  //   - 'prior' / 'next' / <index> → explicit reference (errors if unrendered).
  referencePage: z.union([z.enum(['prior', 'next', 'auto', 'none']), z.number().int().min(0)]).optional(),
  // Per-render opt-out for trained character-LoRA auto-apply (local mode).
  applyCharacterLoras: z.boolean().optional().default(true),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

// Per-page "Refine" — a small image-to-image correction to an already-rendered
// page (issue #1534). `instruction` is the user's free-text change; the LLM
// adjusts the page's stored render prompt and the page re-renders i2i from its
// own existing image. The render-tuning fields mirror comicPageRenderSchema,
// minus the compose-from-source-only `useProofAsBase` / `referencePage` /
// `applyCharacterLoras` (a from-self refine has no proof-vs-final base choice
// and no fresh character matching). `target` selects which rendered variant to
// refine; absent → server auto-picks (final when present, else proof).
export const comicPageRefineSchema = z.object({
  instruction: z.string().trim().min(1).max(2000),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  target: z.enum(COMIC_PAGE_VARIANTS).optional(),
  // i2i denoise — low preserves the page, just enough to apply the change.
  initImageStrength: z.number().min(0).max(1).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  // No `extraStyle`: the refine renders the LLM-adjusted prompt verbatim and
  // skips composeComicPagePrompt, so a style suffix would be silently dropped.
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

export const episodeVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.enum(QUALITIES).optional(),
  modelId: z.string().trim().max(64).optional(),
  force: z.boolean().optional(),
});

// Single-scene video render. Lighter schema than episodeVideo because there
// is no stitch step — just one t2v render against the scene's existing
// description.
export const sceneVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  modelId: z.string().trim().max(64).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
});

// Provider/model picker for the LLM-driven panel/scene prompt refine. Both
// are optional — server falls back to the active provider + stage default.
export const promptRefineSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Same picker plus a `count` for the non-destructive N-candidate fan-out
// (issue #904). `count` is clamped server-side to IMAGE_PROMPT_CANDIDATE_MAX,
// but bound it here too so an out-of-range value is a clean 400 rather than a
// silently-clamped surprise.
export const imagePromptsSchema = promptRefineSchema.extend({
  count: z.number().int().min(1).max(IMAGE_PROMPT_CANDIDATE_MAX).optional().default(3),
});

// Source for scene extraction: which text stage to read from (`prose` →
// granular paragraph-grain breakdown via `writers-room-script`; `teleplay`
// → slugline-grain parse via `pipeline-extract-scenes`). `force` overrides
// the "you have N hand-curated scenes already" guard.
// Enum values match `SOURCE_KIND` verbatim so the route forwards `body.from`
// straight through — same string also names the issue's text stage.
export const extractScenesSchema = z.object({
  from: z.enum([SOURCE_KIND.PROSE, SOURCE_KIND.TELEPLAY]).optional().default(SOURCE_KIND.TELEPLAY),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(128).optional(),
  force: z.boolean().optional(),
});

export const extractComicPagesSchema = z.object({
  force: z.boolean().optional(),
});

export const extractCanonFromScriptSchema = z.object({
  providerOverride: z.string().trim().max(80).optional(),
  model: z.string().trim().max(128).optional(),
});

export const describeCanonFromProseSchema = z.object({
  providerOverride: z.string().trim().max(80).optional(),
  model: z.string().trim().max(128).optional(),
  // Nouns to backfill — typically the appears-in-this-issue entries that lack
  // a description. The server re-validates each against the universe canon.
  targets: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    kind: z.enum(['character', 'place', 'object']),
  })).min(1).max(500),
});

export const comicPagePatchSchema = z.object({
  rawText: z.string().max(40000),
});

export const autoRunSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
  // Optional opt-in to extend the auto-run past text stages: kicks off the
  // episodeVideo handoff to Creative Director once scripts are done. Burns
  // GPU minutes, so default is off.
  includeVideo: z.boolean().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.enum(QUALITIES).optional(),
  modelId: z.string().trim().max(64).optional(),
});

export const restoreSchema = z.object({
  runId: z.string().trim().min(1).max(200),
});

// Narration, dialogue, and music request schemas

export const ttsPreviewSchema = z.object({
  voiceId: z.string().trim().min(1).max(200),
  text: z.string().trim().max(500).optional(),
});

export const ttsNarrateSchema = z.object({
  // Do NOT trim: the segment start/end offsets are computed against this exact
  // string and the client slices its original `content` with them, so trimming
  // here would shift every span. narrateProse rejects all-whitespace text.
  text: z.string().min(1).max(12000),
  voiceId: z.string().trim().max(200).optional(),
});

export const ttsNarrateSegmentSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voiceId: z.string().trim().max(200).optional(),
  expectedSpeech: z.string().trim().max(4000).nullable().optional(),
});

export const ttsNarrateSegmentRescoreSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  heard: z.string().max(4000),
  expectedSpeech: z.string().trim().max(4000).nullable().optional(),
});

export const extractAudioLinesSchema = z.object({ force: z.boolean().optional() });

export const lineEditSchema = z.object({
  text: z.string().max(4000).optional(),
  voiceIdOverride: z.string().trim().max(200).nullable().optional(),
  // Per-line VO start offset (seconds into the stitched episode). null clears
  // the placement so the muxer skips the line. The sanitizer clamps the range.
  offsetSec: z.number().min(0).max(7200).nullable().optional(),
  // Accepted recognizer spelling ("Ay-Ai" for "AI"); null clears it (#10250).
  expectedSpeech: z.string().trim().max(4000).nullable().optional(),
});

export const lineRenderSchema = z.object({ voiceId: z.string().trim().max(200).optional() });

export const musicAttachSchema = z.object({
  trackFilename: z.string().trim().min(1).max(500),
  label: z.string().trim().max(200).nullable().optional(),
});

// Bind to the service registry at the router so validation shares its engine limits.
export function createPipelineMusicSchemas(engines) {
  // Every model id across all engines — the schema validates `modelId` against
  // this union and `generateMusic` resolves it within the chosen engine (falling
  // back to that engine's default for a mismatched id).
  const modelIds = Object.values(engines).flatMap((engine) => engine.models.map((model) => model.id));

  // The widest duration window across engines; per-engine clamping happens in the
  // service, so the schema just rejects absurd values.
  const maxDurationSec = Math.max(...Object.values(engines).map((engine) => engine.maxDurationSec));

  const musicGenerateSchema = z.object({
    prompt: z.string().max(800).refine((value) => value.trim().length > 0, 'prompt is required'),
    engine: z.enum(Object.keys(engines)).optional(),
    durationSec: z.number().min(1).max(maxDurationSec).optional(),
    modelId: z.enum(modelIds).optional(),
  });

  const cuesGenerateSchema = z.object({
    engine: z.enum(Object.keys(engines)).optional(),
    providerOverride: z.string().trim().max(80).optional(),
    modelOverride: z.string().trim().max(128).optional(),
    force: z.boolean().optional(),
  });

  const cueRenderSchema = z.object({
    engine: z.enum(Object.keys(engines)).optional(),
    durationSec: z.number().min(1).max(maxDurationSec).optional(),
    modelId: z.enum(modelIds).optional(),
  });

  return { musicGenerateSchema, cuesGenerateSchema, cueRenderSchema };
}

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
