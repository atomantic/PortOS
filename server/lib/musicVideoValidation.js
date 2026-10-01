/**
 * Music Video production mode — Zod schemas + shared enums (issue #1760, Phase 1).
 *
 * Validates the `musicVideoProject` db-primary record's route inputs: project
 * create/update, the per-scene create/update/reorder operations of the director
 * scene board, and the cached audio-analysis shape (produced by
 * services/musicVideo/audioAnalysis.js, Phase 0). Re-exported flat from
 * validation.js and as a namespace from server/lib/index.js.
 */

import { z } from 'zod';
import { shotActionContractProblem } from './musicVideoActionContract.js';
import { MUSIC_VIDEO_MEDIA } from './musicVideoMediumPlan.js';
import { MUSIC_VIDEO_STILL_MOVES, MUSIC_VIDEO_VISUAL_LAYERS } from './musicVideoLayers.js';
import { MUSIC_VIDEO_SHOT_MODES, SOURCE_AUDIO_LIPSYNC } from './musicVideoShotTiming.js';
import {
  MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD,
  MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX,
  MUSIC_VIDEO_AUTOMATION_TOOL_IDS,
  MUSIC_VIDEO_CHECKIN_MODES,
} from './musicVideoAutomation.js';
import { MUSCRIPTOR_MODELS } from './muscriptorModels.js';
import { IMAGE_GEN_MODES, VIDEO_GEN_MODES } from './generationModes.js';

// A project is authored hands-on (director) or seeded by the AI planner
// (autonomous); both share the same record + scene board.
export const MUSIC_VIDEO_MODES = ['director', 'autonomous'];

// Lifecycle. `draft` → has scenes/analysis → `ready` → `rendering` → `complete`
// (or `failed`). `analyzed` marks "beat map cached but not yet arranged".
export const MUSIC_VIDEO_STATUSES = ['draft', 'analyzed', 'ready', 'rendering', 'complete', 'failed'];

// Optional global visual direction for the whole video.
export const musicVideoConceptSchema = z.object({
  prompt: z.string().max(8000).optional(),
  style: z.string().max(2000).optional(),
  universeId: z.string().max(64).nullable().optional(),
  // Authored snapshots keep the production stable when source canon changes.
  universeStyle: z.string().max(4000).optional(),
  moodBoardStyle: z.string().max(4000).optional(),
  subjects: z.array(z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(['character', 'place', 'object']),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional(),
    role: z.enum(['protagonist', 'band', 'supporting']).optional(),
    canonId: z.string().max(64).optional(),
  }).strict()).max(24).optional(),
}).strict();

// Renderer settings travel with the project so reopening a director board (or
// opening it on a sync peer) cannot silently change provider/model. `modelId`
// is optional because Grok does not consume it; the video-gen route performs
// the authoritative installed-model validation when a local render starts.
export const musicVideoVideoSettingsSchema = z.object({
  // null clears the per-project pin so this install's configured default wins.
  // 'fal' is the metered fal.ai queue REST backend (server/services/videoGen/fal.js,
  // #8968) — image-to-video only here; the audio-reactive lane stays local-only
  // (see generationMode below).
  backend: z.enum(['local', 'grok', 'fal']).nullable().optional(),
  modelId: z.string().max(64).nullable().optional(),
  grokDuration: z.union([z.literal(6), z.literal(10)]).optional(),
  // fal.ai clip length in seconds. Loosely bounded (not a closed enum) for the
  // same reason routes/videoGen.js's falDuration is: fal's own model catalog,
  // not PortOS, owns the set of valid durations per model. null/omitted lets
  // the backend's model default apply.
  falDuration: z.number().min(1).max(60).nullable().optional(),
  // fal.ai cutaway model (lib/falVideoModels.js) and its output resolution.
  // Loosely validated like routes/videoGen.js's falModelId/falResolution: a
  // peer on a newer catalog may pin a model this install does not curate yet,
  // and the resolution alphabet is per model — the provider resolves both (an
  // uncurated id renders on the legacy body with its cost reported unknown).
  // null/omitted = the default model (Hailuo-02 image-to-video) / its default.
  falModelId: z.string().min(1).max(200).nullable().optional(),
  falResolution: z.string().min(1).max(16).nullable().optional(),
  // Output resolution of a performance (lip-sync) take — fal's own alphabet
  // for the lip-sync route. null/omitted = MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION.
  falLipSyncResolution: z.enum(SOURCE_AUDIO_LIPSYNC.fal.resolutions).nullable().optional(),
  // false = lip-sync to the audio alone, without the provider transcribing it
  // first (sung words it mishears turn into the wrong mouth shapes).
  falLipSyncTranscription: z.boolean().nullable().optional(),
  generationMode: z.enum(['image', 'audioReactive']).optional(),
  audioReactiveLora: z.string().max(255).regex(/^[^/\\]+\.safetensors$/i).nullable().optional(),
  audioReactiveScale: z.number().min(0).max(2).optional(),
}).strict();

