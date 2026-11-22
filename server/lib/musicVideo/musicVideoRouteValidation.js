/**
 * Music Video route request-body schemas.
 *
 * Holds the Zod schemas that only server/routes/musicVideo*.js validate
 * against, split out of musicVideoValidation.js so editing a route schema does
 * not re-select the service suites that import one enum or record schema from
 * that file (#16826). Shared enums, predicates and record schemas stay in
 * musicVideoValidation.js; this module imports them, never the reverse.
 */

import { CAST_SETS_IMAGE_EDIT_MAX } from './musicVideoCastSetsImageEdit.js';
import { SPEND_ADJUSTMENT_LANES } from './musicVideoSpend.js';
import { MUSIC_VIDEO_RENDER_TIERS, MUSIC_VIDEO_UPGRADE_METHODS } from './musicVideoRenderTier.js';
import {
  ROUTE_MAP_FEATURE_KINDS, ROUTE_MAP_FEATURE_LABEL_MAX, ROUTE_MAP_FEATURE_SIDES, ROUTE_MAP_FEATURES_MAX, ROUTE_MAP_HEADINGS, ROUTE_MAP_MAX, ROUTE_MAP_NAME_MAX, ROUTE_MAP_NOTE_MAX, ROUTE_MAP_STOPS_MAX, ROUTE_MAP_TRAVEL_MAX,
} from './musicVideoRouteMapLimits.js';
import { SHOT_CAMERA_KINDS, SHOT_CAMERA_MAX, SHOT_CAMERA_OUTPUTS } from './musicVideoShotSheet.js';
import { festivalPacketSchema } from './musicVideoFestivalPacket.js';
import { MUSIC_VIDEO_MEDIA_MODES } from './musicVideoMediaPolicy.js';
import { filmLookSchema } from '../filmLookValidation.js';
import { MUSIC_VIDEO_CAMERA_FRAME_ASPECTS } from './musicVideoFilmLook.js';
import { PRODUCTION_MEDIUMS } from './musicVideoProductionMedium.js';
import { TITLE_CARD_FONTS, TITLE_CARD_LIMITS, TITLE_CARD_POSITIONS, TITLE_CARD_SLIDES, TITLE_CARD_STYLES } from './musicVideoTitleCard.js';
import { STATS_OUTRO_LIMITS, STATS_OUTRO_LINES } from './musicVideoStatsOutro.js';
import { CREDITS_OUTRO_LAYOUTS, CREDITS_OUTRO_LIMITS } from './musicVideoCreditsOutro.js';
import { COVER_DESIGN_OPTIONS } from './musicVideoCoverOverlay.js';
import { DISTROKID_REMEMBERED_OPTIONS } from '../distrokidGenres.js';
import { CROSS_LINK_EDIT_TARGETS } from './musicVideoCrossLinks.js';
import { MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT } from '../referenceLimits.js';
import { executionOptionsSchema } from '../aiToolkit/internal/executionOptionsValidation.js';
import { z } from 'zod';
import { PREVIZ_CAMERA_STYLES } from './musicVideoPrevizLimits.js';
import { COLOR_MATCH_LIMITS } from '../shotColorMatch.js';
import { EFFORT_LEVELS } from '../provider/providerModels.js';
import { shotActionContractProblem } from './musicVideoActionContract.js';
import { MUSIC_VIDEO_MEDIA } from './musicVideoMediumPlan.js';
import { MUSIC_VIDEO_SHOT_GLITCH_LIMIT, MUSIC_VIDEO_TRANSITIONS } from './musicVideoTransitions.js';
import { MUSIC_VIDEO_WIPE_SEC, MUSIC_VIDEO_WIPES } from './musicVideoWipes.js';
import { MUSIC_VIDEO_AUDIO_LAYER_LIMIT, MUSIC_VIDEO_AUDIO_LAYER_MAX_START_SEC, MUSIC_VIDEO_AUDIO_LAYER_MAX_VOLUME, MUSIC_VIDEO_MAX_SUBJECTS } from './musicVideoLimits.js';
import { STORYBOARD_ID_PATTERN } from '../storyboardVocabulary.js';
import { MUSIC_VIDEO_MAX_CAMEOS, MUSIC_VIDEO_CAMEO_MAX_REFERENCES, MUSIC_VIDEO_CAMEO_MAX_SOURCES, MUSIC_VIDEO_CAMEO_REFERENCE_SOURCES, MUSIC_VIDEO_CAMEO_RESEARCH_STATUSES, MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN } from './musicVideoCameos.js';
import {
  MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD,
  MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX,
  MUSIC_VIDEO_AUTOMATION_TOOL_IDS,
  MUSIC_VIDEO_LLM_STAGES,
  MUSIC_VIDEO_CHECKIN_MODES,
} from './musicVideoAutomation.js';
import {
  AUTONOMOUS_AUTO_APPROVE_STAGES,
  AUTONOMOUS_CHECKPOINT_IDS,
  AUTONOMOUS_LIMIT_BOUNDS,
  AUTONOMOUS_NAME_MAX,
  AUTONOMOUS_ORIGINS,
  AUTONOMOUS_PROMPT_MAX,
  AUTONOMOUS_SONG_SOURCES,
  LOCAL_MUSIC_CODE_LANGUAGES,
  LOCAL_MUSIC_TYPES,
  SUNO_LIMITS,
  SUNO_MODEL_PATTERN,
  SUNO_VOCAL_GENDERS,
  normalizeAutoApprove,
} from './musicVideoAutonomous.js';
import { MUSCRIPTOR_MODELS } from '../muscriptorModels.js';
import { MUSIC_VIDEO_CHARACTER_STYLE_IDS } from './musicVideoCharacterStyles.js';
import { IMAGE_GEN_MODES, VIDEO_GEN_MODES } from '../generationModes.js';
import { GREYBOX_SHOT_ID_MAX, GREYBOX_SHOT_ID_PATTERN } from '../greyboxVocabulary.js';
import { musicVideoTemplateEffectsSchema, MUSIC_VIDEO_STATUSES, musicVideoConceptSchema, musicVideoVideoSettingsSchema, timedSec, musicVideoLyricCueSchema, musicVideoShotGlitchSchema, musicVideoPrevizSchema, galleryImageName, musicVideoVisualSpecSchema, musicVideoCastInputsSchema, MUSIC_VIDEO_DOCUMENT_TEMPLATES, MUSIC_VIDEO_DOCUMENT_DIRECTORY, musicVideoCompositionSchema, MUSIC_VIDEO_TREATMENT_SHOT_MODES, MUSIC_VIDEO_SHOT_ROUTES, MUSIC_VIDEO_NEGATIVE_SPACE, MUSIC_VIDEO_TYPOGRAPHY_ROLES, MUSIC_VIDEO_PROOF_STATUSES, musicVideoTreatmentBriefSchema, MUSIC_VIDEO_PUBLISH_TARGETS, MUSIC_VIDEO_DEV_ARTIFACT_KINDS, MUSIC_VIDEO_DEV_ARTIFACT_STATUSES, castSetsText, musicVideoProductionDraftSchema } from './musicVideoValidation.js';

export const musicVideoShotReferenceRepairSchema = z.object({ problemId: z.string().regex(/^[a-f0-9]{64}$/) });
export const musicVideoDcpRequestSchema = z.object({ grade: z.enum(['rec709', 'rec1886']), renderHistoryId: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const makingOfId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const musicVideoMakingOfSelectionSchema = z.object({
  projects: z.array(z.object({
    projectId: makingOfId,
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
    assets: z.array(z.object({
      id: z.string().min(1).max(250),
      rights: z.enum(['unknown', 'owned', 'licensed']).default('unknown'),
      attribution: z.string().max(2000).default(''),
      ownershipConfirmed: z.boolean().default(false),
    }).strict()).max(300),
  }).strict()).min(1).max(8),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((selection, ctx) => {
  if (new Set(selection.projects.map(p => p.projectId)).size !== selection.projects.length
    || selection.projects.some(p => new Set(p.assets.map(a => a.id)).size !== p.assets.length)) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate project or asset selection' });
  }
});

export const musicVideoSongDraftSchema = z.object({
  title: z.string().trim().min(1).max(80), style: z.string().trim().min(1).max(1000),
  lyrics: z.string().max(5000), instrumental: z.boolean().default(false),
}).strict().refine((v) => v.instrumental || v.lyrics.trim().length > 0, 'Lyrics are required for a vocal song');
export const musicVideoSongActionSchema = z.object({ revisionId: z.string().min(1) }).strict();
export const musicVideoSongSelectSchema = z.object({ revisionId: z.string().min(1), songId: z.string().min(1) }).strict();
// Revise the song from a library track (an imported Suno link): forks a new version on it.
export const musicVideoSongFromTrackSchema = z.object({ trackId: z.string().min(1).max(128) }).strict();

// A project is authored hands-on (director) or seeded by the AI planner
// (autonomous); both share the same record + scene board.
const MUSIC_VIDEO_MODES = ['director', 'autonomous'];

// Re-read a project's song style from its Suno song link.
// Explicit cleanup keeps comparison looks unless the director opts to purge them.
export const musicVideoRenderCleanupSchema = z.object({ unusedLooks: z.boolean().optional() }).strict();

// The rendered-so-far player: `light` asks for the lighter phone copy.
export const musicVideoRenderPreviewSchema = z.object({ light: z.boolean().optional() }).strict();
// Mix the cold open's sound for the animatic; nothing to choose.
export const musicVideoColdOpenAudioSchema = z.object({}).strict();
export const musicVideoSongStyleSunoSchema = z.object({ url: z.string().trim().min(1).max(2000) });

// A musical-phrase annotation: a span of the song with an optional visual
// intent (what the picture should do there). Phrase edges are preferred cut
// points for the shot planner and the intent is handed to the prompt seeder.
const musicVideoPhraseSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().max(120).optional(),
  startSec: timedSec,
  endSec: timedSec,
  intent: z.string().max(2000).optional(),
}).strict();

// Shot pacing for the planner. `maxShotSec` is capped at the renderer's clip
// capacity (one generated clip); `hookSec` bounds the opening shot so the video opens on a cut.
const musicVideoPacingSchema = z.object({
  minShotSec: z.number().min(0.5).max(60).optional(),
  maxShotSec: z.number().min(1).max(120).optional(),
  hookSec: z.number().min(0.5).max(60).optional(),
}).strict();

// The cameras that exist in this video, and each shot's plan (lib/musicVideo/musicVideoShotSheet.js).
const musicVideoCameraSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(SHOT_CAMERA_KINDS),
  output: z.enum(SHOT_CAMERA_OUTPUTS).nullable().optional(),
  owner: z.string().trim().max(120).optional(),
  // How this camera behaves in the story, e.g. who borrows it, or that nobody ever looks at it.
  rule: z.string().trim().max(1000).optional(),
  // How the camera moves in the greybox previz while it is a cut's camera (lib/musicVideo/musicVideoPreviz.js).
  previzStyle: z.enum(PREVIZ_CAMERA_STYLES).optional(),
  // This camera's finishing look. A shot with no look of its own uses it; null follows the video.
  filmLook: filmLookSchema.nullable().optional(),
  // The frame this camera plays inside the video: 4:3 pillarboxes in 16:9. Null is the video's own frame.
  frame: z.object({
    aspect: z.enum(MUSIC_VIDEO_CAMERA_FRAME_ASPECTS),
    matte: z.string().regex(/^#[0-9a-f]{6}$/i, 'matte is #rrggbb').optional(),
  }).strict().nullable().optional(),
  // Cut defaults for shots on this camera that have not set their own. Null on a shot stays off.
  cuts: z.object({
    transitionIn: z.enum(MUSIC_VIDEO_TRANSITIONS).nullable().optional(),
    transitionOut: z.enum(MUSIC_VIDEO_TRANSITIONS).nullable().optional(),
    glitches: z.array(musicVideoShotGlitchSchema).max(MUSIC_VIDEO_SHOT_GLITCH_LIMIT).nullable().optional(),
  }).strict().nullable().optional(),
  // Camcorder date and record mark, drawn on the picture. Absent is off.
  osd: z.object({
    record: z.boolean().optional(),
    date: z.string().trim().max(24).optional(),
  }).strict().nullable().optional(),
  // Leave this camera's shots out of color matching (lib/shotColorMatch.js).
  doNotMatch: z.boolean().optional(),
}).strict();
// A path through several of the video's places, in travel order (lib/musicVideo/musicVideoRouteMaps.js).
const musicVideoRouteMapSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(ROUTE_MAP_NAME_MAX),
  heading: z.enum(ROUTE_MAP_HEADINGS).nullable().optional(),
  // How they travel and what stays the same along the way, e.g. "riding bikes, the low sun ahead and to the left".
  travel: z.string().trim().max(ROUTE_MAP_TRAVEL_MAX).optional(),
  stops: z.array(z.object({
    id: z.string().min(1).max(64),
    subjectId: z.string().min(1).max(64),
    note: z.string().trim().max(ROUTE_MAP_NOTE_MAX).optional(),
    // Side streets and landmarks beside this stretch, on the travellers' left, right or ahead.
    features: z.array(z.object({
      id: z.string().min(1).max(64),
      kind: z.enum(ROUTE_MAP_FEATURE_KINDS),
      label: z.string().trim().max(ROUTE_MAP_FEATURE_LABEL_MAX).optional(),
      side: z.enum(ROUTE_MAP_FEATURE_SIDES),
    }).strict()).max(ROUTE_MAP_FEATURES_MAX).optional(),
    // The place's greybox cameras that look ahead along the route and back the way they came.
    views: z.object({
      forward: z.string().min(1).max(GREYBOX_SHOT_ID_MAX).regex(GREYBOX_SHOT_ID_PATTERN).nullable().optional(),
      back: z.string().min(1).max(GREYBOX_SHOT_ID_MAX).regex(GREYBOX_SHOT_ID_PATTERN).nullable().optional(),
    }).strict().optional(),
  }).strict()).max(ROUTE_MAP_STOPS_MAX),
}).strict();

