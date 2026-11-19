/**
 * Music Video production mode — shared Zod schemas, enums and predicates
 * (issue #1760, Phase 1).
 *
 * Holds what services, lib validators and the project/scene record shape
 * import: the `musicVideoProject` input schemas, the cached audio-analysis
 * shape (services/musicVideo/audioAnalysis.js) and shared enums. Request
 * bodies that only a route validates live in musicVideoRouteValidation.js,
 * which imports from here, never the reverse (#16826).
 */

import { CLIP_SOUND_MUSIC_RANGE, CLIP_SOUND_VOLUME_RANGE } from './musicVideoClipSound.js';
import { SHOT_SHEET_CHARACTERS_MAX, SHOT_SHEET_TEXT_FIELDS } from './musicVideoShotSheet.js';
import { MUSIC_VIDEO_GRADE_PRESETS, MUSIC_VIDEO_GRADE_MAX_GRAIN } from './musicVideoGrade.js';
import { filmLookSchema } from '../filmLookValidation.js';
import { TEMPLATE_EFFECT_CONTROLS } from './musicVideoTemplateEffects.js';
import { IMAGE_REFERENCE_REQUEST_LIMIT, MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT, MUSIC_VIDEO_CLIP_REFERENCE_REQUEST_LIMIT } from '../referenceLimits.js';
import { z } from 'zod';

export const musicVideoTemplateEffectsSchema = z.object(Object.fromEntries(TEMPLATE_EFFECT_CONTROLS.map(({ id }) => [id, z.number().min(0).max(1).nullable().optional()]))).strict();
import { TIMELINE_BEAT_KINDS, TIMELINE_BEATS_MAX, TIMELINE_LENGTH_MAX_MIN, TIMELINE_PACES, PREVIZ_CUTS_MAX, PREVIZ_KEYS_MAX, PREVIZ_PAWN_COLOR_IDS, PREVIZ_POSES, PREVIZ_TRACKS_MAX, PREVIZ_VEHICLES_MAX, PREVIZ_VISIBLE_MAX, VEHICLE_SPEED_MAX_METERS_PER_MIN } from './musicVideoPrevizLimits.js';
import { MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX } from './musicVideoSubjectLimits.js';
import { GROK_VIDEO_DURATIONS } from '../grokVideoClip.js';
import { knownFilmStyleIdSchema } from '../filmStyleGrammars.js';
import { NARRATIVE_EVENT_KINDS } from './musicVideoNarrativeEvents.js';
import { CLIP_OFFSET_FRAMES_RANGE, CLIP_SPEED_FPS_RANGE, MUSIC_VIDEO_FRAME_FITS, MUSIC_VIDEO_LYRIC_ROLES, MUSIC_VIDEO_LYRIC_SIZES, MUSIC_VIDEO_STILL_MOVES, MUSIC_VIDEO_TEXT_ZONES, MUSIC_VIDEO_VISUAL_LAYERS } from './musicVideoLayers.js';
import {
  MUSIC_VIDEO_GLITCH_EDGES, MUSIC_VIDEO_GLITCH_REPEAT_LIMIT, MUSIC_VIDEO_GLITCH_REPEAT_SEC, MUSIC_VIDEO_SHOT_GLITCH_LIMIT, MUSIC_VIDEO_TRANSITIONS,
} from './musicVideoTransitions.js';
import { BEAT_TOGGLE_OVERLAP, BEAT_TOGGLE_RATES, MUSIC_VIDEO_CUT_EFFECTS } from './musicVideoCutEffects.js';
import { MUSIC_VIDEO_WIPE_SEC, MUSIC_VIDEO_WIPES } from './musicVideoWipes.js';
import { IMAGE_EFFECT_SEC_RANGE, MUSIC_VIDEO_IMAGE_EFFECTS, PHOTO_LAYOUT_RANGES, PHOTO_SEQUENCE_LIMIT, PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES, PHOTO_SEQUENCE_RATES } from './musicVideoImageEffects.js';
import { PRE_MUSIC_DURATION_RANGE, PRE_MUSIC_EFFECT_IDS, PRE_MUSIC_LAYER_LIMIT, PRE_MUSIC_VOLUME_RANGE } from './musicVideoColdOpen.js';
import { MUSIC_VIDEO_MAX_SUBJECTS, MUSIC_VIDEO_MAX_VISUAL_REFERENCES } from './musicVideoLimits.js';
import { CAMERA_FRAMINGS, CAMERA_MOVEMENT_VALUES, CAMERA_SPEEDS } from '../cameraMovements.js';
import { CAST_ERAS } from '../catalog/catalogMediaLibrary.js';
import { MUSIC_VIDEO_CAMEO_ID_PATTERN, MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN } from './musicVideoCameos.js';
import { CLIP_LENGTH_SEC_RANGE, MUSIC_VIDEO_COVERAGE_MODES, MUSIC_VIDEO_PERFORMANCE_STYLES, MUSIC_VIDEO_SHOT_MODES, SOURCE_AUDIO_LIPSYNC } from './musicVideoShotTiming.js';
import { MUSIC_VIDEO_CHARACTER_STYLE_IDS } from './musicVideoCharacterStyles.js';
import { GREYBOX_SHOT_ID_MAX, GREYBOX_SHOT_ID_PATTERN } from '../greyboxVocabulary.js';

// Lifecycle. `draft` → has scenes/analysis → `ready` → `rendering` → `complete`
// (or `failed`). `analyzed` marks "beat map cached but not yet arranged".
export const MUSIC_VIDEO_STATUSES = ['draft', 'analyzed', 'ready', 'rendering', 'complete', 'failed'];

// Optional global visual direction for the whole video.
export const musicVideoConceptSchema = z.object({
  prompt: z.string().max(8000).optional(),
  // The director's visual style, appended to every frame and shot prompt.
  style: z.string().max(2000).optional(),
  // The song's own style (the Suno style prompt, excluded styles included),
  // snapshotted from the track. Planning LLMs translate it into design; it
  // never reaches an image or video prompt verbatim.
  songStyle: z.string().max(2000).optional(),
  universeId: z.string().max(64).nullable().optional(),
  // Authored snapshots keep the production stable when source canon changes.
  universeStyle: z.string().max(4000).optional(),
  moodBoardStyle: z.string().max(4000).optional(),
  // A built-in character style (musicVideoCharacterStyles.js); the server
  // snapshots its text into `characterStyle` and casts its character.
  characterStyleId: z.enum(MUSIC_VIDEO_CHARACTER_STYLE_IDS).nullable().optional(),
  characterStyle: z.string().max(4000).optional(),
  subjects: z.array(z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(['character', 'place', 'object']),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX).optional(),
    role: z.enum(['protagonist', 'band', 'supporting']).optional(),
    canonId: z.string().max(64).optional(),
    // The catalog record this subject was cast from (Casting / Environments /
    // Objects). The project keeps its own name and description snapshot.
    ingredientId: z.string().max(128).optional(),
    // The linked record's age or look this subject shows (a snapshot of the
    // catalog form; `age` only when the form states a whole number).
    castForm: z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/),
      label: z.string().max(80),
      age: z.number().int().min(0).max(150).optional(),
    }).strict().optional(),
    // Kept in this video only: saved to the catalog only when explicitly asked.
    localOnly: z.boolean().optional(),
    active: z.boolean().optional(),
    // What every frame of this character must show (a watch, a bracelet, a camera
    // on a strap); the frame check adds one requirement per line.
    requiredDetails: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  }).strict()).max(MUSIC_VIDEO_MAX_SUBJECTS).optional(),
}).strict();

