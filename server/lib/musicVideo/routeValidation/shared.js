/** Reusable Music Video request schemas and field validators. */

import { z } from 'zod';
import { EFFORT_LEVELS } from '../../provider/providerModels.js';
import { MUSIC_VIDEO_LLM_STAGES } from '../musicVideoAutomation.js';
import { galleryImageName, musicVideoCastInputsSchema } from '../musicVideoValidation.js';

// A video-history id (the scene clip vocabulary `videoHistoryId` already uses).
export const videoHistoryIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'must be a video history id');

// `endImage` (#11173): a candidate for the scene's optional style-break end frame.
export const MUSIC_VIDEO_TAKE_KINDS = ['image', 'video', 'endImage'];

// A take's intended use (#8980). A `motion-reference` take is scaffolding (e.g.
// generated footage to trace a hand-drawn pass over): it is kept as a candidate
// but never fills the scene's timeline slot automatically.
export const MUSIC_VIDEO_TAKE_USES = ['final', 'motion-reference'];

// Provider label for provenance — free text so a new external tool needs no
// schema change, but bounded to a slug so it can't smuggle a URL or a secret.
export const providerSlug = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'provider must be a short slug');

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

export const musicVideoCodeGenerateSchema = z.object({
  providerId: z.string().max(120).optional(),
  model: z.string().max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

// A provider/model/effort pin for a Music Video text stage. Effort is the union
// of every accepted level; the runner clamps it to the chosen provider's ladder.
export const musicVideoLlmSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
}).strict();

// Per-stage pins (MUSIC_VIDEO_LLM_STAGES): an absent stage keeps its stored pin
// (or, on a start request, uses the direction pin); null clears that stage.
export const musicVideoLlmStagesSchema = z.object(Object.fromEntries(
  MUSIC_VIDEO_LLM_STAGES.map((stage) => [stage, musicVideoLlmSchema.nullable().optional()]),
)).strict();

export const devArtifactNoteText = z.string().trim().min(1).max(2000);

export const devArtifactNoteTarget = z.string().trim().max(120).nullable().optional();

// Optional provider pin for Cast & Sets, production review, and song revision.
export const musicVideoCastAndSetsStartSchema = z.object({
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();