// Lyric-sheet structure: a section header (`[Chorus]`) or a stage direction
// (`[Spoken, close]`) anchored to the index of the lyric line it precedes.
// `kind` is the normalized section part or delivery (see
// lib/lyricMarkers.js); a free string so a newer peer's
// vocabulary still validates here.
const musicVideoLyricMarkerSchema = z.object({
  type: z.enum(['section', 'direction']),
  label: z.string().trim().min(1).max(120),
  kind: z.string().max(32).optional(),
  line: z.number().int().min(0).max(2000),
}).strict();

const lyricCueList = z.array(musicVideoLyricCueSchema).max(2000);
const lyricMarkerList = z.array(musicVideoLyricMarkerSchema).max(500);
const phraseList = z.array(musicVideoPhraseSchema).max(500);
// A video-history id (the scene clip vocabulary `videoHistoryId` already uses).
const videoHistoryIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'must be a video history id');

// Built-in character style routes (routes/musicVideoCharacterStyles.js).
export const musicVideoCharacterStyleParamsSchema = z.object({ id: z.enum(MUSIC_VIDEO_CHARACTER_STYLE_IDS) }).strict();
// null clears this install's character sheet for the style.
export const musicVideoCharacterStyleReferenceSchema = z.object({ imageId: galleryImageName.nullable() }).strict();

const musicVideoStyleReferencesSchema = z.array(z.object({
  imageId: galleryImageName,
  caption: z.string().trim().max(500).optional(),
}).strict()).max(8);

// `endImage` (#11173): a candidate for the scene's optional style-break end frame.
const MUSIC_VIDEO_TAKE_KINDS = ['image', 'video', 'endImage'];
const MUSIC_VIDEO_TAKE_STATUSES = ['candidate', 'rejected'];
// A take's intended use (#8980). A `motion-reference` take is scaffolding (e.g.
// generated footage to trace a hand-drawn pass over): it is kept as a candidate
// but never fills the scene's timeline slot automatically.
const MUSIC_VIDEO_TAKE_USES = ['final', 'motion-reference'];

// Provider label for provenance — free text so a new external tool needs no
// schema change, but bounded to a slug so it can't smuggle a URL or a secret.
const providerSlug = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'provider must be a short slug');

export const musicVideoTakeInputSchema = z.object({
  kind: z.enum(MUSIC_VIDEO_TAKE_KINDS),
  assetId: z.string().min(1).max(256),
  // `trimmed`: a clip take cut to a frame range of another (the shot card's "Start/End clip here");
  // `handheld`: a clip take re-shot with handheld camera motion (lib/handheldCamera.js).
  source: z.enum(['generated', 'imported', 'trimmed', 'handheld']).optional(),
  provider: providerSlug.optional(),
  originalName: z.string().max(255).optional(),
  sourceImageId: galleryImageName.optional(),
  inputAssets: z.array(z.object({ role: z.enum(['crop', 'mask']), assetId: galleryImageName, revision: z.number().int().min(1).max(1000000) }).strict()).max(4).optional(),
  use: z.enum(MUSIC_VIDEO_TAKE_USES).optional(),
  castInputs: musicVideoCastInputsSchema.optional(),
  // A re-render may replace only the frame that was selected at submission.
  replaceSelection: z.boolean().optional(),
  expectedSelection: galleryImageName.nullable().optional(),
}).strict().superRefine((take, ctx) => {
  const check = take.kind === 'video' ? videoHistoryIdSchema : galleryImageName;
  const parsed = check.safeParse(take.assetId);
  if (!parsed.success) ctx.addIssue({ code: 'custom', path: ['assetId'], message: parsed.error.issues[0].message });
});

/** One still or clip in a video's media pool, as the asset manager names it. */
const musicVideoPoolAssetSchema = z.object({
  kind: z.enum(['image', 'video']),
  assetId: z.string().min(1).max(256),
}).strict().superRefine((input, ctx) => {
  const parsed = (input.kind === 'video' ? videoHistoryIdSchema : galleryImageName).safeParse(input.assetId);
  if (!parsed.success) ctx.addIssue({ code: 'custom', path: ['assetId'], message: parsed.error.issues[0].message });
});

/** `?edit=1` on a project PATCH: the tab asks for the board edit result instead of the project. */
export const musicVideoProjectPatchQuerySchema = z.object({
  edit: z.literal('1').optional(),
}).strict();

/** A search over a video's media pool by the prompts its stills and clips were made from. */
export const musicVideoPoolSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
}).strict();

/** ★ ingredient (good, not placed) or ✕ bad (to clean up); null clears the mark. */
export const musicVideoPoolMarkSchema = z.object({
  items: z.array(musicVideoPoolAssetSchema).min(1).max(500),
  mark: z.enum(['ingredient', 'bad']).nullable(),
  keepInUse: z.boolean().optional(),
  expectedMark: z.enum(['ingredient', 'bad']).nullable().optional(),
}).strict();

/** Undo restores a take only while its slot still holds the operation's result. */
export const musicVideoTakeSelectSchema = z.object({
  expectedSelectedAssetId: z.string().min(1).max(256).nullable().optional(),
}).strict();

/** Delete unused stills and clips from the media library (the asset manager's "Delete bad"). */
export const musicVideoPoolDeleteSchema = z.object({
  items: z.array(musicVideoPoolAssetSchema).min(1).max(500),
}).strict();

/** File another music video's whole pool (an earlier draft) into this video's collection. */
export const musicVideoPoolImportSchema = z.object({
  fromProjectId: z.string().min(1).max(200),
}).strict();

/** Search the whole media library for stills and clips to add to a video's assets. */
export const musicVideoLibrarySearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
}).strict();

/** File stills and clips from the media library into a video's assets. */
export const musicVideoPoolAddSchema = z.object({
  items: z.array(musicVideoPoolAssetSchema).min(1).max(500),
}).strict();

// Put an unused still or clip from the project's pool on a shot; `withAssetId` is its partner (a still's clip, a clip's still).
// `endImage` puts a still on the shot's end frame; only a start still pairs with a clip.
export const musicVideoPoolUseSchema = z.object({
  kind: z.enum(['image', 'video', 'endImage']),
  assetId: z.string().min(1).max(256),
  withAssetId: z.string().min(1).max(256).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.kind === 'endImage' && input.withAssetId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['withAssetId'], message: 'An end frame is placed on its own' });
  }
  const [still, clip] = input.kind === 'video' ? [input.withAssetId, input.assetId] : [input.assetId, input.withAssetId];
  for (const [value, schema, path] of [[still, galleryImageName, input.kind === 'video' ? 'withAssetId' : 'assetId'], [clip, videoHistoryIdSchema, input.kind === 'video' ? 'assetId' : 'withAssetId']]) {
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (!parsed.success) ctx.addIssue({ code: 'custom', path: [path], message: parsed.error.issues[0].message });
  }
});

// Review a take: reject/restore it, leave a note for regeneration, acknowledge a rendering defect or confirm a frame.
export const musicVideoTakeReviewSchema = z.object({
  acknowledgeRenderQuality: z.object({ basis: z.string().min(1), note: z.string().min(1).max(1000) }).strict().optional(),
  // The selected frame still matches the shot's current prompt (#15982).
  confirmFrame: z.literal(true).optional(),
  // The take still matches its characters' current reference images (#16473), at the revision the warning showed.
  acceptCharacterReferences: z.object({ revision: z.string().min(1).max(128) }).strict().optional(),
  status: z.enum(MUSIC_VIDEO_TAKE_STATUSES).optional(),
  note: z.string().max(1000).nullable().optional(),
}).strict().refine((r) => r.status !== undefined || r.note !== undefined || r.acknowledgeRenderQuality !== undefined || r.confirmFrame !== undefined
  || r.acceptCharacterReferences !== undefined, { message: 'status, note, acknowledgement or confirmation is required' });

const colorMatchNumber = (key) => z.number().min(COLOR_MATCH_LIMITS[key][0]).max(COLOR_MATCH_LIMITS[key][1]);

const musicVideoColorMatchCorrectionSchema = z.object({
  black: colorMatchNumber('black'),
  white: colorMatchNumber('white'),
  gamma: colorMatchNumber('gamma'),
  balanceR: colorMatchNumber('balanceR'),
  balanceB: colorMatchNumber('balanceB'),
  saturation: colorMatchNumber('saturation'),
}).strict();

const musicVideoColorMatchReferenceSchema = z.object({
  cameraId: z.string().min(1).max(64),
  location: z.string().min(1).max(200),
  timeOfDay: z.string().min(1).max(100),
  sceneId: z.string().min(1).max(128),
}).strict();

const musicVideoColorMatchSchema = z.object({
  references: z.array(musicVideoColorMatchReferenceSchema).max(400),
}).strict();

export const musicVideoColorMatchMeasureSchema = z.object({
  sceneId: z.string().min(1).max(128).optional(),
}).strict();

export const musicVideoColorMatchTakePatchSchema = z.object({
  enabled: z.boolean().optional(),
  strength: z.number().min(0).max(1).optional(),
  correction: musicVideoColorMatchCorrectionSchema.optional(),
}).strict().refine((body) => body.enabled !== undefined || body.strength !== undefined || body.correction !== undefined, {
  message: 'enabled, strength or correction is required',
});

export const musicVideoColorMatchReferenceUpdateSchema = z.object({
  sceneId: z.string().min(1).max(128),
  clear: z.boolean().optional(),
}).strict();