// Renderer settings travel with the project so reopening a director board (or
// opening it on a sync peer) cannot silently change provider/model. `modelId`
// is optional because Grok does not consume it; the video-gen route performs
// the authoritative installed-model validation when a local render starts.
// A tier ceiling is a resolution label every catalog ranks ('480p', '768P', '2K', '4k').
const musicVideoTierResolution = z.string().trim().regex(/^(\d{3,4}p|\d(\.\d)?k)$/i, 'Use a resolution such as 480p, 1080p or 4k');

export const musicVideoVideoSettingsSchema = z.object({
  renderPool: z.object({
    mode: z.enum(['local', 'peers', 'both']),
    peers: z.array(z.object({ peerId: z.string().uuid(), modelId: z.string().trim().min(1).max(256) }).strict()).max(12),
  }).strict().refine((v) => v.mode === 'local' || v.peers.length > 0, { message: 'Select at least one peer model' })
    .refine((v) => new Set(v.peers.map((p) => p.peerId)).size === v.peers.length, { message: 'Choose one model per peer' }).optional(),
  // null clears the per-project pin so this install's configured default wins.
  // 'fal' is the metered fal.ai queue REST backend (server/services/videoGen/fal.js,
  // #8968) — image-to-video only here; the audio-reactive lane stays local-only
  // (see generationMode below). 'runway' is Runway's developer API
  // (services/videoGen/runway.js), cutaways only.
  backend: z.enum(['local', 'grok', 'fal', 'runway', 'gemini', 'higgsfield', 'google']).nullable().optional(),
  modelId: z.string().max(64).nullable().optional(),
  grokDuration: z.union(GROK_VIDEO_DURATIONS.map((d) => z.literal(d))).optional(),
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
  // Upgrade model for shots with a style-break end frame (one that takes an
  // end frame, e.g. Kling v3 Pro); null/omitted = those shots use falModelId.
  falEndFrameModelId: z.string().min(1).max(200).nullable().optional(),
  // Output resolution of a performance (lip-sync) take — fal's own alphabet
  // for the lip-sync route. null/omitted = MUSIC_VIDEO_LIPSYNC_DEFAULT_RESOLUTION.
  falLipSyncResolution: z.enum(SOURCE_AUDIO_LIPSYNC.fal.resolutions).nullable().optional(),
  // false = lip-sync to the audio alone, without the provider transcribing it
  // first (sung words it mishears turn into the wrong mouth shapes).
  falLipSyncTranscription: z.boolean().nullable().optional(),
  // Audio-to-video model and resolution for music-driven performance takes
  // (scene.performanceStyle 'music'). Loosely validated like falModelId: a peer
  // on a newer catalog may pin a model this install does not curate, which then
  // falls back to the default (OmniHuman v1.5).
  falMusicModelId: z.string().min(1).max(200).nullable().optional(),
  falMusicResolution: z.string().min(1).max(16).nullable().optional(),
  // Runway cutaway model (lib/runwayVideoModels.js), clip length and output
  // size. Loosely validated like falModelId; null/omitted = the default model,
  // the length covering each shot, that model's default size.
  higgsfieldModelId: z.string().min(1).max(100).nullable().optional(),
  higgsfieldDuration: z.number().int().min(2).max(30).nullable().optional(),
  higgsfieldResolution: z.enum(['480p', '720p', '1080p']).nullable().optional(),
  googleModelId: z.string().min(1).max(100).nullable().optional(),
  googleDuration: z.number().int().min(1).max(60).nullable().optional(),
  googleResolution: z.enum(['720p', '1080p']).nullable().optional(),
  runwayModelId: z.string().min(1).max(64).nullable().optional(),
  runwayDuration: z.number().min(1).max(60).nullable().optional(),
  runwayResolution: z.string().min(1).max(16).nullable().optional(),
  // Draft and final clip renders (#16136, lib/musicVideo/musicVideoRenderTier.js): the
  // highest resolution each tier may use on a hosted model with resolution
  // tiers. null/omitted = the model's lowest tier (draft) / its highest (final).
  draftResolution: musicVideoTierResolution.nullable().optional(),
  finalResolution: musicVideoTierResolution.nullable().optional(),
  generationMode: z.enum(['image', 'audioReactive', 'suppliedAudio', 'ltxReferences']).optional(),
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
export const timedSec = z.number().min(0).max(36000).nullable().optional();
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
  // Who sings the line (duet sheets). Never part of `text`, so alignment ignores it.
  voice: z.string().trim().min(1).max(60).optional(),
  startSec: timedSec,
  endSec: timedSec,
  words: z.array(lyricWordSchema).max(400).optional(),
  matched: z.number().min(0).max(1).optional(),
  suspect: z.boolean().optional(),
  // Indices into `words` that alignment placed where the vocal stem is silent.
  silentWords: z.array(z.number().int().min(0).max(399)).max(400).optional(),
}).strict();

