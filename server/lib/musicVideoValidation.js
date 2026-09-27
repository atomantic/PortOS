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
  backend: z.enum(['local', 'grok']).nullable().optional(),
  modelId: z.string().max(64).nullable().optional(),
  grokDuration: z.union([z.literal(6), z.literal(10)]).optional(),
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

// Import lyric cues from pasted text: LRC (`[mm:ss.xx] line`), SRT/WebVTT
// cue blocks, or plain lines (untimed). `auto` sniffs the format.
export const musicVideoLyricsImportSchema = z.object({
  format: z.enum(['auto', 'lrc', 'srt', 'text']).optional(),
  text: z.string().max(200000),
  mode: z.enum(['replace', 'append']).optional(),
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
  videoSettings: musicVideoVideoSettingsSchema.optional(),
}).strict();

export const musicVideoProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  status: z.enum(MUSIC_VIDEO_STATUSES).optional(),
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  videoSettings: musicVideoVideoSettingsSchema.optional(),
  renderHistoryId: z.string().max(64).nullable().optional(),
  lyricCues: lyricCueList.optional(),
  phrases: phraseList.optional(),
  pacing: musicVideoPacingSchema.nullable().optional(),
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