// Timed lyric cues (#8964). Editable, user-owned text: a cue carries its line
// and optional timing against the project's CURRENT audio source. `startSec`
// null means "not yet timed" (plain pasted lyrics, or timings invalidated by an
// audio-source change — see projectsLogic.applyProjectPatch). The id is
// optional on input; the server mints one so edits stay addressable.
// `words` (#9074) is derived karaoke timing. Absent on older records and on
// peers that have not aligned; cleared with the line times when the audio changes.
const timedSec = z.number().min(0).max(36000).nullable().optional();
const lyricWordSchema = z.object({
  w: z.string().min(1).max(80),
  startSec: z.number().min(0).max(36000),
  endSec: z.number().min(0).max(36000),
  conf: z.enum(['matched', 'interpolated']),
}).strict().refine((word) => word.endSec >= word.startSec, {
  message: 'word endSec must be >= startSec',
});
export const musicVideoLyricCueSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  text: z.string().max(500),
  startSec: timedSec,
  endSec: timedSec,
  words: z.array(lyricWordSchema).max(400).optional(),
  matched: z.number().min(0).max(1).optional(),
}).strict();

// A musical-phrase annotation: a span of the song with an optional visual
// intent (what the picture should do there). Phrase edges are preferred cut
// points for the shot planner and the intent is handed to the prompt seeder.
export const musicVideoPhraseSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().max(120).optional(),
  startSec: timedSec,
  endSec: timedSec,
  intent: z.string().max(2000).optional(),
}).strict();

// Shot pacing for the planner. `maxShotSec` is capped at the renderer's clip
// capacity (one generated clip); `hookSec` bounds the opening shot so the video opens on a cut.
export const musicVideoPacingSchema = z.object({
  minShotSec: z.number().min(0.5).max(60).optional(),
  maxShotSec: z.number().min(1).max(120).optional(),
  hookSec: z.number().min(0.5).max(60).optional(),
}).strict();

// Lyric-sheet structure: a section header (`[Chorus]`) or a stage direction
// (`[Spoken, close]`) anchored to the index of the lyric line it precedes.
// `kind` is the normalized section part or delivery (see
// services/musicVideo/lyricMarkers.js); a free string so a newer peer's
// vocabulary still validates here.
export const musicVideoLyricMarkerSchema = z.object({
  type: z.enum(['section', 'direction']),
  label: z.string().trim().min(1).max(120),
  kind: z.string().max(32).optional(),
  line: z.number().int().min(0).max(2000),
}).strict();

const lyricCueList = z.array(musicVideoLyricCueSchema).max(2000);
const lyricMarkerList = z.array(musicVideoLyricMarkerSchema).max(500);
const phraseList = z.array(musicVideoPhraseSchema).max(500);

// ---- Visual specification + scene takes (#8965) ----------------------------

// A gallery image basename (under data/images). Every generated, uploaded, or
// imported still lands there, so this is the one reference vocabulary the image
// route's `referenceImageFiles` and the peer-sync `image` asset kind share.
const galleryImageName = z.string().min(1).max(256)
  .regex(/^[^/\\]+\.(png|jpg|jpeg|webp)$/i, 'must be a gallery image basename (png/jpg/jpeg/webp)');
// A video-history id (the scene clip vocabulary `videoHistoryId` already uses).
const videoHistoryIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'must be a video history id');

export const MUSIC_VIDEO_REFERENCE_ROLES = ['mood', 'character', 'wardrobe', 'set', 'prop', 'style'];
// How a reference is meant to be used (#8980): `reference` guides the look
// (style/character conditioning), `final-visible` is supplied media meant to
// appear in the finished video as-is, and `motion-reference` is scaffolding
// footage/stills for a hand-drawn or code-rendered pass — never final picture.
export const MUSIC_VIDEO_REFERENCE_USES = ['reference', 'final-visible', 'motion-reference'];
// The image backends accept at most four reference images for most models
// (imageGen/prepareParams.js referenceCap), so a project conditions each
// reference frame on at most this many of its flagged references.
export const MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES = 4;

// One moodboard/reference asset. `condition: true` sends the image to frame
// generation as a real conditioning input (`referenceImageFiles`) rather than
// only describing it in prose.
export const musicVideoVisualReferenceSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  imageId: galleryImageName,
  role: z.enum(MUSIC_VIDEO_REFERENCE_ROLES).optional(),
  label: z.string().max(120).optional(),
  note: z.string().max(1000).optional(),
  condition: z.boolean().optional(),
  use: z.enum(MUSIC_VIDEO_REFERENCE_USES).optional(),
}).strict();

export const musicVideoStyleReferencesSchema = z.array(z.object({
  imageId: galleryImageName,
  caption: z.string().trim().max(500).optional(),
}).strict()).max(8);