// One glitch inside a shot, or a camera's default glitch (musicVideoTransitions.js).
export const musicVideoShotGlitchSchema = z.object({
  atSec: z.number().min(0).max(3600),
  style: z.enum(MUSIC_VIDEO_TRANSITIONS),
  lengthSec: z.number().positive().max(4).nullable().optional(),
  strength: z.number().min(0).max(1).nullable().optional(),
  count: z.number().int().min(1).max(MUSIC_VIDEO_GLITCH_REPEAT_LIMIT).nullable().optional(),
  everySec: z.number().min(MUSIC_VIDEO_GLITCH_REPEAT_SEC.min).max(MUSIC_VIDEO_GLITCH_REPEAT_SEC.max).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').nullable().optional(),
  edge: z.enum(MUSIC_VIDEO_GLITCH_EDGES).nullable().optional(),
});
// The greybox previz: blocking over the song, played over each place's greybox (lib/musicVideo/musicVideoPreviz.js).
const previzSec = z.number().finite().min(0).max(36000);
const previzCoord = z.number().finite().min(-1000).max(1000);
const previzSubjectId = z.string().min(1).max(64);
export const musicVideoPrevizSchema = z.object({
  // The catalog environment whose world map (lib/worldMap.js) the previz plays in; null/absent = none.
  worldId: z.string().min(1).max(128).nullable().optional(),
  // When the cuts were last built or synced from the shots (the Previz step's "updated" time).
  builtAt: z.string().datetime().nullable().optional(),
  cuts: z.array(z.object({
    id: z.string().min(1).max(64),
    // A linked shot; its live timing wins over the cut's own.
    sceneId: z.string().min(1).max(128).nullable().optional(),
    startSec: previzSec,
    endSec: previzSec,
    placeSubjectId: previzSubjectId.nullable().optional(),
    viewShotId: z.string().min(1).max(GREYBOX_SHOT_ID_MAX).regex(GREYBOX_SHOT_ID_PATTERN).nullable().optional(),
    holderSubjectId: previzSubjectId.nullable().optional(),
    // null = everyone on the set except the holder.
    visibleSubjectIds: z.array(previzSubjectId).max(PREVIZ_VISIBLE_MAX).nullable().optional(),
    aimSubjectId: previzSubjectId.nullable().optional(),
    // What the last "Sync with shots" wrote for the picks it derives from the sheet; a pick that still equals it was not hand-edited, so the next sync may refresh it.
    synced: z.object({
      placeSubjectId: previzSubjectId.nullable().optional(),
      viewShotId: z.string().min(1).max(GREYBOX_SHOT_ID_MAX).regex(GREYBOX_SHOT_ID_PATTERN).nullable().optional(),
      holderSubjectId: previzSubjectId.nullable().optional(),
      visibleSubjectIds: z.array(previzSubjectId).max(PREVIZ_VISIBLE_MAX).nullable().optional(),
    }).strict().optional(),
    // The camera starts on its own aim and swings to the keep-in-frame person during the cut.
    turnToAim: z.boolean().optional(),
    // The holder's camera is held at arm's length facing back at them: they are shown, about 0.6 m off.
    selfie: z.boolean().optional(),
    // Simple in-set action path: start mark -> end mark, or a loop.
    actionPath: z.string().min(1).max(64).nullable().optional(),
    // Where the cut starts on the timeline (story minutes) and an unheld camera's spot on the world map.
    storyMin: z.number().finite().min(0).max(TIMELINE_LENGTH_MAX_MIN).nullable().optional(),
    cameraSpot: z.tuple([z.number().finite().min(-5000).max(5000), z.number().finite().min(-5000).max(5000)]).nullable().optional(),
  }).strict().refine((cut) => cut.endSec > cut.startSec, { message: 'A previz cut must end after it starts' })).max(PREVIZ_CUTS_MAX),
  tracks: z.array(z.object({
    subjectId: previzSubjectId,
    placeSubjectId: previzSubjectId,
    keys: z.array(z.object({
      timeSec: previzSec,
      position: z.tuple([previzCoord, previzCoord, previzCoord]),
      facingDegrees: z.number().finite().min(-36000).max(36000),
      pose: z.enum(PREVIZ_POSES).optional(),
      // The vehicle (a cast object listed in `vehicles`) a figure in the 'ride' pose sits on.
      vehicleSubjectId: previzSubjectId.optional(),
    }).strict()).min(1).max(PREVIZ_KEYS_MAX)
      .refine((keys) => keys.every((key, i) => i === 0 || key.timeSec > keys[i - 1].timeSec), { message: 'Track key times must strictly increase' }),
  }).strict()).max(PREVIZ_TRACKS_MAX)
    .refine((tracks) => new Set(tracks.map((t) => `${t.placeSubjectId}\u0000${t.subjectId}`)).size === tracks.length, { message: 'One track per person per set' }),
  // Picked pawn colors by character or vehicle; anyone missing takes the next unused color in cast order.
  pawnColors: z.record(previzSubjectId, z.object({
    figure: z.enum(PREVIZ_PAWN_COLOR_IDS).optional(),
  }).strict()).optional(),
  // The cast's objects people ride (a bike, car, horse, skateboard...) and how fast each goes.
  vehicles: z.array(z.object({
    subjectId: previzSubjectId,
    speedMetersPerMin: z.number().finite().min(1).max(VEHICLE_SPEED_MAX_METERS_PER_MIN),
  }).strict()).max(PREVIZ_VEHICLES_MAX)
    .refine((vehicles) => new Set(vehicles.map((v) => v.subjectId)).size === vehicles.length, { message: 'A vehicle is listed once' })
    .optional(),
  // The story timeline over the world map (lib/musicVideo/musicVideoPrevizTimeline.js); story minutes from `startClock`.
  timeline: z.object({
    startClock: z.number().int().min(0).max(1439),
    lengthMin: z.number().finite().min(1).max(TIMELINE_LENGTH_MAX_MIN),
    beats: z.array(z.object({
      id: z.string().min(1).max(64),
      kind: z.enum(TIMELINE_BEAT_KINDS),
      subjectIds: z.array(previzSubjectId).max(PREVIZ_VISIBLE_MAX),
      startMin: z.number().finite().min(0).max(TIMELINE_LENGTH_MAX_MIN),
      endMin: z.number().finite().min(0).max(TIMELINE_LENGTH_MAX_MIN),
      setId: z.string().min(1).max(64),
      toSetId: z.string().min(1).max(64).nullable().optional(),
      pace: z.enum(TIMELINE_PACES).nullable().optional(),
      // A travel by vehicle: a cast object listed in `vehicles`; its speed replaces the pace's.
      vehicleSubjectId: previzSubjectId.nullable().optional(),
    }).strict().refine((beat) => beat.endMin > beat.startMin, { message: 'A timeline beat must end after it starts' }))
      .max(TIMELINE_BEATS_MAX)
      .refine((beats) => new Set(beats.map((b) => b.id)).size === beats.length, { message: 'Timeline beat ids must be unique' }),
  }).strict().nullable().optional(),
}).strict();
export const musicVideoShotSheetSchema = z.object({
  cameraId: z.string().min(1).max(64).nullable().optional(),
  holder: z.string().trim().max(120).nullable().optional(),
  characters: z.array(z.string().trim().min(1).max(120)).max(SHOT_SHEET_CHARACTERS_MAX).optional(),
  // Done: the director has finished this shot. Kept under its first name, `checked`, so stored sheets stay valid.
  checked: z.boolean().optional(),
  // The still is built from this sheet; the frame prompt is then its general prompt (musicVideoShotSheet.js).
  promptFromSheet: z.boolean().optional(),
  ...Object.fromEntries(SHOT_SHEET_TEXT_FIELDS.map(([field, max]) => [field, z.string().max(max).optional()])),
}).strict();

// ---- Visual specification + scene takes (#8965) ----------------------------

// A gallery image basename (under data/images). Every generated, uploaded, or
// imported still lands there, so this is the one reference vocabulary the image
// route's `referenceImageFiles` and the peer-sync `image` asset kind share.
export const galleryImageName = z.string().min(1).max(256)
  .regex(/^[^/\\]+\.(png|jpg|jpeg|webp)$/i, 'must be a gallery image basename (png/jpg/jpeg/webp)');

const MUSIC_VIDEO_REFERENCE_ROLES = ['mood', 'character', 'wardrobe', 'set', 'prop', 'style'];
// How a reference is meant to be used (#8980): `reference` guides the look
// (style/character conditioning), `final-visible` is supplied media meant to
// appear in the finished video as-is, and `motion-reference` is scaffolding
// footage/stills for a hand-drawn or code-rendered pass — never final picture.
export const MUSIC_VIDEO_REFERENCE_USES = ['reference', 'final-visible', 'motion-reference'];

// One moodboard/reference asset. `condition: true` sends the image to frame
// generation as a real conditioning input (`referenceImageFiles`) rather than
// only describing it in prose.
const musicVideoVisualReferenceSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  imageId: galleryImageName,
  role: z.enum(MUSIC_VIDEO_REFERENCE_ROLES).optional(),
  label: z.string().max(120).optional(),
  note: z.string().max(1000).optional(),
  condition: z.boolean().optional(),
  use: z.enum(MUSIC_VIDEO_REFERENCE_USES).optional(),
}).strict();

// The project's reusable visual specification. A patch merges per sub-field
// (like `concept`), and `references` / `palette` replace their list whole.
export const musicVideoVisualSpecSchema = z.object({
  references: z.array(musicVideoVisualReferenceSchema).max(MUSIC_VIDEO_MAX_VISUAL_REFERENCES).optional(),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i, 'palette colors are #rrggbb')).max(12).optional(),
  typography: z.string().max(1000).optional(),
  cameraRules: z.string().max(2000).optional(),
  // An existing Mood Board this project draws inspiration from (display link).
  moodBoardId: z.string().max(64).nullable().optional(),
}).strict();

