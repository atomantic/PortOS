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
// (or `failed`). `analyzed` marks "beat map cached but not yet arranged". The
// render states land with Phase 2; Phase 1 only reaches up to `ready`.
export const MUSIC_VIDEO_STATUSES = ['draft', 'analyzed', 'ready', 'rendering', 'complete', 'failed'];

// Optional global visual direction for the whole video.
export const musicVideoConceptSchema = z.object({
  prompt: z.string().max(8000).optional(),
  style: z.string().max(2000).optional(),
  universeId: z.string().max(64).nullable().optional(),
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
}).strict();

export const musicVideoProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(MUSIC_VIDEO_MODES).optional(),
  status: z.enum(MUSIC_VIDEO_STATUSES).optional(),
  trackId: z.string().max(64).nullable().optional(),
  uploadedAudioFilename: z.string().max(256).nullable().optional(),
  concept: musicVideoConceptSchema.nullable().optional(),
  renderHistoryId: z.string().max(64).nullable().optional(),
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

// MuScriptor audio → MIDI transcription request (services/audioMidiTranscription.js).
// `model` picks the MuScriptor size tier; the service clamps unknown values to
// its default, this only types the field.
export const musicVideoTranscribeMidiRequestSchema = z.object({
  model: z.enum(['small', 'medium', 'large']).optional(),
}).strict();

// The persisted MIDI-transcription pointer (a .mid basename under /api/uploads,
// produced by the MuScriptor sidecar from the project's source audio). Cleared
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
  sections: z.array(z.object({
    label: z.string(),
    startSec: z.number(),
    endSec: z.number(),
    // Normalized 0..1 section loudness used by the energy-weighted auto-arranger
    // (#1915). Additive + optional so older cached analyses still validate.
    energy: z.number().min(0).optional(),
  })),
  durationSec: z.number(),
}).strict();