// The project's reusable visual specification. A patch merges per sub-field
// (like `concept`), and `references` / `palette` replace their list whole.
export const musicVideoVisualSpecSchema = z.object({
  references: z.array(musicVideoVisualReferenceSchema).max(24).optional(),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i, 'palette colors are #rrggbb')).max(12).optional(),
  typography: z.string().max(1000).optional(),
  cameraRules: z.string().max(2000).optional(),
  // An existing Mood Board this project draws inspiration from (display link).
  moodBoardId: z.string().max(64).nullable().optional(),
}).strict().refine(
  (spec) => (spec.references || []).filter((ref) => ref.condition).length <= MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES,
  { message: `at most ${MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES} references can condition frames`, path: ['references'] },
);

export const MUSIC_VIDEO_TAKE_KINDS = ['image', 'video'];
export const MUSIC_VIDEO_TAKE_STATUSES = ['candidate', 'rejected'];
// A take's intended use (#8980). A `motion-reference` take is scaffolding (e.g.
// generated footage to trace a hand-drawn pass over): it is kept as a candidate
// but never fills the scene's timeline slot automatically.
export const MUSIC_VIDEO_TAKE_USES = ['final', 'motion-reference'];

// Provider label for provenance — free text so a new external tool needs no
// schema change, but bounded to a slug so it can't smuggle a URL or a secret.
const providerSlug = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'provider must be a short slug');

// A candidate asset offered for a scene slot outside the media-job hooks: an
// external-tool import, or a synchronous-lane render the client already holds.
// `assetId` is validated against its kind (gallery basename / history id) and
// then existence-checked by the route before it can reach the record.
export const musicVideoTakeInputSchema = z.object({
  kind: z.enum(MUSIC_VIDEO_TAKE_KINDS),
  assetId: z.string().min(1).max(256),
  source: z.enum(['generated', 'imported']).optional(),
  provider: providerSlug.optional(),
  originalName: z.string().max(255).optional(),
  use: z.enum(MUSIC_VIDEO_TAKE_USES).optional(),
}).strict().superRefine((take, ctx) => {
  const check = take.kind === 'image' ? galleryImageName : videoHistoryIdSchema;
  const parsed = check.safeParse(take.assetId);
  if (!parsed.success) ctx.addIssue({ code: 'custom', path: ['assetId'], message: parsed.error.issues[0].message });
});

// Review a take: reject/restore it and/or leave a note for regeneration.
export const musicVideoTakeReviewSchema = z.object({
  status: z.enum(MUSIC_VIDEO_TAKE_STATUSES).optional(),
  note: z.string().max(1000).nullable().optional(),
}).strict().refine((r) => r.status !== undefined || r.note !== undefined, { message: 'status or note is required' });

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
}).strict();

// ---- Composition manifest (#8984, part of #8966) ---------------------------

// A composed render lays timed text cues over the cut footage; `concat` (and a
// project with no manifest) is the plain clip concatenation. `code` draws the
// whole song as a seekable composition instead of generated footage. Cue text
// is the director's own, rendered as an independent typography layer — never
// baked into generated pixels. See services/musicVideo/composition.js.
// `document` renders a project-owned HTML composition document (its own
// folder under data/music-video/<projectId>/composition/) seeked over the
// song; see services/musicVideo/compositionDocument.js and documentRender.js.
export const MUSIC_VIDEO_COMPOSITION_MODES = ['concat', 'composed', 'code', 'document'];
// #9290: 'scene' cuts once per planned shot; 'intercut' re-cuts on section energy and sung words.
export const MUSIC_VIDEO_CUTTING_MODES = ['scene', 'intercut'];
// Shipped starting points a project can copy into its document folder.
export const MUSIC_VIDEO_DOCUMENT_TEMPLATES = ['layered'];
export const MUSIC_VIDEO_DOCUMENT_SOURCES = ['zip', 'directory', 'template', 'generated'];
// One immutable document version: data/music-video/<projectId>/composition/<versionId>.
export const MUSIC_VIDEO_DOCUMENT_DIRECTORY = /^music-video\/[A-Za-z0-9_-]{1,100}\/composition\/[A-Za-z0-9_-]{1,100}$/;
// One section function. Reject the calls that would make a frame depend on
// the clock, entropy, or the network — the preview and the render both seek.
export const MUSIC_VIDEO_CODE_SOURCE_MAX = 20000;
export const MUSIC_VIDEO_CODE_NONDETERMINISTIC = /\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b|\bgetRandomValues\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimport\s*\(|\brequire\s*\(/;
export const isDeterministicCodeSource = (source) => typeof source === 'string'
  && source.length > 0
  && source.length <= MUSIC_VIDEO_CODE_SOURCE_MAX
  && !MUSIC_VIDEO_CODE_NONDETERMINISTIC.test(source);
// 'build' (#9291) lays a line down word by word on its sung onsets, the newest word in the accent color.
export const MUSIC_VIDEO_TYPOGRAPHY_TEMPLATES = ['fade', 'rise', 'typewriter', 'pop', 'build'];
export const MUSIC_VIDEO_TYPOGRAPHY_PLACEMENTS = ['upper', 'center', 'lower'];
export const MUSIC_VIDEO_TYPOGRAPHY_EMPHASES = ['subtitle', 'hero'];
export const MUSIC_VIDEO_TYPOGRAPHY_FONTS = ['sans', 'serif', 'mono'];

export const musicVideoTextCueSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  text: z.string().max(500),
  startSec: timedSec,
  endSec: timedSec,
  template: z.enum(MUSIC_VIDEO_TYPOGRAPHY_TEMPLATES).optional(),
  placement: z.enum(MUSIC_VIDEO_TYPOGRAPHY_PLACEMENTS).optional(),
  emphasis: z.enum(MUSIC_VIDEO_TYPOGRAPHY_EMPHASES).optional(),
  // Sung word onsets for the 'build' template (#9291).
  words: z.array(z.object({ w: z.string().min(1).max(60), atSec: z.number().min(0).max(36000) }).strict()).max(80).optional(),
}).strict();