// A candidate asset offered for a scene slot outside the media-job hooks: an
// external-tool import, or a synchronous-lane render the client already holds.
// `assetId` is validated against its kind (gallery basename / history id) and
// then existence-checked by the route before it can reach the record.
// Guides and Cast & Sets sheets a still was conditioned on (#14154). Optional:
// a take that omits it is an older frame and reads as unknown, not stale.
export const musicVideoCastInputsSchema = z.object({
  ingredientId: z.string().min(1).max(200).nullable(),
  guides: z.array(galleryImageName).max(IMAGE_REFERENCE_REQUEST_LIMIT),
  sheets: z.array(z.object({ id: z.string().min(1).max(80), imageId: galleryImageName }).strict()).max(IMAGE_REFERENCE_REQUEST_LIMIT),
  // Every character reference sent (#16473); absent on a record from before it.
  characters: z.array(z.object({ id: z.string().min(1).max(128), imageId: galleryImageName }).strict()).max(64).optional(),
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
// `blender` assembles shots rendered by an operator-authored Blender film
// (services/musicVideo/blender/); its settings live in the install-local `blender` field.
export const MUSIC_VIDEO_COMPOSITION_MODES = ['concat', 'composed', 'code', 'document', 'eidoverse', 'blender'];
// #9290: 'scene' cuts once per planned shot; 'intercut' re-cuts on section energy and sung words.
export const MUSIC_VIDEO_CUTTING_MODES = ['scene', 'intercut'];
// Shipped starting points a project can copy into its document folder.
export const MUSIC_VIDEO_DOCUMENT_TEMPLATES = ['layered', 'cel'];
export const MUSIC_VIDEO_DOCUMENT_SOURCES = ['zip', 'directory', 'template', 'generated'];
// One immutable document version: data/music-video/<projectId>/composition/<versionId>.
export const MUSIC_VIDEO_DOCUMENT_DIRECTORY = /^music-video\/[A-Za-z0-9_-]{1,100}\/composition\/[A-Za-z0-9_-]{1,100}$/;
// One section function. Reject the calls that would make a frame depend on
// the clock, entropy, or the network — the preview and the render both seek.
export const MUSIC_VIDEO_CODE_SOURCE_MAX = 20000;
const MUSIC_VIDEO_CODE_NONDETERMINISTIC = /\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b|\bgetRandomValues\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimport\s*\(|\brequire\s*\(/;
export const isDeterministicCodeSource = (source) => typeof source === 'string'
  && source.length > 0
  && source.length <= MUSIC_VIDEO_CODE_SOURCE_MAX
  && !MUSIC_VIDEO_CODE_NONDETERMINISTIC.test(source);
// 'build' (#9291) lays a line down word by word on its sung onsets, the newest word in the accent color.
export const MUSIC_VIDEO_TYPOGRAPHY_TEMPLATES = ['fade', 'rise', 'typewriter', 'pop', 'build'];
export const MUSIC_VIDEO_TYPOGRAPHY_PLACEMENTS = ['upper', 'center', 'lower'];
export const MUSIC_VIDEO_TYPOGRAPHY_EMPHASES = ['subtitle', 'hero'];
export const MUSIC_VIDEO_TYPOGRAPHY_FONTS = ['sans', 'serif', 'mono'];

const musicVideoTextCueSchema = z.object({
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

const musicVideoCodeVideoSchema = z.object({
  providerId: z.string().max(120).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  generatedAt: z.string().max(40).nullable().optional(),
  sections: z.array(z.object({
    id: z.string().min(1).max(64),
    source: codeSectionSource,
  }).strict()).max(40),
}).strict();

// Where the project's composition document lives. Set only by the import
// routes; a PATCH that carries it back is ignored (the stored pointer wins).
const musicVideoCompositionDocumentSchema = z.object({
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
const musicVideoCompositionOverlaySchema = z.object({
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

export const musicVideoNarrativeEventSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  kind: z.enum(NARRATIVE_EVENT_KINDS),
  anchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('time'), atSec: z.number().min(0).max(36000), offsetSec: z.number().min(-900).max(900).optional() }).strict(),
    z.object({ kind: z.literal('onset'), band: z.enum(['low', 'mid', 'high']), index: z.number().int().min(0).max(100000), offsetSec: z.number().min(-900).max(900).optional() }).strict(),
    z.object({ kind: z.literal('word'), cueId: z.string().min(1).max(64), wordIndex: z.number().int().min(0).max(1000), offsetSec: z.number().min(-900).max(900).optional() }).strict(),
  ]).nullable(),
  durationSec: z.number().positive().max(900),
  narrativeFunction: z.string().min(1).max(1000),
  mediumRationale: z.string().min(1).max(1000),
  text: z.string().max(500).optional(),
  motif: z.string().max(120).optional(),
  before: z.string().max(120).optional(),
  after: z.string().max(120).optional(),
  fromValue: z.number().finite().min(-1000000).max(1000000).optional(),
  toValue: z.number().finite().min(-1000000).max(1000000).optional(),
}).strict();
export const musicVideoReactiveSectionSchema = z.object({
  sectionId: z.string().min(1).max(64),
  gain: z.number().min(0).max(1),
  maxGain: z.number().min(0).max(1),
}).strict();

// Scene code is data until the isolated Eidoverse container renders it. No
// executable, host path, output path or remote asset can be selected here.
export const musicVideoEidoverseSceneSchema = z.object({
  inlineScript: z.string().trim().min(1).max(100000),
  assets: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    z.string().max(300).regex(/^eidoverse\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/))
    .refine(assets => Object.keys(assets).length <= 32, 'At most 32 assets').optional(),
}).strict();

// Replaced whole by a project PATCH (the editor sends the full manifest).
export const musicVideoCompositionSchema = z.object({
  version: z.literal(1).optional(),
  mode: z.enum(MUSIC_VIDEO_COMPOSITION_MODES).optional(),
  authoringRenderer: z.enum(['canvas', 'three']).optional(),
  // Curated film style grammar the document authoring prompt follows (#10254).
  styleGrammarId: knownFilmStyleIdSchema.optional(),
  cutting: z.enum(MUSIC_VIDEO_CUTTING_MODES).optional(),
  grade: z.object({
    preset: z.enum(MUSIC_VIDEO_GRADE_PRESETS).optional(),
    grain: z.number().min(0).max(MUSIC_VIDEO_GRADE_MAX_GRAIN).optional(),
    sections: z.array(z.object({
      sceneId: z.string().min(1).max(120),
      preset: z.enum(MUSIC_VIDEO_GRADE_PRESETS),
    }).strict()).max(1000).optional(),
  }).strict().nullable().optional(),
  textCues: z.array(musicVideoTextCueSchema).max(1000).optional(),
  // The director's "this video has no typography": the Make step stops asking for text cues.
  noTypography: z.boolean().optional(),
  style: z.object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').optional(),
    font: z.enum(MUSIC_VIDEO_TYPOGRAPHY_FONTS).optional(),
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/i, 'accentColor is #rrggbb').optional(),
  }).strict().optional(),
  posterSec: timedSec,
  eidoverseScene: musicVideoEidoverseSceneSchema.nullable().optional(),
  codeVideo: musicVideoCodeVideoSchema.nullable().optional(),
  document: musicVideoCompositionDocumentSchema.nullable().optional(),
  documentDraft: musicVideoCompositionDocumentSchema.nullable().optional(),
  overlay: musicVideoCompositionOverlaySchema.nullable().optional(),
  narrativeEvents: z.array(musicVideoNarrativeEventSchema).max(200).refine((events) => new Set(events.map((event) => event.id)).size === events.length, 'event ids must be unique').optional(),
  reactiveSections: z.array(musicVideoReactiveSectionSchema).max(40).refine((sections) => new Set(sections.map((section) => section.sectionId)).size === sections.length, 'section ids must be unique').optional(),
}).strict();