// Import externally generated assets (e.g. a Midjourney handoff). Each item is
// an asset the client already stored through the existing gallery upload
// routes; `sceneId` is optional when `originalName` carries the scene file tag
// from the exported handoff manifest.
export const musicVideoHandoffImportSchema = z.object({
  provider: providerSlug,
  items: z.array(z.object({
    kind: z.enum(MUSIC_VIDEO_TAKE_KINDS),
    assetId: z.string().min(1).max(256),
    sceneId: z.string().min(1).max(64).optional(),
    originalName: z.string().max(255).optional(),
    use: z.enum(MUSIC_VIDEO_TAKE_USES).optional(),
  }).strict()).min(1).max(200),
}).strict();

// Import lyric cues from pasted text: LRC (`[mm:ss.xx] line`), SRT/WebVTT
// cue blocks, or plain lines (untimed). `auto` sniffs the format.
export const musicVideoLyricsImportSchema = z.object({
  format: z.enum(['auto', 'lrc', 'srt', 'text']).optional(),
  text: z.string().max(200000),
  mode: z.enum(['replace', 'append']).optional(),
}).strict();

// Import the linked track's lyric sheet. `replace` swaps the project's lines
// for the sheet; `if-empty` (the autopilot kickoff) imports only when the
// project has no lines yet, so a re-run never overwrites the director's edits.
export const musicVideoLyricsImportTrackSchema = z.object({
  mode: z.enum(['replace', 'if-empty']).optional(),
}).strict();

// Word alignment (#9074) runs only when the director clicks. `cueId` re-aligns
// that line; omitted, every line is aligned.
export const musicVideoLyricsAlignSchema = z.object({
  cueId: z.string().min(1).max(64).optional(),
  separateVocals: z.boolean().optional(),
  // A revised song: analyze, separate, align and carry the board across in one job.
  retimeSong: z.boolean().optional(),
}).strict();

export const musicVideoLyricsVerifySchema = z.object({}).strict();

// Prepare the song after a track arrives; `refresh` redoes the analysis and lyric
// timing that predate a replaced take (#14793).
export const musicVideoSongPrepareSchema = z.object({
  refresh: z.boolean().optional(),
}).strict();

export const musicVideoCodeGenerateSchema = z.object({
  providerId: z.string().max(120).optional(),
  model: z.string().max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

// A relative folder inside data/ to copy a composition document from.
export const musicVideoDocumentDirectoryImportSchema = z.object({
  directory: z.string().min(1).max(1024).refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes(':')
    && !value.includes('\0') && !value.split('/').some((part) => part === '..' || part === '.' || !part), 'directory must be a relative path inside data'),
}).strict();

export const musicVideoDocumentFileQuerySchema = z.object({
  path: z.string().min(1).max(512),
  draft: z.literal('1').optional(),
}).strict();

export const musicVideoDocumentCandidateSchema = z.object({
  directory: z.string().regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY),
}).strict();
export const musicVideoMixedMediaRegenerateSchema = musicVideoCodeGenerateSchema.extend({
  expectedDraft: z.string().regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY),
}).strict();

export const musicVideoDocumentTemplateSchema = z.object({
  template: z.enum(MUSIC_VIDEO_DOCUMENT_TEMPLATES).optional(),
}).strict();

// Start Research and seed for one shot: the subject to photograph and the agent that searches.
export const musicVideoResearchSeedSchema = z.object({
  subject: z.string().trim().min(2).max(200),
  count: z.number().int().min(1).max(MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT).optional(),
  providerId: z.string().trim().min(1).max(256),
  model: z.string().trim().max(256).optional(),
  effort: z.string().trim().max(32).optional(),
  executionOptions: executionOptionsSchema.optional(),
  preview: z.boolean().optional(),
}).strict();

const treatmentText = (max) => z.string().max(max).optional();

const musicVideoTreatmentMotifSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(120),
  description: treatmentText(1000),
  evolution: treatmentText(1000),
  rationale: treatmentText(1000),
}).strict();

const musicVideoProductionPolicySchema = z.object({
  strategy: z.enum(['legacy', 'code-first']).optional(),
  maxGeneratedVideoPercent: z.number().min(0).max(100).optional(),
}).strict();

const musicVideoActionContractSchema = z.custom((value) => value != null && !shotActionContractProblem(value), { message: 'Invalid shot action contract' });

const musicVideoShotDirectionPatchSchema = z.object({
  sceneId: z.string().min(1).max(64),
  actionContract: musicVideoActionContractSchema.nullable().optional(),
  medium: z.enum(MUSIC_VIDEO_MEDIA).optional(),
  mediumRationale: treatmentText(1000),
  mediumPinned: z.boolean().optional(),
  mode: z.enum(MUSIC_VIDEO_TREATMENT_SHOT_MODES).optional(),
  route: z.enum(MUSIC_VIDEO_SHOT_ROUTES).optional(),
  focalSubject: treatmentText(500),
  framing: treatmentText(500),
  negativeSpace: z.enum(MUSIC_VIDEO_NEGATIVE_SPACE).optional(),
  typographyRole: z.enum(MUSIC_VIDEO_TYPOGRAPHY_ROLES).optional(),
  emphasis: treatmentText(500),
  transitionIn: treatmentText(300),
  transitionOut: treatmentText(300),
  rationale: treatmentText(1000),
  suggestedFramePrompt: treatmentText(2000),
  suggestedPrompt: treatmentText(2000),
}).strict();

// PATCH /:id/treatment. `baseRevision` is the treatment revision the edit was
// made against (0 before a treatment exists); a mismatch is a 409 so a stale tab
// or a peer's older copy can never overwrite a newer edit. `rebase` accepts the
// project's CURRENT visual spec / lyrics / scene set as the treatment's basis
// without recompiling (an audio change still needs a recompile).
export const musicVideoTreatmentUpdateSchema = z.object({
  baseRevision: z.number().int().min(0),
  brief: musicVideoTreatmentBriefSchema.optional(),
  beats: z.array(z.object({
    id: z.string().min(1).max(64),
    objective: treatmentText(1000),
    rationale: treatmentText(1000),
  }).strict()).max(200).optional(),
  motifs: z.array(musicVideoTreatmentMotifSchema).max(12).optional(),
  shotDirections: z.array(musicVideoShotDirectionPatchSchema).max(500).optional(),
  rebase: z.boolean().optional(),
}).strict();

// POST /:id/treatment/compile — an explicit user action. `useAi: false` drafts
// the deterministic treatment only (no provider call at all).
export const musicVideoTreatmentCompileSchema = z.object({
  baseRevision: z.number().int().min(0),
  useAi: z.boolean().optional(),
  providerId: z.string().max(64).optional(),
  model: z.string().max(200).optional(),
}).strict();

// POST /:id/treatment/apply. Manually edited scene prompts are kept unless the
// director explicitly lists the scene in `overwrite` with the fingerprint of
// the prompts they reviewed — a prompt edited after the review stays kept.
// #14241: the planned run to render as one timed request, named by its scenes in timeline order.
export const musicVideoSequenceRenderSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(200)).min(2).max(30),
});

// #16128: one hosted take across 2-6 consecutive board shots. `prompt` replaces
// the composed prompt and is sent as written; `dryRun` returns the plan and price only.
export const musicVideoSequenceTakeSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(200)).min(2).max(6),
  modelId: z.string().trim().min(1).max(200).optional(),
  resolution: z.string().trim().min(1).max(20).optional(),
  prompt: z.string().max(20000).optional(),
  dryRun: z.boolean().optional(),
}).strict();

// `baseRevision` matches compile and patch. `revision` stays accepted so an older
// client still applies. Sending both with different numbers is a conflict.
export const musicVideoTreatmentApplySchema = z.object({
  baseRevision: z.number().int().min(0).optional(),
  revision: z.number().int().min(0).optional(),
  overwrite: z.array(z.object({
    sceneId: z.string().min(1).max(64),
    promptFingerprint: z.string().min(1).max(64),
  }).strict()).max(500).optional(),
  addTextCues: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  const hasBase = value.baseRevision != null;
  const hasLegacy = value.revision != null;
  if (!hasBase && !hasLegacy) {
    ctx.addIssue({ code: 'custom', message: 'baseRevision is required', path: ['baseRevision'] });
  } else if (hasBase && hasLegacy && value.baseRevision !== value.revision) {
    ctx.addIssue({ code: 'custom', message: 'baseRevision and revision disagree', path: ['baseRevision'] });
  }
});

// POST /:id/treatment/sync-shot-sheet — deterministic record edit, no provider call.
export const musicVideoTreatmentSyncShotSheetSchema = z.object({
  baseRevision: z.number().int().min(0),
}).strict();

// Record a proof-checklist review. Evidence names a real artifact of this
// project (a scene's clip or frame take, or the final render).
export const musicVideoTreatmentProofReviewSchema = z.object({
  baseRevision: z.number().int().min(0),
  status: z.enum(MUSIC_VIDEO_PROOF_STATUSES),
  evidence: z.object({
    videoHistoryId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'must be a video history id').optional(),
    imageId: galleryImageName.optional(),
    note: z.string().max(2000).optional(),
  }).strict().optional(),
}).strict();

// ---- Draft excerpt render (#8986) -------------------------------------------
// A director-chosen `[startSec, endSec)` window re-rendered through the same
// composed pipeline as a full render, plus a cut/cue contact sheet and
// timecoded review notes against the excerpt's OWN timeline (0 = its start).
// See services/musicVideo/excerpt.js / excerptRender.js.
const MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS = ['flagged', 'approved'];

// #9280: hook-window suggestions for social cuts.
export const musicVideoSocialCutsQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(10).optional(),
  minSec: z.coerce.number().min(3).max(120).optional(),
  maxSec: z.coerce.number().min(5).max(180).optional(),
}).strict().refine((q) => q.minSec == null || q.maxSec == null || q.maxSec >= q.minSec, { message: 'maxSec must be at least minSec' });