const codeSectionSource = z.string().min(1).max(MUSIC_VIDEO_CODE_SOURCE_MAX)
  .refine(isDeterministicCodeSource, 'section source must be deterministic and offline');

export const musicVideoCodeVideoSchema = z.object({
  providerId: z.string().max(120).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  generatedAt: z.string().max(40).nullable().optional(),
  sections: z.array(z.object({
    id: z.string().min(1).max(64),
    source: codeSectionSource,
  }).strict()).max(40),
}).strict();

export const musicVideoCodeGenerateSchema = z.object({
  providerId: z.string().max(120).optional(),
  model: z.string().max(200).optional(),
}).strict();

// Where the project's composition document lives. Set only by the import
// routes; a PATCH that carries it back is ignored (the stored pointer wins).
export const musicVideoCompositionDocumentSchema = z.object({
  directory: z.string().max(300).regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY, 'directory is a composition document version folder'),
  entry: z.literal('index.html').optional(),
  updatedAt: z.string().max(40).nullable().optional(),
  source: z.object({
    kind: z.enum(MUSIC_VIDEO_DOCUMENT_SOURCES),
    name: z.string().max(200).nullable().optional(),
  }).strict().nullable().optional(),
  files: z.number().int().min(0).max(4096).optional(),
  bytes: z.number().int().min(0).optional(),
}).strict();

// The optional HUD block a composition document may draw (the shipped
// layered template reads it from PORTOS_MV.composition.overlay).
export const musicVideoCompositionOverlaySchema = z.object({
  enabled: z.boolean().optional(),
  titleLines: z.array(z.string().max(120)).max(4).optional(),
  meter: z.object({
    label: z.string().max(40).optional(),
    // [songSec, percent] pairs, eased between.
    keyframes: z.array(z.tuple([z.number().min(0).max(36000), z.number().min(0).max(100)])).max(200).optional(),
  }).strict().nullable().optional(),
  ticker: z.array(z.string().max(200)).max(40).optional(),
  timecode: z.boolean().optional(),
  timecodeStartSec: z.number().min(0).max(86400).optional(),
}).strict();

// Replaced whole by a project PATCH (the editor sends the full manifest).
export const musicVideoCompositionSchema = z.object({
  version: z.literal(1).optional(),
  mode: z.enum(MUSIC_VIDEO_COMPOSITION_MODES).optional(),
  cutting: z.enum(MUSIC_VIDEO_CUTTING_MODES).optional(),
  textCues: z.array(musicVideoTextCueSchema).max(1000).optional(),
  style: z.object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').optional(),
    font: z.enum(MUSIC_VIDEO_TYPOGRAPHY_FONTS).optional(),
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/i, 'accentColor is #rrggbb').optional(),
  }).strict().optional(),
  posterSec: timedSec,
  codeVideo: musicVideoCodeVideoSchema.nullable().optional(),
  document: musicVideoCompositionDocumentSchema.nullable().optional(),
  documentDraft: musicVideoCompositionDocumentSchema.nullable().optional(),
  overlay: musicVideoCompositionOverlaySchema.nullable().optional(),
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

export const musicVideoDocumentDraftQuerySchema = z.object({ draft: z.literal('1').optional() }).strict();
export const musicVideoDocumentCandidateSchema = z.object({
  directory: z.string().regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY),
}).strict();
export const musicVideoMixedMediaRegenerateSchema = musicVideoCodeGenerateSchema.extend({
  expectedDraft: z.string().regex(MUSIC_VIDEO_DOCUMENT_DIRECTORY),
}).strict();

export const musicVideoDocumentTemplateSchema = z.object({
  template: z.enum(MUSIC_VIDEO_DOCUMENT_TEMPLATES).optional(),
}).strict();