// #10589: a shot's structured camera move — a shared camera-movement id
// (lib/cameraMovements.js) with optional speed, end framing, downbeat landing
// and, for a still camera, the reason it holds. Feeds the i2v camera block and
// the layered template's camera rig. `null` clears it.
const musicVideoSceneCameraSchema = z.object({
  move: z.enum(CAMERA_MOVEMENT_VALUES),
  speed: z.enum(CAMERA_SPEEDS).optional(),
  endFraming: z.enum(CAMERA_FRAMINGS).optional(),
  onBeat: z.boolean().optional(),
  reason: z.string().trim().max(300).optional(),
}).strict();

// #12763: the Casting cast member a shot features and the variant (age, era, look) its
// frames should show. Conditioning leads with that member's render guides; null clears it.
const musicVideoSceneCharacterVariantSchema = z.object({
  ingredientId: z.string().min(1).max(128),
  age: z.number().int().min(0).max(150).optional(),
  era: z.enum(CAST_ERAS).optional(),
  wardrobeId: z.string().trim().min(1).max(59).optional(),
}).strict();

const musicVideoSceneSetReferenceSchema = z.object({
  subjectId: z.string().min(1).max(128),
  greyboxShotId: z.string().min(1).max(GREYBOX_SHOT_ID_MAX).regex(GREYBOX_SHOT_ID_PATTERN).optional(),
  // false keeps the camera's flat figure capture out of renders that send its photo plate.
  blocking: z.literal(false).optional(),
}).strict();

const musicVideoPreMusicLayerSchema = z.object({
  effect: z.enum(PRE_MUSIC_EFFECT_IDS).optional(),
  trackId: z.string().trim().min(1).max(128).optional(),
  atSec: z.number().min(0).max(PRE_MUSIC_DURATION_RANGE.max).optional(),
  durationSec: z.number().positive().max(PRE_MUSIC_DURATION_RANGE.max).nullable().optional(),
  volume: z.number().min(PRE_MUSIC_VOLUME_RANGE.min).max(PRE_MUSIC_VOLUME_RANGE.max).optional(),
}).strict().refine((layer) => !!layer.effect !== !!layer.trackId, 'a sound layer is one effect or one library track');

const musicVideoPreMusicSchema = z.object({
  durationSec: z.number().min(PRE_MUSIC_DURATION_RANGE.min).max(PRE_MUSIC_DURATION_RANGE.max),
  clipVolume: z.number().min(PRE_MUSIC_VOLUME_RANGE.min).max(PRE_MUSIC_VOLUME_RANGE.max).nullable().optional(),
  layers: z.array(musicVideoPreMusicLayerSchema).max(PRE_MUSIC_LAYER_LIMIT).optional(),
}).strict();

// #14822: a real photo of the shot's subject a research agent found and PortOS
// downloaded into the gallery. `pageUrl` is the page it came from, `sourceUrl`
// the image file; both are shown to the director and never sent to a model.
const httpUrl = z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');
const musicVideoResearchReferenceSchema = z.object({
  id: z.string().regex(/^mvr-research-[A-Za-z0-9-]{1,40}$/, 'Invalid research reference id'),
  imageId: z.string().min(1).max(256).regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'must be a gallery image basename'),
  subject: z.string().trim().min(1).max(200),
  sourceUrl: httpUrl.nullable().optional(),
  pageUrl: httpUrl.nullable().optional(),
  addedAt: z.string().max(64).optional(),
}).strict();

// A shot's wipe on one of its cuts (musicVideoWipes.js).
const musicVideoWipeSchema = z.object({
  style: z.enum(MUSIC_VIDEO_WIPES),
  lengthSec: z.number().min(MUSIC_VIDEO_WIPE_SEC.min).max(MUSIC_VIDEO_WIPE_SEC.max).nullable().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'color is #rrggbb').nullable().optional(),
});

// Per-scene visual layer (#8985) — footage, a moved still, or a title card;
// see musicVideoLayers.js. Only a composed render honors a non-footage layer.