// #9281: publishing kit — per-platform copy edits, the copy draft request, the chosen thumbnail.
const kitText = (max) => z.string().max(max);
export const musicVideoPublishCopyPatchSchema = z.object({
  youtube: z.object({ title: kitText(100), description: kitText(5000), tags: z.array(kitText(60)).max(30) }).partial().strict().optional(),
  shorts: z.object({ title: kitText(100), description: kitText(5000) }).partial().strict().optional(),
  x: z.object({ hook: kitText(280), story: kitText(25000) }).partial().strict().optional(),
  linkedin: z.object({ post: kitText(3000) }).partial().strict().optional(),
  facebook: z.object({ post: kitText(63206) }).partial().strict().optional(),
  tiktok: z.object({ caption: kitText(2200) }).partial().strict().optional(),
  sunoHook: z.object({ caption: kitText(300) }).partial().strict().optional(),
  instagram: z.object({ caption: kitText(2200) }).partial().strict().optional(),
  reddit: z.object({ title: kitText(300), body: kitText(40000) }).partial().strict().optional(),
  stackerNews: z.object({ title: kitText(80), body: kitText(40000) }).partial().strict().optional(),
  substack: z.object({ title: kitText(100), subtitle: kitText(250), body: kitText(40000) }).partial().strict().optional(),
  notes: kitText(8000).optional(),
  // The draft inputs save as they are edited, not only when Draft runs; '' clears a link.
  links: z.object({ youtube: z.union([z.string().url().max(500), z.literal('')]), song: z.union([z.string().url().max(500), z.literal('')]) }).partial().strict().optional(),
  draftOptions: z.object({
    include: z.object({ title: z.boolean(), lyrics: z.boolean(), spend: z.boolean(), chapters: z.boolean(), hashtags: z.boolean() }).partial().strict().optional(),
    length: z.enum(['short', 'full']).optional(),
  }).strict().optional(),
  // The printable flyer's text (client/src/lib/musicVideoFlyer.js); `url` overrides the YouTube link the QR encodes, '' clears it.
  flyer: z.object({
    kicker: kitText(60), title: kitText(120), byline: kitText(120), tagline: kitText(300), scanLine: kitText(60), printedLink: kitText(120), details: kitText(1200),
    url: z.union([z.string().url().max(500), z.literal('')]),
    image: z.enum(['cover', 'youtubeThumbnail', 'thumbnail', 'gallery', 'none']),
    // A gallery image (data/images/<file>) for image: 'gallery'.
    imageFile: z.string().min(1).max(255).regex(/^[^/\\]+$/).refine((f) => f !== '.' && f !== '..'),
    style: z.enum(['80s', 'clean']),
    layout: z.enum(['full', 'half']),
  }).partial().strict().optional(),
  // What the director typed or picked on each platform's Publish row, saved as edited so a
  // reload or another tab shows it again. Replaces that platform's saved answers.
  postOptions: z.lazy(() => musicVideoPublishPostOptionsSchema).optional(),
  // Platforms skipped for this release only (without changing install-wide settings).
  skippedTargets: z.array(z.lazy(() => musicVideoPublishTargetSchema)).max(20).optional(),
}).strict();
export const musicVideoPublishCopyDraftSchema = z.object({
  providerId: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  notes: kitText(8000).optional(),
  links: z.object({ youtube: z.string().url().max(500), song: z.string().url().max(500) }).partial().strict().optional(),
  // What the draft may use beyond the notes and links; omitted keys keep their defaults (title on, the rest off).
  include: z.object({ title: z.boolean(), lyrics: z.boolean(), spend: z.boolean(), chapters: z.boolean(), hashtags: z.boolean() }).partial().strict().optional(),
  length: z.enum(['short', 'full']).optional(),
  // The director agreed to replace posts written or edited by hand since the last draft.
  replaceEdited: z.boolean().optional(),
}).strict();
// Plan the promotion as scheduled steps for the artist (Review Hub › Actions).
export const musicVideoPromotionPlanSchema = z.object({
  providerId: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  goal: z.string().trim().max(1500).optional(),
  audience: z.string().trim().max(1000).optional(),
  days: z.number().int().min(1).max(30).optional(),
}).strict();
export const musicVideoPublishFrameSchema = z.object({ atSec: z.number().finite().min(0) }).strict();


// Release cover art: a source (a kit thumbnail or a gallery image) composed
// with the title and artist tag, or a fresh source image from a backend.
const coverArtSourceSchema = z.object({ kind: z.enum(['thumbnail', 'image']), filename: z.string().min(1).max(300) }).strict();
export const musicVideoCoverArtComposeSchema = z.object({
  source: coverArtSourceSchema.optional(),
  title: z.string().max(60).optional(),
  tag: z.string().max(24).optional(),
  focusX: z.number().min(0).max(1).optional(),
  // false = a finished cover from elsewhere: squared and sized, no title or tag set on it.
  lettering: z.boolean().optional(),
}).strict();
// The YouTube thumbnail: a source composed 16:9 with the title in the cover's lettering.
export const musicVideoYoutubeThumbnailComposeSchema = z.object({
  source: coverArtSourceSchema.optional(),
  title: z.string().max(60).optional(),
  focusX: z.number().min(0).max(1).optional(),
  focusY: z.number().min(0).max(1).optional(),
  lettering: z.boolean().optional(),
}).strict();
// "Paint the title": the image model restyles a frame with the title drawn in. Preview takes no source.
export const musicVideoYoutubeThumbnailPaintPreviewSchema = z.object({
  title: z.string().trim().min(1).max(60),
  notes: z.string().max(1500).optional(),
}).strict();
export const musicVideoYoutubeThumbnailPaintSchema = musicVideoYoutubeThumbnailPaintPreviewSchema.extend({ source: coverArtSourceSchema }).strict();
export const musicVideoCoverArtDesignSchema = z.object({
  direction: z.string().max(1500).optional(),
  providerId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
}).strict();
// #10345: the Lettering controls. A design is every COVER_DESIGN_OPTIONS field
// plus tracking, colors and the rule; any subset is a patch over the song's
// current design. `typeface` is a free string here (a built-in name or a
// `font:<id>` for an uploaded font) and is resolved against the uploaded fonts
// when the design is normalized.
const coverHex = z.string().regex(/^#[0-9a-f]{6}$/i);
const coverDesignFields = Object.fromEntries(Object.entries(COVER_DESIGN_OPTIONS)
  .map(([key, list]) => [key, key === 'typeface' ? z.string().min(1).max(60) : z.enum(list)]));
const musicVideoCoverDesignSchema = z.object({
  ...coverDesignFields,
  tracking: z.number().min(-0.05).max(0.3),
  titleColor: coverHex,
  accentColor: coverHex,
  rule: z.boolean(),
}).partial().strict();
export const musicVideoCoverDesignSaveSchema = z.object({ design: musicVideoCoverDesignSchema }).strict();
export const musicVideoArtistStyleSaveSchema = z.object({
  name: z.string().trim().min(1).max(60),
  design: musicVideoCoverDesignSchema,
}).strict();
export const musicVideoArtistStyleDeleteSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
export const musicVideoCoverArtGenerateSchema = z.object({
  notes: z.string().max(1500).optional(),
  reference: z.object({ kind: z.literal('image'), filename: z.string().min(1).max(300) }).strict().optional(),
}).strict();
export const musicVideoPublishTargetSchema = z.enum(MUSIC_VIDEO_PUBLISH_TARGETS);
const publishUrl = z.string().url().max(500);
// #9287: which platforms the director posts to (opt-in), the account for each,
// and a post's link, reception and notes.
const publishPlatformEntry = z.object({ enabled: z.boolean(), account: z.string().max(100).nullable() }).partial().strict();
// DistroKid also keeps the release answers that repeat on every project ('' or null forgets one).
const rememberedAnswer = z.string().max(100).nullable();
const distrokidPlatformEntry = publishPlatformEntry.extend({
  defaults: z.object(Object.fromEntries(DISTROKID_REMEMBERED_OPTIONS.map((k) => [k, rememberedAnswer]))).partial().strict(),
}).partial().strict();
export const musicVideoPublishPlatformsPatchSchema = z.object(Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS
  .map((t) => [t, (t === 'distrokid' ? distrokidPlatformEntry : publishPlatformEntry).optional()]))).strict();
export const musicVideoPublishPostSchema = z.object({
  url: publishUrl.nullable(),
  // Marks the platform done without a link (a DistroKid upload has none until the stores go live).
  posted: z.literal(true),
  reception: z.enum(['good', 'mixed', 'poor']).nullable(),
  notes: z.string().max(2000).nullable(),
  // The release's other posts this one now links to (cross-links), added to what it linked already.
  links: z.array(musicVideoPublishTargetSchema).max(MUSIC_VIDEO_PUBLISH_TARGETS.length),
}).partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'url, posted, reception, notes or links is required' });
// Whether new drafts list the release's other posts, and which posted platform gets its missing links.
export const musicVideoPublishCrossLinksSchema = z.object({ enabled: z.boolean() }).strict();
export const musicVideoCrossLinkTargetSchema = z.enum(CROSS_LINK_EDIT_TARGETS);
export const musicVideoCrossLinkEditSchema = z.object({}).strict();
export const musicVideoPublishPrepareSchema = z.object({
  subreddit: z.string().max(40),
  kind: z.enum(['self', 'link', 'video']),
  url: publishUrl,
  flairId: z.string().max(100),
  flairText: z.string().max(64),
  firstComment: kitText(10000),
  // LinkedIn, Facebook: put the full video and song links in a first comment (default on).
  linksComment: z.boolean(),
  // Facebook: turn on the post's AI label (default on).
  aiLabel: z.boolean(),
  territory: z.string().max(40),
  // Substack: the publication (name.substack.com or a custom domain); defaults to the account under Where you post.
  publication: z.string().trim().min(1).max(200),
  songUrl: publishUrl,
  pin: z.boolean(),
  // Suno Hook: keep the page's lyric overlay (default off: the cut carries its own).
  showLyrics: z.boolean(),
  prompt: kitText(25000),
  storyImage: z.string().min(1).max(300),
  // A gallery image (data/images/<file>) for the story reply, in place of a video frame.
  storyImageFile: z.string().min(1).max(255).regex(/^[^/\\]+$/).refine((f) => f !== '.' && f !== '..'),
  cutId: z.string().min(1).max(100),
  // Fill a draft for a platform the release was already posted to.
  again: z.boolean(),
  // DistroKid (the song as a Spotify single): who it is by and the store flags.
  artistName: z.string().trim().min(1).max(100),
  songwriterFirst: z.string().trim().min(1).max(100),
  songwriterLast: z.string().trim().min(1).max(100),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  explicit: z.boolean(),
  instrumental: z.boolean(),
  aiLyrics: z.boolean(),
  aiMusic: z.boolean(),
  aiVocals: z.boolean(),
  genre: z.string().trim().min(1).max(60),
  secondaryGenre: z.string().trim().min(1).max(60),
  language: z.string().trim().min(1).max(60),
  songwriterRole: z.enum(['music', 'lyrics', 'both']),
  newArtistProfile: z.boolean(),
  preserveCaps: z.boolean(),
  performerName: z.string().trim().min(1).max(100),
  performerRole: z.string().trim().min(1).max(60),
  producerName: z.string().trim().min(1).max(100),
  previewStartSec: z.number().min(0).max(3600),
}).partial().strict();
// A row's answers are kept while half-typed (a link mid-edit), so values are checked by
// type only here; Fill draft still validates them against the prepare schema.
const postOptionValue = z.union([z.string().max(25000), z.boolean(), z.number().finite()]);
const postOptionsEntry = z.object(Object.fromEntries(Object.keys(musicVideoPublishPrepareSchema.shape)
  .filter((k) => k !== 'again').map((k) => [k, postOptionValue]))).partial().strict();
const musicVideoPublishPostOptionsSchema = z.object(Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS
  .map((t) => [t, postOptionsEntry]))).partial().strict();

export const musicVideoExcerptNoteSchema = z.object({
  atSec: z.number().min(0).max(36000),
  note: z.string().min(1).max(2000),
  verdict: z.enum(MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS).nullable().optional(),
}).strict();

export const musicVideoExcerptNoteUpdateSchema = z.object({
  atSec: z.number().min(0).max(36000).optional(),
  note: z.string().min(1).max(2000).optional(),
  verdict: z.enum(MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS).nullable().optional(),
}).strict().refine((r) => r.atSec !== undefined || r.note !== undefined || r.verdict !== undefined, { message: 'atSec, note or verdict is required' });

// ---- Selective section revision (#8987) -------------------------------------
// Reject the flagged sections of a reviewed draft excerpt and regenerate only
// those. `sceneIds` names the sections explicitly; omitted, every section
// holding a `flagged` note is revised. See services/musicVideo/revision.js.
export const musicVideoDependencyRepairSchema = z.object({ basis: z.string().min(1).max(128) }).strict();

export const musicVideoRevisionStartSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
}).strict();

// ---- Opt-in automatic review/retries (#8988) --------------------------------
// Every limit is required: a run never picks its own budget. `maxAttempts`
// bounds the reviews (provider calls); `maxGenerations` is the spend limit on
// paid scene-generation jobs. See services/musicVideo/autoReview.js.
const musicVideoAutoReviewLimitsSchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  maxGenerations: z.number().int().min(0).max(100),
}).strict();

