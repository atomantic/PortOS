/** Request schemas for Music Video revision, review, production, and autonomous runs. */

import { z } from 'zod';
import { IMAGE_GEN_MODES, VIDEO_GEN_MODES } from '../../generationModes.js';
import { EFFORT_LEVELS } from '../../provider/providerModels.js';
import { MUSIC_VIDEO_AUTOMATION_BUDGET_MAX_USD, MUSIC_VIDEO_AUTOMATION_TOOL_IDS } from '../musicVideoAutomation.js';
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
} from '../musicVideoAutonomous.js';
import { MUSIC_VIDEO_CHARACTER_STYLE_IDS } from '../musicVideoCharacterStyles.js';
import { MUSIC_VIDEO_MEDIA_MODES } from '../musicVideoMediaPolicy.js';
import { musicVideoLlmSchema, musicVideoLlmStagesSchema } from './shared.js';

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