const sceneLayerFields = {
  // The references (visual spec ids) sent with this shot's frame renders; absent or null = the automatic set.
  // Priority-ordered; each render sends as many as its renderer takes (musicVideoReferenceCapacity).
  frameReferenceIds: z.array(z.string().min(1).max(128)).max(IMAGE_REFERENCE_REQUEST_LIMIT).nullable().optional(),
  // Independent clip picks; null/absent retains the legacy automatic cast set.
  clipReferenceIds: z.array(z.string().min(1).max(128)).max(MUSIC_VIDEO_CLIP_REFERENCE_REQUEST_LIMIT).nullable().optional(),
  // #14822: researched photos of the shot's subject, offered first among its frame references.
  researchReferences: z.array(musicVideoResearchReferenceSchema).max(MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT).nullable().optional(),
  setReference: musicVideoSceneSetReferenceSchema.nullable().optional(),
  characterVariant: musicVideoSceneCharacterVariantSchema.nullable().optional(),
  camera: musicVideoSceneCameraSchema.nullable().optional(),
  visualLayer: z.enum(MUSIC_VIDEO_VISUAL_LAYERS).optional(),
  stillMove: z.enum(MUSIC_VIDEO_STILL_MOVES).optional(),
  // How a clip of another shape fills the video's frame (musicVideoLayers.js).
  frameFit: z.enum(MUSIC_VIDEO_FRAME_FITS).optional(),
  // A footage clip played faster or slower by whole frames a second, and slid against the song by whole frames; null clears it.
  speedFps: z.number().int().min(CLIP_SPEED_FPS_RANGE.min).max(CLIP_SPEED_FPS_RANGE.max).nullable().optional(),
  offsetFrames: z.number().int().min(CLIP_OFFSET_FRAMES_RANGE.min).max(CLIP_OFFSET_FRAMES_RANGE.max).nullable().optional(),
  // The source clip length to request (seconds), longer than the shot's span when one take is cut across several shots; null clears it.
  clipLengthSec: z.number().min(CLIP_LENGTH_SEC_RANGE.min).max(CLIP_LENGTH_SEC_RANGE.max).nullable().optional(),
  // This shot's own fal/Runway video model, falling back to the project's when null.
  clipModelId: z.string().trim().min(1).max(120).nullable().optional(),
  // The clip plays backwards (a footage shot; never a lip-sync performance).
  reverse: z.boolean().nullable().optional(),
  // A clip shorter than its shot holds its last frame for the rest of the shot; null clears it.
  holdLastFrame: z.boolean().nullable().optional(),
  // The shot's own film look (lib/filmLook.js), kept when the video's look changes; null follows the camera, then the video.
  filmLook: filmLookSchema.nullable().optional(),
  templateEffects: musicVideoTemplateEffectsSchema.nullable().optional(),
  // A VHS glitch over the cut into / out of this shot (musicVideoTransitions.js); null clears it.
  transitionIn: z.enum(MUSIC_VIDEO_TRANSITIONS).nullable().optional(),
  transitionOut: z.enum(MUSIC_VIDEO_TRANSITIONS).nullable().optional(),
  // An image-to-image wipe on the cut into / out of this shot (musicVideoWipes.js), its length and a
  // shape wipe's edge color; a side with a wipe plays no glitch. null clears it.
  wipeIn: musicVideoWipeSchema.nullable().optional(),
  wipeOut: musicVideoWipeSchema.nullable().optional(),
  // Glitches at moments inside the shot: `atSec` from the shot's start, `lengthSec` stretching the style,
  // `strength` (0 = off), `count` repeats `everySec` apart, and a light leak's `color`/`edge`; null clears them.
  glitches: z.array(musicVideoShotGlitchSchema).max(MUSIC_VIDEO_SHOT_GLITCH_LIMIT).nullable().optional(),
  // An effect across the cut out of this shot (musicVideoCutEffects.js), kept with its settings while switched off; null clears it.
  cutEffect: z.object({
    style: z.enum(MUSIC_VIDEO_CUT_EFFECTS),
    enabled: z.boolean().optional(),
    overlapSec: z.number().min(BEAT_TOGGLE_OVERLAP.min).max(BEAT_TOGGLE_OVERLAP.max).optional(),
    rate: z.enum(BEAT_TOGGLE_RATES).optional(),
  }).nullable().optional(),
  // A code-drawn effect a still shot plays instead of a clip (musicVideoImageEffects.js) and how long
  // it takes to finish; null clears it.
  imageEffect: z.enum(MUSIC_VIDEO_IMAGE_EFFECTS).nullable().optional(),
  imageEffectSec: z.number().min(IMAGE_EFFECT_SEC_RANGE.min).max(IMAGE_EFFECT_SEC_RANGE.max).nullable().optional(),
  photoSequence: z.object({
    enabled: z.boolean().optional(),
    imageIds: z.array(z.string().min(1).max(256).regex(/^[^/\\\\]+$/)).max(PHOTO_SEQUENCE_LIMIT),
    intervalFrames: z.number().int().min(1).max(720),
    rate: z.enum(PHOTO_SEQUENCE_RATES).optional(),
    // #14277: how long an outgoing photo stays beneath the next, and per-photo
    // layouts parallel to imageIds (null = full frame).
    overlapFrames: z.number().int().min(0).max(PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES).optional(),
    layouts: z.array(z.object(Object.fromEntries(Object.entries(PHOTO_LAYOUT_RANGES)
      .map(([key, range]) => [key, z.number().min(range.min).max(range.max)]))).strict().nullable()).max(PHOTO_SEQUENCE_LIMIT).optional(),
  }).strict().refine(s => !s.layouts || s.layouts.length <= s.imageIds.length, { message: 'A photo layout needs its photo', path: ['layouts'] }).nullable().optional(),
  cardText: z.string().max(500).nullable().optional(),
  // #10302: footage that the composition also draws code over; still counts as footage.
  codeOverlay: z.boolean().optional(),
  // Footage whose clip was rendered from code (an uploaded code render): the board labels it Code.
  codeClip: z.boolean().optional(),
  cardColor: z.string().regex(/^#[0-9a-f]{6}$/i, 'card color is #rrggbb').nullable().optional(),
  // The shot plays before the song, in the cold open (lib/musicVideo/musicVideoColdOpen.js), with
  // its own length and sound: the clip's audio and/or sound layers. null returns it to the song.
  preMusic: musicVideoPreMusicSchema.nullable().optional(),
  // A song shot's own clip sound over the music (lib/musicVideo/musicVideoClipSound.js): its level and
  // the song's level under it. null returns the shot to silent under the song.
  clipSound: z.object({
    volume: z.number().min(CLIP_SOUND_VOLUME_RANGE.min).max(CLIP_SOUND_VOLUME_RANGE.max).optional(),
    musicLevel: z.number().min(CLIP_SOUND_MUSIC_RANGE.min).max(CLIP_SOUND_MUSIC_RANGE.max).optional(),
  }).strict().nullable().optional(),
  // #10583: where a composition document's lyric type may sit in this shot, and the role of its lines.
  textZone: z.enum(MUSIC_VIDEO_TEXT_ZONES).nullable().optional(),
  lyricRole: z.enum(MUSIC_VIDEO_LYRIC_ROLES).nullable().optional(),
  lyricSize: z.enum(MUSIC_VIDEO_LYRIC_SIZES).nullable().optional(),
};

// ---- Pre-production treatment (#8980) --------------------------------------

// The treatment sits between the director's concept/visual spec and the timed
// shot planner: a structured brief, a compiled whole-song arc, per-shot
// direction keyed to the board's real scene ids, and a proof checklist. Its own
// routes edit it (never the generic project PATCH) so every write carries the
// revision it was based on. See services/musicVideo/treatment.js.
export const MUSIC_VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '2.39:1'];
export const MUSIC_VIDEO_LYRIC_LAYOUTS = ['social', 'cinematic'];
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
const musicVideoTreatmentReferenceNoteSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  note: z.string().max(1000).optional(),
  url: referenceUrl.nullable().optional(),
}).strict();

// Every brief field is optional; a patch merges per field.
export const musicVideoTreatmentBriefSchema = z.object({
  audience: z.string().max(500).optional(),
  destination: z.string().max(200).optional(),
  aspectRatio: z.enum(MUSIC_VIDEO_ASPECT_RATIOS).nullable().optional(),
  lyricLayout: z.enum(MUSIC_VIDEO_LYRIC_LAYOUTS).nullable().optional(),
  emotion: z.string().max(500).optional(),
  premise: z.string().max(2000).optional(),
  hookObjective: z.string().max(1000).optional(),
  graphicLanguage: z.string().max(1000).optional(),
  mustHave: z.string().max(2000).optional(),
  avoid: z.string().max(2000).optional(),
  referenceNotes: z.array(musicVideoTreatmentReferenceNoteSchema).max(20).optional(),
}).strict();

export const musicVideoExcerptRequestSchema = z.object({
  startSec: z.number().min(0).max(36000),
  endSec: z.number().min(0).max(36000),
  // #9280: a social cut renders at another frame and fades its audio edges.
  aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
  fade: z.boolean().optional(),
}).strict().refine((r) => r.endSec > r.startSec, { message: 'endSec must be greater than startSec' });

// #9282: posting to a platform through the PortOS Browser. One strict options
// object covers every target; each target's payload builder reads only its own.
export const MUSIC_VIDEO_PUBLISH_TARGETS = Object.freeze(['youtube', 'shorts', 'tiktok', 'instagram', 'x', 'linkedin', 'facebook', 'reddit', 'stackerNews', 'substack', 'suno', 'sunoHook', 'distrokid']);

// ---- Development artifacts ("ingredients") ----------------------------------
// Reviewable development files attached to a project (a Cast & Sets sheet, an
// animatic, a treatment, a storyboard). Bytes live on disk; see
// services/musicVideo/devArtifacts.js.
export const MUSIC_VIDEO_DEV_ARTIFACT_KINDS = ['cast-sets', 'animatic', 'treatment', 'storyboard', 'other'];
export const MUSIC_VIDEO_DEV_ARTIFACT_STATUSES = ['pending', 'approved', 'changes-requested'];