export const musicVideoAutoReviewStartSchema = z.object({
  startSec: z.number().min(0).max(36000),
  endSec: z.number().min(0).max(36000),
  limits: musicVideoAutoReviewLimitsSchema,
  providerId: z.string().min(1).max(200).nullable().optional(),
  model: z.string().min(1).max(200).nullable().optional(),
}).strict().refine((r) => r.endSec > r.startSec, { message: 'endSec must be greater than startSec' });

// Resume may RAISE either limit (never below what the run already used).
export const musicVideoAutoReviewResumeSchema = z.object({
  limits: musicVideoAutoReviewLimitsSchema.partial().optional(),
}).strict();

// ---- Server-owned production run (#9066) -----------------------------------
// The allowed pool: explicit image/video render backends (and models) the run
// may dispatch to — re-checked for eligibility and capability at every
// dispatch. Every limit but the dollar cap is required; the cap is accepted
// only when every metered route has a known price (services/musicVideo/production.js).
const musicVideoProductionRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), mode: z.enum(IMAGE_GEN_MODES), model: z.string().trim().min(1).max(200).nullable().optional() }).strict(),
  z.object({ kind: z.literal('video'), mode: z.enum(VIDEO_GEN_MODES), model: z.string().trim().min(1).max(200).nullable().optional() }).strict(),
]);

const musicVideoProductionLimitsSchema = z.object({
  maxGenerations: z.number().int().min(1).max(500),
  maxReviewAttempts: z.number().int().min(1).max(10),
  spendCapUsd: z.number().min(0).max(100000).nullable().optional(),
}).strict();

// A code-authoring provider pin: both ids are required, effort is optional.
const musicVideoAuthoringSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
}).strict();

export const musicVideoProductionStartSchema = z.object({
  directive: z.string().max(4000).optional(),
  pool: z.array(musicVideoProductionRouteSchema).max(12),
  limits: musicVideoProductionLimitsSchema,
  authoring: musicVideoAuthoringSchema.optional(),
  providerId: z.string().min(1).max(200).nullable().optional(),
  model: z.string().min(1).max(200).nullable().optional(),
  // 'clips': make every still, then stop as `awaiting-video` before any clip.
  stopBefore: z.enum(['clips']).nullable().optional(),
}).strict();

// Resume may RAISE a limit; `acceptBasis` continues against a changed creative setup;
// `pool` replaces the allowed routes (e.g. swaps a refused video model), validated like Start.
export const musicVideoProductionResumeSchema = z.object({
  limits: musicVideoProductionLimitsSchema.partial().optional(),
  acceptBasis: z.boolean().optional(),
  pool: z.array(musicVideoProductionRouteSchema).max(12).optional(),
  // null goes on to the clips; omitted keeps a running stills-only stop (a finished one goes on).
  stopBefore: z.enum(['clips']).nullable().optional(),
}).strict();

// ---- Fully-autonomous run: one prompt → lyrics → Suno song → video --------------
// Suno's Advanced-form options. `excludeStyles: ''` clears the field Suno keeps
// from its last draft; null (resume only) clears a stored option.
const musicVideoSunoOptionsSchema = z.object({
  excludeStyles: z.string().trim().max(SUNO_LIMITS.excludeStyles).nullable().optional(),
  vocalGender: z.enum(SUNO_VOCAL_GENDERS).nullable().optional(),
  model: z.string().trim().regex(SUNO_MODEL_PATTERN, 'A Suno model version such as v6 or v6-wild').nullable().optional(),
  maxMode: z.boolean().nullable().optional(),
}).strict();

// Local Music Studio options: model (with optional engine) or code (with chosen language).
const musicVideoLocalMusicOptionsSchema = z.object({
  type: z.enum(LOCAL_MUSIC_TYPES).optional(),
  engine: z.string().trim().max(64).nullable().optional(),
  language: z.enum(LOCAL_MUSIC_CODE_LANGUAGES).nullable().optional(),
}).strict();

// A provider/model/effort pin for a Music Video text stage. Effort is the union
// of every accepted level; the runner clamps it to the chosen provider's ladder.
const musicVideoLlmSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
}).strict();

// Per-stage pins (MUSIC_VIDEO_LLM_STAGES): an absent stage keeps its stored pin
// (or, on a start request, uses the direction pin); null clears that stage.
const musicVideoLlmStagesSchema = z.object(Object.fromEntries(
  MUSIC_VIDEO_LLM_STAGES.map((stage) => [stage, musicVideoLlmSchema.nullable().optional()]),
)).strict();

// Production review stages the run may approve by itself (de-duplicated, in
// review order). A non-empty list is approval authority, so the request must
// use an authenticated session (checked by the route); an
// empty list on resume clears the grant.
const musicVideoAutoApproveFields = {
  autoApprove: z.array(z.enum(AUTONOMOUS_AUTO_APPROVE_STAGES)).max(AUTONOMOUS_AUTO_APPROVE_STAGES.length * 4)
    .transform(normalizeAutoApprove).optional(),
  password: z.string().min(1).max(1024).optional(),
};

// The alternate entry point: no track, style or board is picked up front. Tool
// ids are the same catalog the autopilot brief uses; `checkpoints` names the
// stages that park for approval (none = fully unattended).
export const musicVideoAutonomousStartSchema = z.object({
  prompt: z.string().trim().min(1).max(AUTONOMOUS_PROMPT_MAX),
  name: z.string().trim().min(1).max(AUTONOMOUS_NAME_MAX).optional(),
  mediaMode: z.enum(MUSIC_VIDEO_MEDIA_MODES).optional(),
  songSource: z.enum(AUTONOMOUS_SONG_SOURCES).optional(),
  localFallback: z.boolean().optional(),
  localMusic: musicVideoLocalMusicOptionsSchema.nullable().optional(),
  instrumental: z.boolean().optional(),
  guidance: z.string().max(4000).optional(),
  tools: z.array(z.enum(MUSIC_VIDEO_AUTOMATION_TOOL_IDS)).max(MUSIC_VIDEO_AUTOMATION_TOOL_IDS.length).optional(),
  // Per-tool model pin, e.g. { 'image:local': 'flux-dev' }; absent = the install default.
  models: z.partialRecord(z.enum(MUSIC_VIDEO_AUTOMATION_TOOL_IDS), z.string().trim().min(1).max(200)).optional(),
  budgetUsd: z.number().min(0).max(MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD).nullable().optional(),
  limits: z.object({
    maxGenerations: z.number().int().min(AUTONOMOUS_LIMIT_BOUNDS.maxGenerations.min).max(AUTONOMOUS_LIMIT_BOUNDS.maxGenerations.max).optional(),
    maxReviewAttempts: z.number().int().min(AUTONOMOUS_LIMIT_BOUNDS.maxReviewAttempts.min).max(AUTONOMOUS_LIMIT_BOUNDS.maxReviewAttempts.max).optional(),
  }).strict().optional(),
  checkpoints: z.array(z.enum(AUTONOMOUS_CHECKPOINT_IDS)).max(AUTONOMOUS_CHECKPOINT_IDS.length).optional(),
  // Reuse this existing mood board instead of generating one from the prompt.
  moodBoardId: z.string().trim().min(1).max(64).nullable().optional(),
  // Start on this project's song: its audio, analysis and lyric timing are copied,
  // so the run writes no lyrics, makes no song and skips re-analysis.
  fromProjectId: z.string().trim().min(1).max(80).optional(),
  // A built-in character style (musicVideoCharacterStyles.js) cast as protagonist from the start.
  characterStyleId: z.enum(MUSIC_VIDEO_CHARACTER_STYLE_IDS).nullable().optional(),
  // The LLM that writes the brief and lyrics (blank = an eligible TUI provider, else the
  // install's active provider — see services/musicVideo/llmRoute.js).
  providerId: z.string().trim().min(1).max(200).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  // The separate code-authoring provider a code-rendered video needs.
  authoring: musicVideoAuthoringSchema.optional(),
  // A provider/model/effort per LLM stage; an unpinned stage uses the direction LLM above.
  llmStages: musicVideoLlmStagesSchema.nullable().optional(),
  // Review and revise the lyric draft with a second pass (the `lyricsReview` stage
  // pin when set, else the direction LLM). Pinning `llmStages.lyricsReview` implies it.
  lyricsReview: z.boolean().optional(),
  // Transcribe the song to MIDI after analysis so planning reads its parts, hits and chords.
  transcribeMidi: z.boolean().optional(),
  // Orchestrated mode: this provider/model/effort clears every review point a
  // director would (no checkpoints). Approval authority — the route requires a
  // signed-in session for it.
  orchestrator: musicVideoLlmSchema.optional(),
  // Make and review every still, then wait for the director before any clip.
  stopBeforeVideo: z.boolean().optional(),
  origin: z.object({
    kind: z.enum(AUTONOMOUS_ORIGINS).optional(),
    ideaId: z.string().max(80).nullable().optional(),
    ideaTitle: z.string().max(200).nullable().optional(),
  }).strict().optional(),
  suno: musicVideoSunoOptionsSchema.nullable().optional(),
  ...musicVideoAutoApproveFields,
}).strict();

// Resume a parked/failed run, or approve the checkpoint it is waiting on.
export const musicVideoAutonomousResumeSchema = z.object({
  // Change course mid-run: the brief's prompt and guidance, which production plans shots from.
  prompt: z.string().trim().min(1).max(AUTONOMOUS_PROMPT_MAX).optional(),
  guidance: z.string().max(4000).optional(),
  // Replace the stage output the director edited at a checkpoint.
  lyrics: z.string().max(20000).optional(),
  style: z.string().max(AUTONOMOUS_PROMPT_MAX).optional(),
  // Patch the brief's Suno options, key by key (null clears one).
  suno: musicVideoSunoOptionsSchema.optional(),
  // Patch the brief's local Music Studio options.
  localMusic: musicVideoLocalMusicOptionsSchema.nullable().optional(),
  // At the song checkpoint: discard the song and generate a new one.
  retakeSong: z.boolean().optional(),
  // At the song checkpoint before the download: the Suno song to download, one of the run's
  // renders or one the director made or revised in Suno (default: the run's second render).
  sunoSongId: z.string().trim().regex(/^[0-9a-f-]{36}$/i, 'A Suno song id').optional(),
  // Swap a tool's model (null clears the pin) and raise or lower the run's limits. A changed
  // model at the produce stage starts a new production run with the new pool.
  models: z.partialRecord(z.enum(MUSIC_VIDEO_AUTOMATION_TOOL_IDS), z.string().trim().min(1).max(200).nullable()).optional(),
  limits: z.object({
    maxGenerations: z.number().int().min(AUTONOMOUS_LIMIT_BOUNDS.maxGenerations.min).max(AUTONOMOUS_LIMIT_BOUNDS.maxGenerations.max).optional(),
    maxReviewAttempts: z.number().int().min(AUTONOMOUS_LIMIT_BOUNDS.maxReviewAttempts.min).max(AUTONOMOUS_LIMIT_BOUNDS.maxReviewAttempts.max).optional(),
  }).strict().optional(),
  // Add tools to the brief (e.g. a video tool once the stills are approved); the production pool follows.
  addTools: z.array(z.enum(MUSIC_VIDEO_AUTOMATION_TOOL_IDS)).max(MUSIC_VIDEO_AUTOMATION_TOOL_IDS.length).optional(),
  // Replace the brief's auto-approve grant ("auto-approve the rest").
  ...musicVideoAutoApproveFields,
}).strict();

// A generation kickoff that failed before reaching the queue (#9011) — names
// the rejected section whose claim should clear so the next resume can hand
// it out again immediately instead of waiting out GENERATION_CLAIM_LEASE_MS.
export const musicVideoRevisionReleaseSchema = z.object({
  sceneId: z.string().min(1).max(200),
}).strict();