// Per-scene visual layer (#8985) — footage, a moved still, or a title card;
// see musicVideoLayers.js. Only a composed render honors a non-footage layer.
const sceneLayerFields = {
  visualLayer: z.enum(MUSIC_VIDEO_VISUAL_LAYERS).optional(),
  stillMove: z.enum(MUSIC_VIDEO_STILL_MOVES).optional(),
  cardText: z.string().max(500).nullable().optional(),
  cardColor: z.string().regex(/^#[0-9a-f]{6}$/i, 'card color is #rrggbb').nullable().optional(),
};

// ---- Pre-production treatment (#8980) --------------------------------------

// The treatment sits between the director's concept/visual spec and the timed
// shot planner: a structured brief, a compiled whole-song arc, per-shot
// direction keyed to the board's real scene ids, and a proof checklist. Its own
// routes edit it (never the generic project PATCH) so every write carries the
// revision it was based on. See services/musicVideo/treatment.js.
export const MUSIC_VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '2.39:1'];
export const MUSIC_VIDEO_BEAT_ROLES = ['opening', 'build', 'contrast', 'payoff', 'release'];
// Treatment shot categories (the arc's balance axis). Distinct from the scene's
// render-facing `shotMode` (#8977: cutaway | performance) — Apply maps a
// performance direction onto it when the backend can lip-sync.
export const MUSIC_VIDEO_TREATMENT_SHOT_MODES = ['performance', 'cutaway', 'graphic'];
export const MUSIC_VIDEO_SHOT_ROUTES = ['generated', 'supplied-asset', 'code-2d'];
export const MUSIC_VIDEO_NEGATIVE_SPACE = ['none', 'upper', 'center', 'lower'];
export const MUSIC_VIDEO_TYPOGRAPHY_ROLES = ['none', 'subtitle', 'hero'];
export const MUSIC_VIDEO_PROOF_CHECKS = ['identity-continuity', 'readable-text', 'cut-continuity', 'audio-alignment', 'continuous-motion', 'lip-sync'];
export const MUSIC_VIDEO_PROOF_STATUSES = ['proposed', 'passed', 'failed'];

// A manually supplied reference note/URL. The URL is provenance the director
// typed — PortOS never fetches it, and its text is treated as untrusted data.
const referenceUrl = z.string().max(2000).regex(/^https?:\/\/\S+$/i, 'reference URLs must be http(s)');
export const musicVideoTreatmentReferenceNoteSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  note: z.string().max(1000).optional(),
  url: referenceUrl.nullable().optional(),
}).strict();

// Every brief field is optional; a patch merges per field.
export const musicVideoTreatmentBriefSchema = z.object({
  audience: z.string().max(500).optional(),
  destination: z.string().max(200).optional(),
  aspectRatio: z.enum(MUSIC_VIDEO_ASPECT_RATIOS).nullable().optional(),
  emotion: z.string().max(500).optional(),
  premise: z.string().max(2000).optional(),
  hookObjective: z.string().max(1000).optional(),
  graphicLanguage: z.string().max(1000).optional(),
  mustHave: z.string().max(2000).optional(),
  avoid: z.string().max(2000).optional(),
  referenceNotes: z.array(musicVideoTreatmentReferenceNoteSchema).max(20).optional(),
}).strict();

const treatmentText = (max) => z.string().max(max).optional();

export const musicVideoTreatmentMotifSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(120),
  description: treatmentText(1000),
  evolution: treatmentText(1000),
  rationale: treatmentText(1000),
}).strict();

export const musicVideoProductionPolicySchema = z.object({
  strategy: z.enum(['legacy', 'code-first']).optional(),
  maxGeneratedVideoPercent: z.number().min(0).max(100).optional(),
}).strict();

export const musicVideoActionContractSchema = z.custom((value) => value != null && !shotActionContractProblem(value), { message: 'Invalid shot action contract' });