// Direct edits to a direction. A present text field replaces the current value
// (empty clears it); an absent one keeps it. List items are patched by id (or
// a test by its 1-based index); `remove: true` drops one.
export const castSetsText = (max) => z.string().max(max);
export const musicVideoCastAndSetsDirectionEditSchema = z.object({
  renderingMedium: castSetsText(500).optional(),
  // The people-sheet layout castAndSetsPlan.js#sheetViews renders.
  sheetLayout: z.enum(['standard', 'five-view']).optional(),
  protagonist: z.object({
    construction: castSetsText(1000).optional(),
    shapeLanguage: castSetsText(500).optional(),
    materials: castSetsText(500).optional(),
    palette: castSetsText(300).optional(),
    movement: castSetsText(1000).optional(),
    expressions: z.array(castSetsText(300)).max(8).optional(),
    name: castSetsText(120).optional(),
    description: castSetsText(1000).optional(),
    height: castSetsText(80).optional(),
    face: castSetsText(1000).optional(),
    hair: castSetsText(1000).optional(),
    signature: castSetsText(1000).optional(),
    gesture: castSetsText(1000).optional(),
    forms: z.array(z.object({
      id: z.string().max(64).optional(),
      label: castSetsText(120),
      age: castSetsText(40).optional(),
      description: castSetsText(1000),
      hair: castSetsText(1000).optional(),
      wardrobe: castSetsText(1000).optional(),
      height: castSetsText(80).optional(),
      era: castSetsText(120).optional(),
      look: castSetsText(500).optional(),
      renderingMedium: castSetsText(500).optional(),
      // The fixed-casting subject whose reference grounds this age (null clears).
      subjectId: z.string().max(64).nullable().optional(),
      // Echoed back from the saved form; the server re-stamps it from the subject.
      subjectName: z.string().max(120).optional(),
    }).strict()).max(3).optional(),
  }).strict().optional(),
  looks: z.array(z.object({
    name: castSetsText(120).min(1),
    description: castSetsText(1000).min(1),
    chapters: castSetsText(300).optional(),
    originalName: castSetsText(120).optional(),
  }).strict()).min(1).max(4).optional(),
  // The whole prop list (castAndSetsDirection CAST_SETS_LIMITS.props).
  props: z.array(z.object({
    id: z.string().max(64).optional(),
    name: castSetsText(120).min(1),
    owner: castSetsText(120).optional(),
    description: castSetsText(1000).min(1),
  }).strict()).max(6).optional(),
  // Every catalog-linked supporting character (up to the per-video subject limit) plus 4 invented ones.
  cast: z.array(z.object({
    id: z.string().min(1).max(64),
    remove: z.literal(true).optional(),
    name: castSetsText(120).optional(),
    role: castSetsText(120).optional(),
    description: castSetsText(1000).optional(),
    height: castSetsText(80).optional(),
    face: castSetsText(1000).optional(),
    hair: castSetsText(1000).optional(),
    wardrobe: castSetsText(1000).optional(),
  }).strict()).max(28).optional(),
  tests: z.array(z.object({
    index: z.number().int().min(1).max(4),
    remove: z.literal(true).optional(),
    action: castSetsText(1000).optional(),
    caption: castSetsText(300).optional(),
    look: castSetsText(120).optional(),
    // The protagonist form (other age) this test shows; null clears it.
    formId: z.string().max(64).nullable().optional(),
  }).strict()).max(4).optional(),
  world: z.object({
    layout: castSetsText(1000).optional(),
    depth: castSetsText(500).optional(),
    lighting: castSetsText(500).optional(),
    camera: castSetsText(500).optional(),
    transitions: castSetsText(500).optional(),
  }).strict().optional(),
  sets: z.array(z.object({
    id: z.string().min(1).max(64),
    remove: z.literal(true).optional(),
    name: castSetsText(120).optional(),
    description: castSetsText(1000).optional(),
    lighting: castSetsText(300).optional(),
    era: castSetsText(120).optional(),
    look: castSetsText(500).optional(),
    imageRole: z.enum(['background', 'texture', 'decoration', 'cutout']).optional(),
    setReference: musicVideoSceneSetReferenceSchema.nullable().optional(),
  }).strict()).max(8).optional(),
}).strict().refine((edits) => {
  if (!edits.sets?.some((set) => Object.hasOwn(set, 'setReference'))) return true;
  return !Object.hasOwn(edits, 'renderingMedium') && !Object.hasOwn(edits, 'sheetLayout') && !edits.protagonist && !edits.world && !edits.looks && !edits.cast && !edits.tests
    && edits.sets.every((set) => Object.keys(set).every((key) => key === 'id' || key === 'setReference'));
}, 'Save greybox selections separately from direction edits.');

// #14820: the sung word (or phrase) a shot was cut on; its start follows that word's onset.
const musicVideoLyricAnchorSchema = z.object({
  cueId: z.string().min(1).max(64),
  wordIndex: z.number().int().min(0).max(1000),
  wordCount: z.number().int().min(1).max(200).optional(),
}).strict();

// Review content is editable; approval records are server-owned and never PATCHable.
export const musicVideoProductionDraftSchema = z.object({
  storyboardSource: z.enum(['board', 'document']).optional(),
  cast: z.string().max(12000), environments: z.string().max(12000),
  visualLanguage: z.string().max(12000), motionLanguage: z.string().max(12000),
  implementationPlan: z.string().max(16000).optional(),
  guideArtifactId: z.string().max(64).nullable(),
  sourceArtifactId: z.string().max(64).nullable().optional(),
  lyricsMode: z.enum(['vocal', 'instrumental']), timingStatus: z.enum(['provisional', 'verified']),
  timingNotes: z.string().max(4000),
  storyboard: z.array(z.object({
    id: z.string().max(64).optional(), startSec: timedSec, endSec: timedSec,
    sceneId: z.string().max(64).nullable(), lyricCueIds: z.array(z.string().max(64)).max(2000),
    lyricAnchor: musicVideoLyricAnchorSchema.optional(),
    action: z.string().max(4000), staging: z.string().max(4000),
    camera: z.string().max(4000), transition: z.string().max(4000),
  }).strict()).max(2000),
}).strict();

// A scene on the director board. `startSec`/`endSec` place it on the timeline;
// `prompt` drives the shot's video; `framePrompt`/`referenceImageId` are the
// reference-frame inputs the i2v generation (Phase 1b) will consume.
// The linked storyboard panel a shot was fitted from (Fit to song), and a
// fingerprint of the panel as it was then, so a later panel edit shows on the shot.
const scenePanelFields = {
  panelId: z.string().regex(/^panel-[A-Za-z0-9-]{1,80}$/, 'Invalid panel id').nullable().optional(),
  panelRev: z.string().regex(/^[0-9a-z]{1,16}$/, 'Invalid panel revision').nullable().optional(),
  panelArt: z.string().regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'Panel art must be a gallery image').nullable().optional(),
};

const musicVideoSourceTakeSchema = z.object({
  sceneId: z.string().min(1).max(80),
  offsetSec: z.number().min(0).max(36000).optional(),
}).strict();