// Optional sound-design bed (#8988): one explicitly chosen music-library track
// mixed UNDER the song. null (or omitted) keeps the song as the sole audio
// master. See services/musicVideo/soundBed.js.
const musicVideoSoundBedSchema = z.object({
  trackId: z.string().min(1).max(64),
  volume: z.number().min(0.05).max(1).optional(),
}).strict();

// Timeline audio layers (services/musicVideo/audioLayers.js). A PATCH names
// the project's existing layers by id; one it leaves out is removed. Only the
// upload route adds a layer, so a patch carries no filename.
const musicVideoAudioLayerPatchSchema = z.object({
  id: z.string().min(1).max(64),
  startSec: z.number().min(0).max(MUSIC_VIDEO_AUDIO_LAYER_MAX_START_SEC).optional(),
  volume: z.number().min(0).max(MUSIC_VIDEO_AUDIO_LAYER_MAX_VOLUME).optional(),
  muted: z.boolean().optional(),
  label: z.string().trim().min(1).max(120).optional(),
}).strict();

// `POST /:id/audio-layers?startSec=…`: where on the song a new layer lands.
export const musicVideoAudioLayerUploadQuerySchema = z.object({
  startSec: z.coerce.number().min(0).max(MUSIC_VIDEO_AUDIO_LAYER_MAX_START_SEC).optional(),
}).strict();

// Automation-first brief: which render tools the agent may use, the director's
// free-text guidance, and a spend cap (null = no cap). A patch merges per
// sub-field; `tools` replaces its list whole. See musicVideoAutomation.js.
const musicVideoAutomationSchema = z.object({
  tools: z.array(z.enum(MUSIC_VIDEO_AUTOMATION_TOOL_IDS)).max(MUSIC_VIDEO_AUTOMATION_TOOL_IDS.length).optional(),
  guidance: z.string().max(MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX).optional(),
  budgetUsd: z.number().min(0).max(MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD).nullable().optional(),
  // Check-in gates: `review` stops the autopilot for the director, `auto`
  // approves and continues. Absent = review.
  checkins: z.object({
    castAndSets: z.enum(MUSIC_VIDEO_CHECKIN_MODES).optional(),
  }).strict().optional(),
  // The direction/planning LLM (#9545): absent keeps the stored pin, null clears
  // it back to Auto (an eligible TUI provider, else the active provider).
  llm: musicVideoLlmSchema.nullable().optional(),
  // Per-stage LLM pins: merged per stage, a stage set to null clears it.
  llmStages: musicVideoLlmStagesSchema.nullable().optional(),
}).strict();

const devArtifactNoteText = z.string().trim().min(1).max(2000);
const devArtifactNoteTarget = z.string().trim().max(120).nullable().optional();

// The text fields of a multipart import (the file itself is the `file` part).
// `artifactId` adds a version to that artifact; otherwise kind + title create
// one. `notes` is a JSON array of strings or `{ text, target }` objects.
export const musicVideoDevArtifactImportSchema = z.object({
  artifactId: z.string().min(1).max(64).optional(),
  kind: z.enum(MUSIC_VIDEO_DEV_ARTIFACT_KINDS).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(MUSIC_VIDEO_DEV_ARTIFACT_STATUSES).optional(),
  notes: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  }, z.array(z.union([
    devArtifactNoteText,
    z.object({ text: devArtifactNoteText, target: devArtifactNoteTarget }).strict(),
  ])).max(50)).optional(),
}).strict().refine((b) => b.artifactId || b.kind, { message: 'kind is required for a new artifact', path: ['kind'] });

export const musicVideoDevArtifactNoteSchema = z.object({
  text: devArtifactNoteText,
  target: devArtifactNoteTarget,
}).strict();

export const musicVideoDevArtifactNoteUpdateSchema = z.object({
  resolved: z.boolean(),
}).strict();

export const musicVideoDevArtifactReviewSchema = z.object({
  status: z.enum(MUSIC_VIDEO_DEV_ARTIFACT_STATUSES),
  note: z.string().trim().max(2000).optional(),
}).strict();

export const musicVideoDevArtifactFileQuerySchema = z.object({
  version: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

// ---- Cast & Sets check-in -----------------------------------------------------
// Start / resume take an optional provider pin for the direction call.
export const musicVideoCastAndSetsStartSchema = z.object({
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

export const musicVideoCastSetsUseImageSchema = z.object({
  key: z.string().min(1).max(80),
  imageId: z.string().min(1).max(500),
}).strict();

export const musicVideoCastSetsImageEditSchema = z.object({
  key: z.string().min(1).max(80),
  imageId: z.string().min(1).max(500),
  revision: z.number().int().min(1),
  instruction: z.string().min(1).max(CAST_SETS_IMAGE_EDIT_MAX).refine((text) => !!text.trim(), 'Write an image edit instruction'),
}).strict();
export const musicVideoCastSetsImageEditDecisionSchema = z.object({
  key: z.string().min(1).max(80), requestId: z.string().uuid(),
}).strict();

// Regenerate with notes. Omitted notes = the open notes on the sheet. A
// `target` names an image (`character`, `expressions`, `looks`, `form:<id>`, `cast:<id>`, `set:<id>`,
// `test:<n>`); any other note revises the direction. `keys` re-renders just
// those images (and what depends on them), leaving open sheet notes open.
export const musicVideoCastAndSetsRegenerateSchema = z.object({
  notes: z.array(z.object({
    text: devArtifactNoteText,
    target: devArtifactNoteTarget,
  }).strict()).min(1).max(50).optional(),
  keys: z.array(z.string().min(1).max(80)).min(1).max(40).optional(),
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

// Plain-text feedback on a Cast & Sets sheet. No target = the whole sheet
// (standing feedback the direction keeps honoring); a target names one image.
export const musicVideoCastAndSetsFeedbackSchema = z.object({
  text: devArtifactNoteText,
  target: devArtifactNoteTarget,
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

export const musicVideoCastAndSetsFeedbackPlanSchema = z.object({
  revision: z.number().int().positive(),
}).strict();

export const musicVideoCastAndSetsFeedbackRenderSchema = musicVideoCastAndSetsFeedbackPlanSchema.extend({
  count: z.number().int().nonnegative(),
}).strict();

export const musicVideoCastAndSetsImageNoteRemovalSchema = z.object({
  key: z.string().min(1).max(80),
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(2000),
}).strict();

// Text-only edits to a catalog check-in's stored direction (no render, no image
// roles). Same present-replaces / absent-keeps rule; caps mirror CAST_SETS_LIMITS.
export const musicVideoCastAndSetsDirectionTextEditSchema = z.object({
  look: castSetsText(500).optional(),
  protagonist: z.object({
    signature: castSetsText(1000).optional(),
    rules: z.array(castSetsText(300)).max(6).optional(),
    expressions: z.array(castSetsText(300)).max(8).optional(),
  }).strict().optional(),
  props: z.array(z.object({
    id: z.string().max(64).optional(),
    name: castSetsText(120).min(1),
    owner: castSetsText(120).optional(),
    description: castSetsText(1000).min(1),
  }).strict()).max(6).optional(),
  overlayConcept: z.object({
    summary: castSetsText(1000).optional(),
    elements: z.array(z.object({
      name: castSetsText(120).min(1),
      description: castSetsText(1000).min(1),
    }).strict()).max(4).optional(),
  }).strict().optional(),
}).strict();

// The cutting room floor outro (lib/musicVideo/musicVideoStatsOutro.js): an optional scene
// after the song tallying the director's choices; null on the project = off.
const musicVideoStatsOutroSchema = z.object({
  enabled: z.boolean().optional(),
  durationSec: z.number().min(STATS_OUTRO_LIMITS.durationMin).max(STATS_OUTRO_LIMITS.durationMax).optional(),
  title: z.string().max(STATS_OUTRO_LIMITS.textMax).optional(),
  subtitle: z.string().max(STATS_OUTRO_LIMITS.textMax).optional(),
  hidden: z.array(z.enum(STATS_OUTRO_LINES.map((line) => line.key))).max(STATS_OUTRO_LINES.length).optional(),
}).strict();

// The film credits ending (lib/musicVideo/musicVideoCreditsOutro.js): song, artist,
// role/name lines and a closing line after the song.
const musicVideoCreditsOutroSchema = z.object({
  enabled: z.boolean().optional(),
  durationSec: z.number().min(CREDITS_OUTRO_LIMITS.durationMin).max(CREDITS_OUTRO_LIMITS.durationMax).optional(),
  layout: z.enum(CREDITS_OUTRO_LAYOUTS).optional(),
  title: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
  artist: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
  lines: z.array(z.object({
    role: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
    name: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
  }).strict()).max(CREDITS_OUTRO_LIMITS.linesMax).optional(),
  footer: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
}).strict();

// The opening title card (lib/musicVideo/musicVideoTitleCard.js): song title, artist, year
// in a corner over the opener. Every field is optional (the normalizer fills
// defaults); null on the project = none.
const musicVideoTitleCardSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().max(TITLE_CARD_LIMITS.textMax).optional(),
  artist: z.string().max(TITLE_CARD_LIMITS.textMax).optional(),
  year: z.string().max(TITLE_CARD_LIMITS.yearMax).optional(),
  extra: z.string().max(TITLE_CARD_LIMITS.textMax).optional(),
  quoteTitle: z.boolean().optional(),
  startSec: z.number().min(0).max(TITLE_CARD_LIMITS.startMax).optional(),
  endSec: z.number().min(0).max(TITLE_CARD_LIMITS.startMax + 60).optional(),
  fadeSec: z.number().min(0).max(TITLE_CARD_LIMITS.fadeMax).optional(),
  position: z.enum(TITLE_CARD_POSITIONS).optional(),
  font: z.enum(TITLE_CARD_FONTS).optional(),
  size: z.number().min(TITLE_CARD_LIMITS.sizeMin).max(TITLE_CARD_LIMITS.sizeMax).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').optional(),
  style: z.enum(TITLE_CARD_STYLES).optional(),
  // '' = the look's own colour.
  titleColor: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i, 'titleColor is #rrggbb')]).optional(),
  accentColor: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/i, 'accentColor is #rrggbb')]).optional(),
  // The optional second showing at the end of the video (null = not timed yet).
  outro: z.boolean().optional(),
  outroStartSec: z.number().min(0).max(TITLE_CARD_LIMITS.outroMax).nullable().optional(),
  outroEndSec: z.number().min(0).max(TITLE_CARD_LIMITS.outroMax + 60).nullable().optional(),
  // `fadeSec` is the fade in; absent, the fade out takes its value.
  fadeOutSec: z.number().min(0).max(TITLE_CARD_LIMITS.fadeMax).optional(),
  // The side the card slides in from as it fades in, how long it takes and how far it travels (% of the frame width).
  slideIn: z.enum(TITLE_CARD_SLIDES).optional(),
  slideSec: z.number().min(TITLE_CARD_LIMITS.slideSecMin).max(TITLE_CARD_LIMITS.slideSecMax).optional(),
  slidePct: z.number().min(TITLE_CARD_LIMITS.slidePctMin).max(TITLE_CARD_LIMITS.slidePctMax).optional(),
  // Drawn over the film look and shot effects; absent, the `mtv` look is steady and `outline` is not.
  steady: z.boolean().optional(),
}).strict();

