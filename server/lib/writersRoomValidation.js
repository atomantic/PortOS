// Validates Writers Room works, drafts, exercises and story-bible records.

import { z } from 'zod';
import { partialWithoutDefaults } from './zodCompat.js';
import { WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS } from './writersRoomPresets.js';
import { ALL_STYLE_IDS, STYLE_ID } from './writersRoomStylePresets.js';
import {
  BIBLE_LIMITS,
  RELATIONSHIP_LINK_TYPES,
  RELATIONSHIP_OPPOSITION_AXES,
  ATTACHMENT_ROLES,
  VOICE_CANON_SOURCE_POLICIES,
  IDENTITY_ASSET_ROLES,
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
import { characterEvolutionSchema } from './characterEvolutionValidation.js';
import { nullishString } from './sharedSchemas.js';

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