export const musicVideoShotDirectionPatchSchema = z.object({
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
export const musicVideoTreatmentApplySchema = z.object({
  revision: z.number().int().min(0),
  overwrite: z.array(z.object({
    sceneId: z.string().min(1).max(64),
    promptFingerprint: z.string().min(1).max(64),
  }).strict()).max(500).optional(),
  addTextCues: z.boolean().optional(),
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
export const MUSIC_VIDEO_EXCERPT_NOTE_VERDICTS = ['flagged', 'approved'];

export const musicVideoExcerptRequestSchema = z.object({
  startSec: z.number().min(0).max(36000),
  endSec: z.number().min(0).max(36000),
  // #9280: a social cut renders at another frame and fades its audio edges.
  aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
  fade: z.boolean().optional(),
}).strict().refine((r) => r.endSec > r.startSec, { message: 'endSec must be greater than startSec' });

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
  tiktok: z.object({ caption: kitText(2200) }).partial().strict().optional(),
  instagram: z.object({ caption: kitText(2200) }).partial().strict().optional(),
  reddit: z.object({ title: kitText(300), body: kitText(40000) }).partial().strict().optional(),
  stackerNews: z.object({ title: kitText(80), body: kitText(40000) }).partial().strict().optional(),
  notes: kitText(8000).optional(),
}).strict();
export const musicVideoPublishCopyDraftSchema = z.object({
  providerId: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  notes: kitText(8000).optional(),
  links: z.object({ youtube: z.string().url().max(500), song: z.string().url().max(500) }).partial().strict().optional(),
}).strict();
export const musicVideoPublishThumbnailSchema = z.object({ filename: z.string().min(1).max(300) }).strict();

// #9282: posting to a platform through the PortOS Browser. One strict options
// object covers every target; each target's payload builder reads only its own.
export const MUSIC_VIDEO_PUBLISH_TARGETS = Object.freeze(['youtube', 'shorts', 'tiktok', 'instagram', 'x', 'reddit', 'stackerNews', 'suno']);
export const musicVideoPublishTargetSchema = z.enum(MUSIC_VIDEO_PUBLISH_TARGETS);
const publishUrl = z.string().url().max(500);
// #9287: which platforms the director posts to (opt-in), the account for each,
// and a post's link, reception and notes.
const publishPlatformEntry = z.object({ enabled: z.boolean(), account: z.string().max(100).nullable() }).partial().strict();
export const musicVideoPublishPlatformsPatchSchema = z.object(Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS.map((t) => [t, publishPlatformEntry.optional()]))).strict();
export const musicVideoPublishPostSchema = z.object({
  url: publishUrl.nullable(),
  reception: z.enum(['good', 'mixed', 'poor']).nullable(),
  notes: z.string().max(2000).nullable(),
}).partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'url, reception or notes is required' });
export const musicVideoPublishPrepareSchema = z.object({
  subreddit: z.string().max(40),
  kind: z.enum(['self', 'link', 'video']),
  url: publishUrl,
  flairId: z.string().max(100),
  flairText: z.string().max(64),
  firstComment: kitText(10000),
  territory: z.string().max(40),
  songUrl: publishUrl,
  pin: z.boolean(),
  prompt: kitText(25000),
  storyImage: z.string().min(1).max(300),
}).partial().strict();

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
export const musicVideoRevisionStartSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
}).strict();

// ---- Opt-in automatic review/retries (#8988) --------------------------------
// Every limit is required: a run never picks its own budget. `maxAttempts`
// bounds the reviews (provider calls); `maxGenerations` is the spend limit on
// paid scene-generation jobs. See services/musicVideo/autoReview.js.
export const musicVideoAutoReviewLimitsSchema = z.object({
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

export const musicVideoProductionLimitsSchema = z.object({
  maxGenerations: z.number().int().min(1).max(500),
  maxReviewAttempts: z.number().int().min(1).max(10),
  spendCapUsd: z.number().min(0).max(100000).nullable().optional(),
}).strict();

export const musicVideoProductionStartSchema = z.object({
  directive: z.string().max(4000).optional(),
  pool: z.array(musicVideoProductionRouteSchema).max(12),
  limits: musicVideoProductionLimitsSchema,
  authoring: z.object({ providerId: z.string().min(1).max(200), model: z.string().min(1).max(200) }).strict().optional(),
  providerId: z.string().min(1).max(200).nullable().optional(),
  model: z.string().min(1).max(200).nullable().optional(),
}).strict();

// Resume may RAISE a limit; `acceptBasis` continues against a changed creative setup.
export const musicVideoProductionResumeSchema = z.object({
  limits: musicVideoProductionLimitsSchema.partial().optional(),
  acceptBasis: z.boolean().optional(),
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
export const musicVideoSoundBedSchema = z.object({
  trackId: z.string().min(1).max(64),
  volume: z.number().min(0.05).max(1).optional(),
}).strict();

// Automation-first brief: which render tools the agent may use, the director's
// free-text guidance, and a spend cap (null = no cap). A patch merges per
// sub-field; `tools` replaces its list whole. See musicVideoAutomation.js.
export const musicVideoAutomationSchema = z.object({
  tools: z.array(z.enum(MUSIC_VIDEO_AUTOMATION_TOOL_IDS)).max(MUSIC_VIDEO_AUTOMATION_TOOL_IDS.length).optional(),
  guidance: z.string().max(MUSIC_VIDEO_AUTOMATION_GUIDANCE_MAX).optional(),
  budgetUsd: z.number().min(0).max(MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD).nullable().optional(),
  // Check-in gates: `review` stops the autopilot for the director, `auto`
  // approves and continues. Absent = review.
  checkins: z.object({
    castAndSets: z.enum(MUSIC_VIDEO_CHECKIN_MODES).optional(),
  }).strict().optional(),
}).strict();

// ---- Development artifacts ("ingredients") ----------------------------------
// Reviewable development files attached to a project (a Cast & Sets sheet, an
// animatic, a treatment, a storyboard). Bytes live on disk; see
// services/musicVideo/devArtifacts.js.
export const MUSIC_VIDEO_DEV_ARTIFACT_KINDS = ['cast-sets', 'animatic', 'treatment', 'storyboard', 'other'];
export const MUSIC_VIDEO_DEV_ARTIFACT_STATUSES = ['pending', 'approved', 'changes-requested'];

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
}).strict();

// Regenerate with notes. Omitted notes = the open notes on the sheet. A
// `target` names an image (`character`, `expressions`, `looks`, `set:<id>`,
// `test:<n>`); any other note revises the direction.
export const musicVideoCastAndSetsRegenerateSchema = z.object({
  notes: z.array(z.object({
    text: devArtifactNoteText,
    target: devArtifactNoteTarget,
  }).strict()).min(1).max(50).optional(),
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
}).strict();

export const musicVideoProjectCreateSchema = z.object({
  productionPolicy: musicVideoProductionPolicySchema.optional(),
  name: z.string().min(1).max(200),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  // The source audio: either a music-library track or an uploaded file basename
  // under data/music/. At least one is needed before analysis, but a project can
  // be created empty and have the track set later via PATCH.
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  visualSpec: musicVideoVisualSpecSchema.optional(),
  styleReferences: musicVideoStyleReferencesSchema.optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
  automation: musicVideoAutomationSchema.nullable().optional(),
  lyricCues: lyricCueList.optional(),
  lyricMarkers: lyricMarkerList.optional(),
  phrases: phraseList.optional(),
  pacing: musicVideoPacingSchema.nullable().optional(),
  composition: musicVideoCompositionSchema.nullable().optional(),
  soundBed: musicVideoSoundBedSchema.nullable().optional(),
}).strict();

export const musicVideoProjectUpdateSchema = z.object({
  productionPolicy: musicVideoProductionPolicySchema.optional(),
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  status: z.enum(MUSIC_VIDEO_STATUSES).optional(),
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  visualSpec: musicVideoVisualSpecSchema.optional(),
  styleReferences: musicVideoStyleReferencesSchema.optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
  automation: musicVideoAutomationSchema.nullable().optional(),
  renderHistoryId: z.string().max(64).nullable().optional(),
  lyricCues: lyricCueList.optional(),
  lyricMarkers: lyricMarkerList.optional(),
  phrases: phraseList.optional(),
  pacing: musicVideoPacingSchema.nullable().optional(),
  composition: musicVideoCompositionSchema.nullable().optional(),
  soundBed: musicVideoSoundBedSchema.nullable().optional(),
}).strict();

// Fork a project into its next editable version. The server derives lineage and
// version numbers from the source; callers may only override the display name
// and choose whether generated scene media should remain attached.
export const musicVideoProjectCloneSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  includeGeneratedMedia: z.boolean().optional(),
}).strict();