export const musicVideoProjectCreateSchema = z.object({
  festivalPacket: festivalPacketSchema.nullable().optional(),
  mediaMode: z.enum(MUSIC_VIDEO_MEDIA_MODES).optional(),
  productionPolicy: musicVideoProductionPolicySchema.optional(),
  name: z.string().min(1).max(200),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  // The source audio: either a music-library track or an uploaded file basename
  // under data/music/. At least one is needed before analysis, but a project can
  // be created empty and have the track set later via PATCH.
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  performanceConditioningSource: z.enum(['master', 'vocal-stem', 'clean-singer-stem']).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  visualSpec: musicVideoVisualSpecSchema.optional(),
  styleReferences: musicVideoStyleReferencesSchema.optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
  automation: musicVideoAutomationSchema.nullable().optional(),
  lyricOverlayEnabled: z.boolean().optional(),
  lyricCues: lyricCueList.optional(),
  lyricMarkers: lyricMarkerList.optional(),
  phrases: phraseList.optional(),
  pacing: musicVideoPacingSchema.nullable().optional(),
  composition: musicVideoCompositionSchema.nullable().optional(),
  soundBed: musicVideoSoundBedSchema.nullable().optional(),
  // The finishing film look (lib/filmLook.js); null = none.
  filmLook: filmLookSchema.nullable().optional(),
  templateEffects: musicVideoTemplateEffectsSchema.nullable().optional(),
  // Percent cropped from each edge of the picture before the matte and the look (0–8). Null crops nothing.
  overscan: z.number().min(0).max(8).nullable().optional(),
  // The handmade production medium (lib/musicVideo/musicVideoProductionMedium.js); null = none.
  productionMedium: z.enum(PRODUCTION_MEDIUMS).nullable().optional(),
  // The opening title card (lib/musicVideo/musicVideoTitleCard.js); null = none.
  titleCard: musicVideoTitleCardSchema.nullable().optional(),
  // The cutting room floor outro after the song (lib/musicVideo/musicVideoStatsOutro.js); null = off.
  statsOutro: musicVideoStatsOutroSchema.nullable().optional(),
  // The film credits after the song (lib/musicVideo/musicVideoCreditsOutro.js); null = never set up.
  creditsOutro: musicVideoCreditsOutroSchema.nullable().optional(),
}).strict();

// The vision model a frame take's Check uses; null = the default (Codex when ready, else an API provider).
const musicVideoPlateReviewerSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().max(200).nullable().optional(),
}).strict();

export const musicVideoProjectUpdateSchema = z.object({
  plateReviewer: musicVideoPlateReviewerSchema.nullable().optional(),
  // The descriptions the editor started from, used only for conflict checks.
  catalogDescriptionBases: z.array(z.object({ subjectId: z.string().min(1).max(64), description: z.string().max(16000) }).strict()).max(MUSIC_VIDEO_MAX_SUBJECTS).optional(),
  festivalPacket: festivalPacketSchema.nullable().optional(),
  storySummary: z.string().max(20000).optional(),
  mediaMode: z.enum(MUSIC_VIDEO_MEDIA_MODES).optional(),
  productionPolicy: musicVideoProductionPolicySchema.optional(),
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  status: z.enum(MUSIC_VIDEO_STATUSES).optional(),
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  performanceConditioningSource: z.enum(['master', 'vocal-stem', 'clean-singer-stem']).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  visualSpec: musicVideoVisualSpecSchema.optional(),
  styleReferences: musicVideoStyleReferencesSchema.optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
  automation: musicVideoAutomationSchema.nullable().optional(),
  renderHistoryId: z.string().max(64).nullable().optional(),
  renderError: z.string().max(2000).nullable().optional(),
  lyricOverlayEnabled: z.boolean().optional(),
  lyricCues: lyricCueList.optional(),
  lyricMarkers: lyricMarkerList.optional(),
  phrases: phraseList.optional(),
  pacing: musicVideoPacingSchema.nullable().optional(),
  cameras: z.array(musicVideoCameraSchema).max(SHOT_CAMERA_MAX).optional(),
  // Which shot each color-match group follows (lib/shotColorMatch.js). Null clears every pick.
  colorMatch: musicVideoColorMatchSchema.nullable().optional(),
  routeMaps: z.array(musicVideoRouteMapSchema).max(ROUTE_MAP_MAX).optional(),
  previz: musicVideoPrevizSchema.nullable().optional(),
  composition: musicVideoCompositionSchema.nullable().optional(),
  soundBed: musicVideoSoundBedSchema.nullable().optional(),
  audioLayers: z.array(musicVideoAudioLayerPatchSchema).max(MUSIC_VIDEO_AUDIO_LAYER_LIMIT).optional(),
  // The finishing film look (lib/filmLook.js); null = none.
  filmLook: filmLookSchema.nullable().optional(),
  templateEffects: musicVideoTemplateEffectsSchema.nullable().optional(),
  // Percent cropped from each edge of the picture before the matte and the look (0–8). Null crops nothing.
  overscan: z.number().min(0).max(8).nullable().optional(),
  // The handmade production medium (lib/musicVideo/musicVideoProductionMedium.js); null = none.
  productionMedium: z.enum(PRODUCTION_MEDIUMS).nullable().optional(),
  // The opening title card (lib/musicVideo/musicVideoTitleCard.js); null = none.
  titleCard: musicVideoTitleCardSchema.nullable().optional(),
  // The cutting room floor outro after the song (lib/musicVideo/musicVideoStatsOutro.js); null = off.
  statsOutro: musicVideoStatsOutroSchema.nullable().optional(),
  // The film credits after the song (lib/musicVideo/musicVideoCreditsOutro.js); null = never set up.
  creditsOutro: musicVideoCreditsOutroSchema.nullable().optional(),
  // The Create › Storyboards board this video is planned from; null unlinks.
  storyboardId: z.string().regex(STORYBOARD_ID_PATTERN, 'storyboardId must be a storyboard id').nullable().optional(),
  // When the storyboard was reopened for rework (the step reads not done); null = approved again.
  storyboardReopenedAt: z.string().datetime().nullable().optional(),
  // Keep the shots 1:1 with the linked storyboard's panels after each board edit (lib/storyboardShotSync.js).
  storyboardSync: z.boolean().optional(),
  // Dismiss the note of shots that followed their words after re-alignment (#14820).
  lyricAnchorSync: z.null().optional(),
}).strict();

// Mark a project finished outside PortOS (or clear the marker). The server
// stamps `markedAt`; the note says where it was made (musicVideoFinishedOutside.js).
export const musicVideoCompletionSchema = z.object({
  state: z.enum(['complete', 'in-progress', 'auto']),
}).strict();

export const musicVideoFinishedOutsideSchema = z.object({
  finished: z.boolean(),
  note: z.string().trim().max(500).optional(),
}).strict();

// Fork a project into its next editable version. The server derives lineage and
// version numbers from the source; callers may only override the display name
// and choose whether generated scene media should remain attached. A video
// variant always clears selected media and starts independent creative setup.
export const musicVideoProjectCloneSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  includeGeneratedMedia: z.boolean().optional(),
  variant: z.enum(['revision', 'video-generation']).optional(),
}).strict();
export const musicVideoAlignmentReviewSchema = z.object({
  basis: z.string().min(1).max(128), notes: z.string().trim().max(4000).default(''),
}).strict();
export const musicVideoDocumentShotsSchema = z.object({
  documentDirectory: z.string().min(1).max(500), audioBasis: z.string().min(1).max(128),
  sourceFile: z.string().min(1).max(200),
  shots: musicVideoProductionDraftSchema.shape.storyboard.min(1),
}).strict().superRefine((value, ctx) => {
  const ids = new Set();
  for (const shot of value.shots) {
    if (!shot.id?.trim() || ids.has(shot.id) || shot.sceneId != null
      || !Number.isFinite(shot.startSec) || !(shot.endSec > shot.startSec)) {
      ctx.addIssue({ code: 'custom', message: 'Document shots need unique source IDs, positive timing and no Board scene binding' });
    }
    ids.add(shot.id);
  }
});
// Start a shot from the previous shot's on-screen out-frame; optionally keep
// the current start frame as its end frame.
export const musicVideoContinueShotSchema = z.object({ keepStillAsEnd: z.boolean().optional() }).strict();
export const musicVideoProductionImportSchema = z.object({ source: z.string().min(2).max(250000) }).strict();
export const musicVideoProductionApprovalSchema = z.object({
  stage: z.enum(['art', 'storyboard', 'proof']), basis: z.string().min(1).max(128),
  password: z.string().max(1024).optional(),
  proofReview: z.object({
    method: z.enum(['playback', 'machine']).optional(),
    watchedWithAudio: z.boolean(),
    machineEvidence: z.object({
      visualReview: z.string().trim().min(40).max(8000),
      audioReview: z.string().trim().min(40).max(8000),
      limitations: z.string().trim().min(1).max(4000),
    }).strict().optional(),
    excerptId: z.string().min(1).max(200), filename: z.string().min(1).max(200),
    energyComparison: z.string().trim().max(4000).optional(),
    timecodedNotes: z.string().trim().max(4000).optional(),
  }).strict().optional(),
}).strict();
export const musicVideoProductionProofSchema = z.object({
  kind: z.enum(['proof', 'prototype']).optional(),
  startSec: z.number().min(0), endSec: z.number().positive(),
}).strict();

// Music Video cameo roster (#14821, lib/musicVideo/musicVideoCameos.js).
const cameoImageIdSchema = z.string().max(256).regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'Image must be a gallery basename ending in png/jpg/webp');
const cameoUrlSchema = z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links');
const cameoTextFields = {
  name: z.string().trim().min(1).max(120),
  // What the video shows on screen; empty means the name.
  label: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
};
const musicVideoCameoResearchSchema = z.object({
  status: z.enum(MUSIC_VIDEO_CAMEO_RESEARCH_STATUSES).optional(),
  notes: z.string().trim().max(8000).optional(),
  sources: z.array(z.object({ url: cameoUrlSchema, title: z.string().trim().max(300).optional() }).strict())
    .max(MUSIC_VIDEO_CAMEO_MAX_SOURCES).optional(),
}).strict();
const musicVideoCameoReferenceInputSchema = z.object({
  imageId: cameoImageIdSchema,
  source: z.enum(MUSIC_VIDEO_CAMEO_REFERENCE_SOURCES).optional(),
  // The image file a researched photo came from, and the page it was found on.
  sourceUrl: cameoUrlSchema.optional(),
  pageUrl: cameoUrlSchema.optional(),
}).strict();
export const musicVideoCameoCreateSchema = z.object({
  cameos: z.array(z.object(cameoTextFields).strict()).min(1).max(MUSIC_VIDEO_MAX_CAMEOS),
}).strict();
export const musicVideoCameoUpdateSchema = z.object({
  name: cameoTextFields.name.optional(),
  label: cameoTextFields.label,
  description: cameoTextFields.description,
  research: musicVideoCameoResearchSchema.optional(),
  stillImageId: cameoImageIdSchema.nullable().optional(),
}).strict();
export const musicVideoCameoReferencesAddSchema = z.object({
  references: z.array(musicVideoCameoReferenceInputSchema).min(1).max(MUSIC_VIDEO_CAMEO_MAX_REFERENCES),
}).strict();
export const musicVideoCameoReferenceRemoveSchema = z.object({ imageId: cameoImageIdSchema }).strict();
export const musicVideoCameoVariantCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  // How the variant differs from the chosen still (the instruction a shot's Refine renders it with).
  prompt: z.string().max(2000).optional(),
  imageId: cameoImageIdSchema.nullable().optional(),
}).strict();
export const musicVideoCameoVariantUpdateSchema = musicVideoCameoVariantCreateSchema.partial().strict();
export const musicVideoCameoLinkSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  variantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN).nullable().optional(),
}).strict();
export const musicVideoCameoUnlinkSchema = z.object({ sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500) }).strict();
// Use a linked shot's selected still as the cameo's still, or one variant's.
export const musicVideoCameoStillFromShotSchema = z.object({
  sceneId: z.string().min(1).max(64),
  variantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN).nullable().optional(),
}).strict();

