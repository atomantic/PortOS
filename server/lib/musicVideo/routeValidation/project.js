/** Request schemas for Music Video projects, songs, media pools, and treatment. */

import { z } from 'zod';
import { filmLookSchema } from '../../filmLookValidation.js';
import { GREYBOX_SHOT_ID_MAX, GREYBOX_SHOT_ID_PATTERN } from '../../greyboxVocabulary.js';
import { MUSCRIPTOR_MODELS } from '../../muscriptorModels.js';
import { EFFORT_LEVELS } from '../../provider/providerModels.js';
import { STORYBOARD_ID_PATTERN } from '../../storyboardVocabulary.js';
import { shotActionContractProblem } from '../musicVideoActionContract.js';
import {
  MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD,
  MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX,
  MUSIC_VIDEO_AUTOMATION_TOOL_IDS,
  MUSIC_VIDEO_CHECKIN_MODES,
} from '../musicVideoAutomation.js';
import {
  CREDITS_OUTRO_BG_IMAGE_PATTERN,
  CREDITS_OUTRO_COLOR_PATTERN,
  CREDITS_OUTRO_FONT_IDS,
  CREDITS_OUTRO_LAYOUTS,
  CREDITS_OUTRO_LIMITS,
  CREDITS_OUTRO_SOCIAL_PLATFORMS,
  CREDITS_OUTRO_STYLES,
} from '../musicVideoCreditsOutro.js';
import { festivalPacketSchema } from '../musicVideoFestivalPacket.js';
import { MUSIC_VIDEO_CAMERA_FRAME_ASPECTS } from '../musicVideoFilmLook.js';
import {
  MUSIC_VIDEO_AUDIO_LAYER_LIMIT,
  MUSIC_VIDEO_AUDIO_LAYER_MAX_START_SEC,
  MUSIC_VIDEO_AUDIO_LAYER_MAX_VOLUME,
  MUSIC_VIDEO_MAX_SUBJECTS,
} from '../musicVideoLimits.js';
import { MUSIC_VIDEO_MEDIA_MODES } from '../musicVideoMediaPolicy.js';
import { MUSIC_VIDEO_MEDIA } from '../musicVideoMediumPlan.js';
import { PREVIZ_CAMERA_STYLES } from '../musicVideoPrevizLimits.js';
import { PRODUCTION_MEDIUMS } from '../musicVideoProductionMedium.js';
import {
  ROUTE_MAP_FEATURES_MAX,
  ROUTE_MAP_FEATURE_KINDS,
  ROUTE_MAP_FEATURE_LABEL_MAX,
  ROUTE_MAP_FEATURE_SIDES,
  ROUTE_MAP_HEADINGS,
  ROUTE_MAP_MAX,
  ROUTE_MAP_NAME_MAX,
  ROUTE_MAP_NOTE_MAX,
  ROUTE_MAP_STOPS_MAX,
  ROUTE_MAP_TRAVEL_MAX,
} from '../musicVideoRouteMapLimits.js';
import { SHOT_CAMERA_KINDS, SHOT_CAMERA_MAX, SHOT_CAMERA_OUTPUTS } from '../musicVideoShotSheet.js';
import { STATS_OUTRO_LIMITS, STATS_OUTRO_LINES } from '../musicVideoStatsOutro.js';
import {
  TITLE_CARD_FONTS,
  TITLE_CARD_LIMITS,
  TITLE_CARD_POSITIONS,
  TITLE_CARD_SLIDES,
  TITLE_CARD_STYLES,
} from '../musicVideoTitleCard.js';
import { MUSIC_VIDEO_SHOT_GLITCH_LIMIT, MUSIC_VIDEO_TRANSITIONS } from '../musicVideoTransitions.js';
import {
  MUSIC_VIDEO_NEGATIVE_SPACE,
  MUSIC_VIDEO_SHOT_ROUTES,
  MUSIC_VIDEO_STATUSES,
  MUSIC_VIDEO_TREATMENT_SHOT_MODES,
  MUSIC_VIDEO_TYPOGRAPHY_ROLES,
  galleryImageName,
  musicVideoCompositionSchema,
  musicVideoConceptSchema,
  musicVideoLyricCueSchema,
  musicVideoPrevizSchema,
  musicVideoShotGlitchSchema,
  musicVideoTemplateEffectsSchema,
  musicVideoTreatmentBriefSchema,
  musicVideoVideoSettingsSchema,
  musicVideoVisualSpecSchema,
  timedSec,
} from '../musicVideoValidation.js';
import {
  MUSIC_VIDEO_TAKE_KINDS,
  MUSIC_VIDEO_TAKE_USES,
  musicVideoCastAndSetsStartSchema,
  musicVideoLlmSchema,
  musicVideoLlmStagesSchema,
  providerSlug,
  videoHistoryIdSchema,
} from './shared.js';