// A scene on the director board. `startSec`/`endSec` place it on the timeline;
// `prompt` drives the shot's video; `framePrompt`/`referenceImageId` are the
// reference-frame inputs the i2v generation (Phase 1b) will consume.
export const musicVideoSceneCreateSchema = z.object({
  label: z.string().max(120).optional(),
  sectionLabel: z.string().max(120).nullable().optional(),
  prompt: z.string().max(8000).optional(),
  framePrompt: z.string().max(8000).nullable().optional(),
  startSec: z.number().min(0).max(36000).nullable().optional(),
  endSec: z.number().min(0).max(36000).nullable().optional(),
  beatAligned: z.boolean().optional(),
  // #8964: shot-planning fields. `loop` is an explicit, deliberate choice to
  // repeat the source clip across a longer authored span; a scene with no
  // `loop` key is a pre-#8964 record and keeps the legacy loop-to-fill render.
  loop: z.boolean().optional(),
  sectionIndex: z.number().int().min(0).max(10000).nullable().optional(),
  lyricText: z.string().max(2000).nullable().optional(),
  visualIntent: z.string().max(2000).nullable().optional(),
  ...sceneLayerFields,
  // #8977: `performance` = a lip-synced singer that must follow the master
  // recording (only a verified source-audio provider can render it); absent or
  // `cutaway` = the ordinary image-to-video shot. See lib/musicVideoShotTiming.js.
  shotMode: z.enum(MUSIC_VIDEO_SHOT_MODES).optional(),
}).strict().refine(
  (s) => s.startSec == null || s.endSec == null || s.endSec >= s.startSec,
  { message: 'endSec must be >= startSec', path: ['endSec'] },
);