// "Vary wipes" (musicVideoWipes.js): a wipe out of each of `count` shots from `fromSceneId` in song
// order, no style twice in a row, drawn from `styles` (default every wipe).
export const musicVideoVaryWipesSchema = z.object({
  fromSceneId: z.string().min(1).max(200),
  count: z.number().int().min(1).max(1000),
  styles: z.array(z.enum(MUSIC_VIDEO_WIPES)).min(1).max(MUSIC_VIDEO_WIPES.length).optional(),
  lengthSec: z.number().min(MUSIC_VIDEO_WIPE_SEC.min).max(MUSIC_VIDEO_WIPE_SEC.max).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').nullable().optional(),
  seed: z.number().int().min(0).max(2147483646).optional(),
}).strict();

// Reorder the board: the full set of scene ids in their new order.
export const musicVideoSceneReorderSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500),
}).strict();

// Split an over-long shot on lyric/phrase boundaries (#8977). `backend` is
// the lane the director will render with; omitted/null = the project's pin.
export const musicVideoSceneSplitSchema = z.object({
  backend: z.enum(['local', 'grok', 'fal', 'runway', 'gemini', 'higgsfield', 'google']).nullable().optional(),
  // Split the shot in two at this song time instead of by the backend's longest take.
  atSec: z.number().finite().nonnegative().optional(),
}).strict();

// Cut shots on sung words (#14820): one shot per phrase or per word over the chosen lyric lines.
export const musicVideoLyricCutSchema = z.object({
  cueIds: z.array(z.string().min(1).max(64)).min(1).max(2000),
  mode: z.enum(['phrase', 'word']),
}).strict();

export const musicVideoPacingRecutSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

// Move where a shot starts; the shot before it ends there too, so the cut moves and nothing gaps or overlaps.
export const musicVideoSceneStartSchema = z.object({
  startSec: z.number().finite().nonnegative(),
}).strict();

// Move where a shot ends; the next shot starts there too, so it grows or shrinks to meet it.
export const musicVideoSceneEndSchema = z.object({
  endSec: z.number().finite().positive(),
}).strict();

// Shot-card frame and clip renders (#15583). The server loads cast media and
// the shot's references; the client sends the shot and the slot.
const musicVideoFrameImageTargetSchema = z.object({
  mode: z.string().min(1).max(40),
  modelId: z.string().min(1).max(300).optional(),
  cloudModel: z.string().min(1).max(300).optional(),
}).strict();

const musicVideoThenClipSchema = z.object({
  backend: z.string().min(1).max(40).optional(),
  model: z.string().min(1).max(300).optional(),
  songAudio: z.boolean().optional(),
}).strict();

export const musicVideoSceneFrameRenderSchema = z.object({
  slot: z.enum(['start', 'end']).optional(),
  select: z.boolean().optional(),
  imageTarget: musicVideoFrameImageTargetSchema.optional(),
  refine: z.string().max(32000).optional(),
  includeReferences: z.boolean().optional(),
  fromFrame: z.boolean().optional(),
  referenceImageId: galleryImageName.optional(),
  revisionId: z.string().min(1).max(200).optional(),
  thenClip: musicVideoThenClipSchema.optional(),
}).strict();

const musicVideoSceneIdListSchema = z.array(z.string().min(1).max(64)).min(1).max(200);

export const musicVideoSceneFramesRenderSchema = musicVideoSceneFrameRenderSchema.extend({
  sceneIds: musicVideoSceneIdListSchema,
}).strict();

// A clip is either the video body the shot card already builds, or a short
// form (`card` / `target`) the server expands. The video route re-validates
// the assembled body, so provider fields stay on this object.
const musicVideoClipCardSchema = z.object({
  prompt: z.string().max(32000).optional(),
  endFrame: z.boolean().optional(),
  songAudio: z.boolean().optional(),
  wholeLine: z.boolean().optional(),
  ltxReferences: z.boolean().optional(),
  startFrameLayout: z.boolean().optional(),
  frameRoute: z.enum(['reference', 'image']).optional(),
  expectedClipReferenceFiles: z.array(galleryImageName).max(16).optional(),
  expectedClipReferenceLabels: z.array(z.string().max(200)).max(16).optional(),
}).strict();

const musicVideoClipTargetSchema = z.object({
  backend: z.enum(['local', 'grok', 'fal', 'runway', 'gemini', 'higgsfield', 'google']).optional(),
  modelId: z.string().max(300).optional(),
  generationMode: z.string().max(80).optional(),
  higgsfieldModelId: z.string().min(1).max(100).nullable().optional(),
  higgsfieldDuration: z.number().int().min(2).max(30).nullable().optional(),
  higgsfieldResolution: z.enum(['480p', '720p', '1080p']).nullable().optional(),
  googleModelId: z.string().min(1).max(100).nullable().optional(),
  googleDuration: z.number().int().min(1).max(60).nullable().optional(),
  googleResolution: z.enum(['720p', '1080p']).nullable().optional(),
  grokDuration: z.number().positive().max(60).optional(),
  numFrames: z.number().int().positive().max(1000).optional(),
  audioReactiveScale: z.number().min(0).max(4).optional(),
}).strict();

export const musicVideoSceneClipRenderSchema = z.object({
  revisionId: z.string().min(1).max(200).optional(),
  // Draft or final clip (#16136): the shot's model renders at the project's tier
  // resolution unless the request names one; the take records the tier.
  tier: z.enum(MUSIC_VIDEO_RENDER_TIERS).optional(),
  prompt: z.string().max(32000).optional(),
  card: musicVideoClipCardSchema.optional(),
  target: musicVideoClipTargetSchema.optional(),
}).passthrough();

export const musicVideoSceneClipsRenderSchema = musicVideoSceneClipRenderSchema.and(z.object({
  sceneIds: musicVideoSceneIdListSchema,
}));

// #16136: approve (or clear) shots for the final-resolution upgrade.
export const musicVideoApproveFinalSchema = z.object({
  sceneIds: musicVideoSceneIdListSchema,
  approved: z.boolean(),
});

// #16136: upgrade approved shots; no sceneIds = every approved shot. dryRun prices the plan and renders nothing.
export const musicVideoUpgradeSchema = z.object({
  sceneIds: musicVideoSceneIdListSchema.optional(),
  method: z.enum(MUSIC_VIDEO_UPGRADE_METHODS),
  dryRun: z.boolean().optional(),
});

// Autonomous shot planner (#1855): propose a scene per analyzed audio section.
// `seedPrompts` (default true) additionally asks the active/given AI provider
// for a first-pass framePrompt/prompt per scene — best-effort, never fails the
// plan itself (see services/musicVideo/planner.js). `providerId`/`model` mirror
// the optional override shape used elsewhere (mediaPromptRefiner, universe
// builder) so a caller can pin a specific provider instead of the active one.
export const musicVideoPlanRequestSchema = z.object({
  seedPrompts: z.boolean().optional(),
  providerId: z.string().max(64).optional(),
  model: z.string().max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  // Required once the board has scenes (409 PLAN_MODE_REQUIRED otherwise).
  mode: z.enum(['replace', 'append']).optional(),
}).strict();

// Manual-tempo fallback (see services/musicVideo/audioAnalysis.js for why bpm
// can come back null from auto-detection). `bpm` range is loosened from the
// detector's own search window for manual entry (20-300 covers everything
// from a ballad to hardcore/gabber); `offsetSec` is the first downbeat, by ear.
export const musicVideoSectionsEditSchema = z.object({
  sections: z.array(z.object({
    label: z.string().max(120),
    startSec: z.number().min(0),
    endSec: z.number().min(0),
  }).strict()).min(1).max(64),
}).strict();

export const musicVideoManualAnalysisSchema = z.object({
  bpm: z.number().min(20).max(300),
  offsetSec: z.number().min(0).max(600).default(0),
}).strict();

// MuScriptor audio → MIDI transcription request (services/audioMidiTranscription.js).
// `model` picks the MuScriptor size tier; the service clamps unknown values to
// its default, this only types the field.
export const musicVideoTranscribeMidiRequestSchema = z.object({
  model: z.enum(MUSCRIPTOR_MODELS).optional(),
}).strict();

export const musicVideoPerformanceRepairSchema = z.object({
  excerptId: z.string().min(1).max(200),
  sourceAssetId: z.string().min(1).max(200),
  boundarySec: z.number().finite().min(0).max(36000),
}).strict();


// Preserved intervals have equal duration: insertions/deletions are gaps, never stretch.
export const musicVideoAudioTimingPreviewSchema = z.object({
  targetTrackId: z.string().min(1).max(128),
  intervals: z.array(z.object({
    oldStartSec: z.number().finite().min(0).max(36000),
    oldEndSec: z.number().finite().min(0).max(36000),
    newStartSec: z.number().finite().min(0).max(36000),
  }).strict()).min(1).max(200),
}).strict();
export const musicVideoAudioTimingApplySchema = musicVideoAudioTimingPreviewSchema.extend({
  basis: z.string().regex(/^[a-f0-9]{32}$/),
});

export const musicVideoProductionFeedbackSchema = z.object({
  stage: z.enum(['art', 'storyboard', 'proof']), basis: z.string().min(1).max(128),
  target: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(8000),
  decision: z.enum(['comment', 'structure-accepted', 'request-changes']),
}).strict();
// Act on the shots a song revision flagged (songRevision.js resolveSongRevisionScenes).
export const musicVideoSongSceneActionSchema = musicVideoCastAndSetsStartSchema.extend({
  revisionId: z.string().min(1).max(128),
  action: z.enum(['replan', 'remove', 'dismiss']),
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(2000).optional(),
}).strict();
export const musicVideoProductionReviseSchema = musicVideoCastAndSetsStartSchema.extend({
  stage: z.enum(['art', 'storyboard', 'proof']),
}).strict();
// The input label a stale approval names (`concept`, `scene 3 prompt`, …) — the server finds its stored value.
export const musicVideoProductionRevertSchema = z.object({
  stage: z.enum(['art', 'storyboard', 'proof', 'castAndSets']), field: z.string().trim().min(1).max(100),
}).strict();
// Anchor these storyboard shots (every flagged shot when absent) to the lyric lines sung over them.
export const musicVideoLyricAnchorSyncSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(2000).optional(),
}).strict();
export const musicVideoProductionFeedbackResolutionSchema = z.object({
  feedbackId: z.string().min(1).max(128), resolution: z.string().trim().max(8000).default(''), password: z.string().max(1024).optional(),
}).strict();

// GET /api/music-video query (#10169). Passthrough strings, like the other list
// queries: `parsePagination` clamps `limit`/`offset`, and a malformed `cursor`
// (an offset the summary page issued) falls back to the first page.
export const musicVideoProjectListQuerySchema = z.object({
  summary: z.enum(['1', 'true', '0', 'false']).optional(),
  statusFilter: z.enum(['completed', 'in-progress']).optional(),
  // Case-insensitive name substring, applied before paging so a match on a later page is found.
  q: z.string().max(200).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  cursor: z.string().max(64).optional(),
});

export const musicVideoCatalogCompletionSchema = z.object({
  ingredientId: z.preprocess(value => typeof value === 'string' ? [value] : value,
    z.array(z.string().min(1).max(128)).min(1).max(50)),
}).strict();

/**
 * A manual spend adjustment (#16506): `actualUsd` states what the lane really cost (the
 * adjustment is the difference from what the project shows), `usd` adds a signed amount.
 * Exactly one of the two.
 */
export const musicVideoSpendAdjustmentSchema = z.object({
  lane: z.enum(SPEND_ADJUSTMENT_LANES),
  actualUsd: z.number().finite().min(0).max(1_000_000).optional(),
  usd: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().refine((input) => (input.actualUsd == null) !== (input.usd == null), {
  message: 'Give either actualUsd (what the lane really cost) or usd (an amount to add), not both',
});
