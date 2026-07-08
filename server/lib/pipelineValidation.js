/**
 * Creative-production pipeline Zod schemas (split out of validation.js,
 * issue #1831).
 *
 * Covers the Writers Room (works, folders, live-mode, drafts, snapshots,
 * exercises, analyses), the story-bible character/place/object schemas (+ the
 * kind-neutral Pipeline re-exports), registry-driven editorial checks, storyboard
 * shot/scene shapes, the prompt-stage config, and the pipeline issue-list query.
 * validation.js re-exports everything here (flat) so existing deep imports keep
 * working; the barrel surfaces it as the `pipelineValidation` namespace.
 */
import { z } from 'zod';
import { partialWithoutDefaults } from './zodCompat.js';
import { WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS } from './writersRoomPresets.js';
import { ALL_STYLE_IDS, STYLE_ID } from './writersRoomStylePresets.js';
import { BIBLE_LIMITS, RELATIONSHIP_LINK_TYPES, RELATIONSHIP_OPPOSITION_AXES, ATTACHMENT_ROLES } from './storyBible.js';
import { MIN_TIMEOUT as STAGE_TIMEOUT_MIN_MS, MAX_TIMEOUT as STAGE_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';
import { CHECK_SCOPES, CHECK_SEVERITIES } from './editorial/checkRegistry.js';
import { SHOT_TYPES, SCREEN_DIRECTIONS } from './shotGrammar.js';

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
  readinessGate: z.enum(['noOpenHigh', 'noOpenHighOrMedium', 'none']).optional(),
  maxArcVerifyRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxEditorialRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Whole-manuscript beat-continuity convergence (#1510) — same bound + 0-skip
  // semantics. Optional + additive so older peers fall through to the default.
  maxBeatContinuityRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
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
// assigns sceneId/order/useContinuationFromPrior before calling setTreatment.
export const writersRoomCdBridgeSendSchema = z.object({
  proposal: z.object({
    logline: z.string().trim().min(1).max(500),
    synopsis: z.string().trim().min(1).max(5000),
    styleSpec: z.string().max(5000).optional().default(''),
    scenes: z.array(z.object({
      intent: z.string().trim().min(1).max(1000),
      prompt: z.string().trim().min(1).max(8000),
      durationSeconds: z.number().int().min(1).max(10),
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
export const writersRoomCharacterCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  role: wrCharTextField.optional(),
  physicalDescription: wrCharTextField.optional(),
  personality: wrCharTextField.optional(),
  background: wrCharTextField.optional(),
  notes: wrCharTextField.optional(),
  voiceId: wrVoiceIdField.optional(),
  wardrobes: wrWardrobeField.optional(),
  relationshipLinks: wrRelationshipLinksField.optional(),
}).strict();
export const writersRoomCharacterUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  role: wrCharTextField.optional(),
  physicalDescription: wrCharTextField.optional(),
  personality: wrCharTextField.optional(),
  background: wrCharTextField.optional(),
  notes: wrCharTextField.optional(),
  voiceId: wrVoiceIdField.optional(),
  wardrobes: wrWardrobeField.optional(),
  relationshipLinks: wrRelationshipLinksField.optional(),
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

// Generic bible-entry schemas — re-exports of the writers-room schemas under
// kind-neutral names so the Pipeline routes share the same validation
// surface and funnel through the canonical sanitizer in storyBible.js.
// `placeBibleCreateSchema` is the un-refined ZodObject (not the refined
// `writersRoomPlaceCreateSchema`) so Pipeline can `.extend()` it.
export const characterBibleCreateSchema = writersRoomCharacterCreateSchema;
export const characterBibleUpdateSchema = writersRoomCharacterUpdateSchema;
export const placeBibleCreateSchema = writersRoomPlaceCreateObject;
export const placeBibleUpdateSchema = writersRoomPlaceUpdateSchema;
export const objectBibleCreateSchema = writersRoomObjectCreateSchema;
export const objectBibleUpdateSchema = writersRoomObjectUpdateSchema;

// =============================================================================
// PROMPT STAGE CONFIG (server/routes/prompts.js PUT /:stage body)
// =============================================================================

// Per-call timeout bounds: STAGE_TIMEOUT_MIN_MS / STAGE_TIMEOUT_MAX_MS are
// imported (aliased) from aiToolkit/constants.js at the top of this file so
// the route validator, the runner (server/lib/stageRunner.js), and the
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
  timeout: z.preprocess(
    // Treat empty string as a "clear override" (null). Coerce digit-only
    // strings to numbers so form clients that send "900000" still parse —
    // but reject "1e3" / "1.5" / "0x10" by leaving them as the original
    // string so the inner `.number()` check fails. The digit-only rule
    // (and the `.trim()` before it) mirror `parseTimeoutMs` in
    // client/src/utils/formatters.js and `normalizeTimeout` in
    // server/lib/stageRunner.js so all three reject the same shapes.
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