// Times are nullable here so clearing a Start/End input (the UI sends `null`)
// is accepted. The endSec >= startSec invariant can't be checked on the partial
// patch alone (the paired value may live on the existing record), so the merged
// range is validated in projectsLogic.applySceneUpdate instead.
export const musicVideoSceneUpdateSchema = z.object({
  label: z.string().max(120).optional(),
  sectionLabel: z.string().max(120).nullable().optional(),
  prompt: z.string().max(8000).optional(),
  framePrompt: z.string().max(8000).nullable().optional(),
  startSec: z.number().min(0).max(36000).nullable().optional(),
  endSec: z.number().min(0).max(36000).nullable().optional(),
  beatAligned: z.boolean().optional(),
  // #8964: shot-planning fields. `loop` is an explicit, deliberate choice to
  // repeat the source clip across a longer authored span; a scene with no
  // `loop` key is a pre-#8964 record and keeps the legacy loop-to-fill render.
  loop: z.boolean().optional(),
  sectionIndex: z.number().int().min(0).max(10000).nullable().optional(),
  lyricText: z.string().max(2000).nullable().optional(),
  visualIntent: z.string().max(2000).nullable().optional(),
  ...sceneLayerFields,
  // #8977: `performance` = a lip-synced singer that must follow the master
  // recording (only a verified source-audio provider can render it); absent or
  // `cutaway` = the ordinary image-to-video shot. See lib/musicVideoShotTiming.js.
  shotMode: z.enum(MUSIC_VIDEO_SHOT_MODES).optional(),
  referenceImageId: z.string().max(256).nullable().optional(),
  videoHistoryId: z.string().max(64).nullable().optional(),
}).strict();

// Reorder the board: the full set of scene ids in their new order.
export const musicVideoSceneReorderSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500),
}).strict();

// Split an over-long shot on lyric/phrase boundaries (#8977). `backend` is
// the lane the director will render with; omitted/null = the project's pin.
export const musicVideoSceneSplitSchema = z.object({
  backend: z.enum(['local', 'grok', 'fal']).nullable().optional(),
}).strict();

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
}).strict();

// Manual-tempo fallback (see services/musicVideo/audioAnalysis.js for why bpm
// can come back null from auto-detection). `bpm` range is loosened from the
// detector's own search window for manual entry (20-300 covers everything
// from a ballad to hardcore/gabber); `offsetSec` is the first downbeat, by ear.
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

// The persisted MIDI-transcription pointer (a .mid basename under data/music/,
// produced by the MuScriptor sidecar from the project's source audio; it lives
// with the master audio so the peer-sync asset manifest federates it). Cleared
// alongside audioAnalysis when the audio source changes — it was transcribed
// from the OLD track.
export const musicVideoMidiTranscriptionSchema = z.object({
  filename: z.string().min(1).max(256),
  model: z.string().max(32).optional(),
  createdAt: z.string().max(64).optional(),
}).strict();

// The cached beat/tempo/section map (audioAnalysis.js output). Validated when a
// record round-trips so a hand-edited/legacy project can't carry a malformed
// analysis; the analyzer itself produces this shape.
// Per-band loudness envelopes (0..1 on a fixed fps grid) and onset times for
// the seekable song feature track (#9073). `null`/absent means "not analyzed"
// (an analysis cached before the feature track existed); an empty array is
// never used as that sentinel.
const envelopeSeriesSchema = z.array(z.number().min(0).max(1)).max(200000);
const onsetTimesSchema = z.array(z.number().min(0)).max(100000);
export const musicVideoSongFeaturesSchema = z.object({
  envelopes: z.object({
    fps: z.number().positive(),
    rms: envelopeSeriesSchema,
    low: envelopeSeriesSchema,
    mid: envelopeSeriesSchema,
    high: envelopeSeriesSchema,
  }).strict(),
  onsets: z.object({
    low: onsetTimesSchema,
    mid: onsetTimesSchema,
    high: onsetTimesSchema,
  }).strict(),
  // Set when the decode was capped, so the tracks stop before the song does.
  truncatedAtSec: z.number().min(0).nullable().optional(),
}).strict();

export const musicVideoAudioAnalysisSchema = z.object({
  // Shape version: absent = 1 (pre feature track), 2 = carries `features`.
  version: z.number().int().min(1).optional(),
  features: musicVideoSongFeaturesSchema.nullable().optional(),
  bpm: z.number().nullable(),
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
  // Compact normalized loudness envelope for the director timeline. Optional
  // so cached analyses from older installs remain readable.
  waveform: z.array(z.number().min(0).max(1)).max(1024).optional(),
  sections: z.array(z.object({
    label: z.string(),
    startSec: z.number(),
    endSec: z.number(),
    // Normalized 0..1 section loudness used by the energy-weighted auto-arranger
    // (#1915). Additive + optional so older cached analyses still validate.
    energy: z.number().min(0).optional(),
    // Set when the label came from the aligned lyric sheet ("Chorus") rather
    // than the detector ("Section 3"); `analysisLabel` keeps the detector's
    // label so a later pass can restore it. Additive, so older analyses validate.
    labelSource: z.enum(['analysis', 'lyrics']).optional(),
    analysisLabel: z.string().max(120).optional(),
  })),
  durationSec: z.number(),
  // Explain whether the beat grid came from the full track, consensus among
  // later rhythmic windows, or the director's manual tap/entry fallback.
  tempoSource: z.enum(['full', 'windowed', 'manual']).nullable().optional(),
  tempoConfidence: z.number().min(0).max(1).nullable().optional(),
  tempoWindow: z.object({
    startSec: z.number().min(0),
    endSec: z.number().min(0),
  }).nullable().optional(),
}).strict();