export const musicVideoSceneCreateSchema = z.object({
  label: z.string().max(120).optional(),
  sectionLabel: z.string().max(120).nullable().optional(),
  prompt: z.string().max(8000).optional(),
  framePrompt: z.string().max(8000).nullable().optional(),
  startSec: z.number().min(0).max(36000).nullable().optional(),
  endSec: z.number().min(0).max(36000).nullable().optional(),
  beatAligned: z.boolean().optional(),
  beatNeedsReview: z.boolean().optional(),
  pacingCut: z.boolean().optional(),
  // #8964: shot-planning fields. `loop` is an explicit, deliberate choice to
  // repeat the source clip across a longer authored span; a scene with no
  // `loop` key is a pre-#8964 record and keeps the legacy loop-to-fill render.
  loop: z.boolean().optional(),
  sectionIndex: z.number().int().min(0).max(10000).nullable().optional(),
  lyricText: z.string().max(2000).nullable().optional(),
  lyricAnchor: musicVideoLyricAnchorSchema.nullable().optional(),
  visualIntent: z.string().max(2000).nullable().optional(),
  ...sceneLayerFields,
  // #8977: `performance` = a lip-synced singer that must follow the master
  // recording (only a verified source-audio provider can render it); absent or
  // `cutaway` = the ordinary image-to-video shot. See lib/musicVideo/musicVideoShotTiming.js.
  shotMode: z.enum(MUSIC_VIDEO_SHOT_MODES).optional(),
  // #14241: `sequence` generates a run of cutaway footage shots in one timed request.
  coverage: z.enum(MUSIC_VIDEO_COVERAGE_MODES).optional(),
  // #15588: this shot plays a window of another scene's clip. Null clears the link.
  sourceTake: musicVideoSourceTakeSchema.nullable().optional(),
  performanceSpeaker: z.string().trim().max(120).nullable().optional(),
  // How a performance follows the song: lip-sync (absent/null) or music-driven motion.
  performanceStyle: z.enum(MUSIC_VIDEO_PERFORMANCE_STYLES).nullable().optional(),
  ...scenePanelFields,
}).strict().refine(
  (s) => s.startSec == null || s.endSec == null || s.endSec >= s.startSec,
  { message: 'endSec must be >= startSec', path: ['endSec'] },
);

// The last render failure persisted on a scene by the scene image/video hooks
// (#10154): which lane failed, why (one bounded line), and when.
const musicVideoSceneLastFailureSchema = z.object({
  lane: z.enum(['image', 'video']),
  error: z.string().max(300),
  at: z.string().max(64),
  // #16178: the tier a failed clip render ran at, so the card's Retry repeats it.
  tier: z.enum(['draft', 'final']).optional(),
}).strict();

// Times are nullable here so clearing a Start/End input (the UI sends `null`)
// is accepted. The endSec >= startSec invariant can't be checked on the partial
// patch alone (the paired value may live on the existing record), so the merged
// range is validated in projectsLogic.applySceneUpdate instead.
export const musicVideoSceneUpdateSchema = z.object({
  // #16136: approval to upgrade the selected draft clip; derived-valid (see musicVideoFinalApproval.js).
  finalApproval: z.object({ takeId: z.string().max(128), revision: z.string().max(32) }).nullable().optional(),
  label: z.string().max(120).optional(),
  sectionLabel: z.string().max(120).nullable().optional(),
  prompt: z.string().max(8000).optional(),
  framePrompt: z.string().max(8000).nullable().optional(),
  startSec: z.number().min(0).max(36000).nullable().optional(),
  endSec: z.number().min(0).max(36000).nullable().optional(),
  beatAligned: z.boolean().optional(),
  beatNeedsReview: z.boolean().optional(),
  pacingCut: z.boolean().optional(),
  // #8964: shot-planning fields. `loop` is an explicit, deliberate choice to
  // repeat the source clip across a longer authored span; a scene with no
  // `loop` key is a pre-#8964 record and keeps the legacy loop-to-fill render.
  loop: z.boolean().optional(),
  sectionIndex: z.number().int().min(0).max(10000).nullable().optional(),
  lyricText: z.string().max(2000).nullable().optional(),
  lyricAnchor: musicVideoLyricAnchorSchema.nullable().optional(),
  visualIntent: z.string().max(2000).nullable().optional(),
  ...sceneLayerFields,
  // #8977: `performance` = a lip-synced singer that must follow the master
  // recording (only a verified source-audio provider can render it); absent or
  // `cutaway` = the ordinary image-to-video shot. See lib/musicVideo/musicVideoShotTiming.js.
  shotMode: z.enum(MUSIC_VIDEO_SHOT_MODES).optional(),
  // #14241: `sequence` generates a run of cutaway footage shots in one timed request.
  coverage: z.enum(MUSIC_VIDEO_COVERAGE_MODES).optional(),
  // #15588: this shot plays a window of another scene's clip. Null clears the link.
  sourceTake: musicVideoSourceTakeSchema.nullable().optional(),
  performanceSpeaker: z.string().trim().max(120).nullable().optional(),
  // How a performance follows the song: lip-sync (absent/null) or music-driven motion.
  performanceStyle: z.enum(MUSIC_VIDEO_PERFORMANCE_STYLES).nullable().optional(),
  referenceImageId: z.string().max(256).nullable().optional(),
  videoHistoryId: z.string().max(64).nullable().optional(),
  // #11173: an optional style-break end frame (the selected `endImage` take)
  // and the prompt that renders it from the start frame.
  endImageId: z.string().max(256).nullable().optional(),
  endFramePrompt: z.string().max(8000).nullable().optional(),
  // The shot's end frame switched off: clips skip it, its selection and takes stay.
  endFrameOff: z.boolean().nullable().optional(),
  // #10154: the last generation failure the render hooks persisted. The board
  // may send `null` to dismiss it; a full object is accepted so a client that
  // round-trips the scene doesn't 400.
  lastFailure: musicVideoSceneLastFailureSchema.nullable().optional(),
  // #14821: the roster cameo this shot shows (null unlinks), and the cameo's variant it picks.
  cameoId: z.string().regex(MUSIC_VIDEO_CAMEO_ID_PATTERN, 'Invalid cameo id').nullable().optional(),
  cameoVariantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN, 'Invalid variant id').nullable().optional(),
  // This shot's own on-screen name for its cameo (an alias, e.g. Spoodle for the Cockapoo); null uses the cameo's label.
  cameoLabel: z.string().trim().max(120).nullable().optional(),
  shotSheet: musicVideoShotSheetSchema.nullable().optional(),
  ...scenePanelFields,
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
  // The master audio file this was derived from (#14793); absent on older records.
  masterFilename: z.string().min(1).max(260).optional(),
  features: musicVideoSongFeaturesSchema.nullable().optional(),
  bpm: z.number().nullable(),
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
  downbeatSource: z.enum(['onsets', 'structure']).optional(),
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
    labelSource: z.enum(['analysis', 'lyrics', 'manual']).optional(),
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
  // Beat-grid trust (#14240). `gridDecision: 'ignore'` stops the automatic grid
  // from snapping cuts; `gridReason` is shown beside the manual BPM control.
  beatContrast: z.number().min(0).nullable().optional(),
  beatSpread: z.number().min(0).nullable().optional(),
  phaseCancellation: z.boolean().optional(),
  gridDecision: z.enum(['use', 'ignore']).nullable().optional(),
  gridReason: z.string().max(200).nullable().optional(),
}).strict();
