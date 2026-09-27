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
  generationMode: z.enum(['image', 'audioReactive']).optional(),
  audioReactiveLora: z.string().max(255).regex(/^[^/\\]+\.safetensors$/i).nullable().optional(),
  audioReactiveScale: z.number().min(0).max(2).optional(),
}).strict();

// Timed lyric cues (#8964). Editable, user-owned text: a cue carries its line
// and optional timing against the project's CURRENT audio source. `startSec`
// null means "not yet timed" (plain pasted lyrics, or timings invalidated by an
// audio-source change — see projectsLogic.applyProjectPatch). The id is
// optional on input; the server mints one so edits stay addressable.
const timedSec = z.number().min(0).max(36000).nullable().optional();
export const musicVideoLyricCueSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  text: z.string().max(500),
  startSec: timedSec,
  endSec: timedSec,
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

const lyricCueList = z.array(musicVideoLyricCueSchema).max(2000);
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
}).strict();

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
  }).strict()).min(1).max(200),
}).strict();

// Import lyric cues from pasted text: LRC (`[mm:ss.xx] line`), SRT/WebVTT
// cue blocks, or plain lines (untimed). `auto` sniffs the format.
export const musicVideoLyricsImportSchema = z.object({
  format: z.enum(['auto', 'lrc', 'srt', 'text']).optional(),
  text: z.string().max(200000),
  mode: z.enum(['replace', 'append']).optional(),
}).strict();

// ---- Composition manifest (#8984, part of #8966) ---------------------------

// A composed render lays timed text cues over the cut footage; `concat` (and a
// project with no manifest) is the plain clip concatenation. Cue text is the
// director's own, rendered as an independent typography layer — never baked
// into generated pixels. See services/musicVideo/composition.js.
export const MUSIC_VIDEO_COMPOSITION_MODES = ['concat', 'composed'];
export const MUSIC_VIDEO_TYPOGRAPHY_TEMPLATES = ['fade', 'rise', 'typewriter', 'pop'];
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
}).strict();

// Replaced whole by a project PATCH (the editor sends the full manifest).
export const musicVideoCompositionSchema = z.object({
  version: z.literal(1).optional(),
  mode: z.enum(MUSIC_VIDEO_COMPOSITION_MODES).optional(),
  textCues: z.array(musicVideoTextCueSchema).max(1000).optional(),
  style: z.object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').optional(),
    font: z.enum(MUSIC_VIDEO_TYPOGRAPHY_FONTS).optional(),
  }).strict().optional(),
  posterSec: timedSec,
}).strict();

export const musicVideoProjectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  // The source audio: either a music-library track or an uploaded file basename
  // under data/music/. At least one is needed before analysis, but a project can
  // be created empty and have the track set later via PATCH.
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  visualSpec: musicVideoVisualSpecSchema.optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
}).strict();

export const musicVideoProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  status: z.enum(MUSIC_VIDEO_STATUSES).optional(),
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  visualSpec: musicVideoVisualSpecSchema.optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
  renderHistoryId: z.string().max(64).nullable().optional(),
  lyricCues: lyricCueList.optional(),
  phrases: phraseList.optional(),
  pacing: musicVideoPacingSchema.nullable().optional(),
  composition: musicVideoCompositionSchema.nullable().optional(),
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
  referenceImageId: z.string().max(256).nullable().optional(),
  videoHistoryId: z.string().max(64).nullable().optional(),
}).strict();

// Reorder the board: the full set of scene ids in their new order.
export const musicVideoSceneReorderSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500),
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
  model: z.enum(['small', 'medium', 'large']).optional(),
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
export const musicVideoAudioAnalysisSchema = z.object({
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