export { musicVideoTakeInputSchema, musicVideoCodeGenerateSchema } from './shared.js';

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

// Explicit cleanup keeps comparison looks unless the director opts to purge them.
export const musicVideoRenderCleanupSchema = z.object({ unusedLooks: z.boolean().optional() }).strict();

// The rendered-so-far player: `light` asks for the lighter phone copy.
export const musicVideoRenderPreviewSchema = z.object({ light: z.boolean().optional() }).strict();

// Mix the cold open's sound for the animatic; nothing to choose.
export const musicVideoColdOpenAudioSchema = z.object({}).strict();

// Re-read a project's song style from its Suno song link.
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

const musicVideoStyleReferencesSchema = z.array(z.object({
  imageId: galleryImageName,
  caption: z.string().trim().max(500).optional(),
}).strict()).max(8);

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

// POST /:id/treatment/apply. Manually edited scene prompts are kept unless the
// director explicitly lists the scene in `overwrite` with the fingerprint of
// the prompts they reviewed — a prompt edited after the review stays kept.
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
  style: z.enum(CREDITS_OUTRO_STYLES).optional(),
  title: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
  artist: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
  quoteTitle: z.boolean().optional(),
  showPerformer: z.boolean().optional(),
  titleFont: z.enum(CREDITS_OUTRO_FONT_IDS).optional(),
  bodyFont: z.enum(CREDITS_OUTRO_FONT_IDS).optional(),
  textColor: z.string().regex(CREDITS_OUTRO_COLOR_PATTERN).optional(),
  labelColor: z.string().regex(CREDITS_OUTRO_COLOR_PATTERN).optional(),
  backgroundColor: z.string().regex(CREDITS_OUTRO_COLOR_PATTERN).optional(),
  accentColor: z.string().regex(CREDITS_OUTRO_COLOR_PATTERN).optional(),
  backgroundImageId: z.string().regex(CREDITS_OUTRO_BG_IMAGE_PATTERN).nullable().optional(),
  lines: z.array(z.object({
    role: z.string().max(CREDITS_OUTRO_LIMITS.textMax).optional(),
    name: z.string().max(CREDITS_OUTRO_LIMITS.blockTextMax).optional(),
  }).strict()).max(CREDITS_OUTRO_LIMITS.linesMax).optional(),
  socials: z.array(z.object({
    platform: z.enum(CREDITS_OUTRO_SOCIAL_PLATFORMS),
    handle: z.string().max(CREDITS_OUTRO_LIMITS.handleMax),
  }).strict()).max(CREDITS_OUTRO_LIMITS.socialsMax).optional(),
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

// The director's completion mark (musicVideoCompletion.js); `auto` clears it. The server stamps `markedAt`.
export const musicVideoCompletionSchema = z.object({
  state: z.enum(['complete', 'in-progress', 'auto']),
}).strict();

// Mark a project finished outside PortOS (or clear the marker). The server
// stamps `markedAt`; the note says where it was made (musicVideoFinishedOutside.js).
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

export const musicVideoPacingRecutSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

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

// Act on the shots a song revision flagged (songRevision.js resolveSongRevisionScenes).
export const musicVideoSongSceneActionSchema = musicVideoCastAndSetsStartSchema.extend({
  revisionId: z.string().min(1).max(128),
  action: z.enum(['replan', 'remove', 'dismiss']),
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(2000).optional(),
}).strict();

// GET /api/music-video query (#10169). Passthrough strings, like the other list
// queries: `parsePagination` clamps `limit`/`offset`, and a malformed `cursor`
// (an offset the summary page issued) falls back to the first page.
export const musicVideoProjectListQuerySchema = z.object({
  summary: z.enum(['1', 'true', '0', 'false']).optional(),
  statusFilter: z.enum(['completed', 'in-progress']).optional(),
  // Case-insensitive name substring, applied before paging so a match on a later page is found.
  q: z.string().max(200).optional(),
  versionRoot: z.string().min(1).max(128).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  cursor: z.string().max(64).optional(),
});

export const musicVideoCatalogCompletionSchema = z.object({
  ingredientId: z.preprocess(value => typeof value === 'string' ? [value] : value,
    z.array(z.string().min(1).max(128)).min(1).max(50)),
}).strict();
