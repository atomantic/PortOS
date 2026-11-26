// Zod schemas for Code Animation generation, paging, revisions, and soundtracks.

import { z } from 'zod';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { emptyToNull } from './zodCompat.js';
import { filmStyleIdSchema } from './filmStyleGrammarValidation.js';
import { getFilmStyleGrammar } from './filmStyleGrammars.js';
import {
  CODE_ANIMATION_ASPECT_RATIOS,
  CODE_ANIMATION_LIMITS,
  CODE_ANIMATION_RENDERERS,
  CODE_ANIMATION_RESOLUTIONS,
} from './codeAnimationPresets.js';

const L = CODE_ANIMATION_LIMITS;

// An upload basename as POST /api/uploads returns it — never a path.
const uploadFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+$/, 'filename must be an upload basename');

const optionalId = z.preprocess(emptyToNull, z.string().trim().min(1).max(128).nullable().optional());

// Optional film style grammar (#10253): kebab-case id that must exist in the catalog.
const styleGrammarIdSchema = z.preprocess(emptyToNull, filmStyleIdSchema
  .refine((id) => !!getFilmStyleGrammar(id), 'Unknown film style grammar')
  .nullable().optional());

const formatSchema = z.object({
  durationSeconds: z.number().int().min(L.durationMin).max(L.durationMax).default(20),
  aspectRatio: z.enum(Object.keys(CODE_ANIMATION_ASPECT_RATIOS)).default('16:9'),
  resolution: z.enum(Object.keys(CODE_ANIMATION_RESOLUTIONS)).default('1080p'),
  fps: z.number().int().refine((fps) => L.fpsOptions.includes(fps), 'Unsupported frame rate').default(30),
});

const uploadAudioSchema = z.object({
  source: z.literal('upload').optional().default('upload'),
  filename: uploadFilenameSchema,
  label: z.string().trim().max(200).default(''),
  durationSeconds: z.number().positive().max(60 * 60).nullable().optional(),
  notes: z.string().trim().max(L.audioNotesMax).default(''),
});

const trackAudioSchema = z.object({
  source: z.literal('track'),
  trackId: z.string().trim().min(1).max(128),
  label: z.string().trim().max(200).optional(),
  durationSeconds: z.number().positive().max(60 * 60).nullable().optional(),
  notes: z.string().trim().max(L.audioNotesMax).default(''),
});

const audioSchema = z.union([trackAudioSchema, uploadAudioSchema]).nullable().optional();

export const briefSchema = z.object({
  title: z.string().trim().max(L.titleMax).default(''),
  concept: z.string().trim().min(1, 'Describe what happens in the animation').max(L.conceptMax),
  // The lead characters' design bible — what the coding model rigs.
  cast: z.string().trim().max(L.castMax).default(''),
  onScreenText: z.string().trim().max(L.textMax).default(''),
  // Refinements on top of the universe style — the universe is the art direction.
  styleNotes: z.string().trim().max(L.styleNotesMax).default(''),
  styleGrammarId: styleGrammarIdSchema,
  format: formatSchema.prefault({}),
  renderer: z.enum(CODE_ANIMATION_RENDERERS).default('auto'),
  interactive: z.boolean().default(false),
  soundtrack: z.enum(['none', 'procedural']).default('none'),
  universeId: optionalId,
  // Absent → follow the universe's linked board; '' / null → no board.
  moodBoardId: optionalId,
  includeMoodBoardImages: z.boolean().default(true),
  referenceImages: z.array(z.object({
    filename: uploadFilenameSchema,
    label: z.string().trim().max(200).default(''),
    note: z.string().trim().max(L.referenceNoteMax).default(''),
  })).max(L.referenceImagesMax).default([]),
  // A Media History video (data/videos basename) studied as the quality bar.
  referenceVideo: z.object({
    filename: uploadFilenameSchema,
    label: z.string().trim().max(200).default(''),
    note: z.string().trim().max(L.referenceNoteMax).default(''),
  }).strict().nullable().optional(),
  audio: audioSchema,
  // A finished animation this one forks and extends (its HTML rides the prompt).
  baseJobId: z.string().uuid().nullable().optional(),
}).strict();

export const generateSchema = briefSchema.extend({
  seedIdea: z.string().trim().max(L.seedIdeaMax).default(''),
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(256).optional(),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()),
}).strict();

// Writing the brief needs only the art-direction selections plus whatever the
// artist has typed so far — never the uploads or audio, which condition the
// picture, not the story.
export const briefIdeaSchema = z.object({
  universeId: optionalId,
  moodBoardId: optionalId,
  styleGrammarId: styleGrammarIdSchema,
  seedIdea: z.string().trim().max(L.seedIdeaMax).default(''),
  // The same brief, partially filled — derived from briefSchema so the field
  // caps are stated once, with `concept` relaxed because there may be none yet.
  current: briefSchema
    .pick({ title: true, cast: true, onScreenText: true, styleNotes: true })
    .extend({ concept: z.string().trim().max(L.conceptMax).default('') })
    .prefault({}),
  // Only the two the writer's prompt reads — the renderer, fps, and resolution
  // condition the picture, not the story.
  format: formatSchema.pick({ durationSeconds: true, aspectRatio: true }).prefault({}),
  providerId: z.string().trim().max(128).optional(),
  model: z.string().trim().max(256).optional(),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()),
}).strict();

export const jobsPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(256).optional(),
}).strict();

export const exportParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const projectPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const revisionParamsSchema = exportParamsSchema.extend({ revisionId: z.string().uuid() });

export const soundtrackSchema = z.object({
  prompt: z.string().max(8000).refine((value) => value.trim().length > 0, 'Describe the soundtrack'),
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256).optional(),
  instrumentalOnly: z.boolean().default(true),
}).strict();

export const revisionBodySchema = z.object({ revisionId: z.string().uuid() }).strict();

export const stageRunParamsSchema = z.object({ id: z.string().uuid(), runId: z.string().uuid() }).strict();

export const acceptRunBodySchema = z.object({ runId: z.string().uuid() }).strict();
