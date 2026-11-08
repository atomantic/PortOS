import { z } from 'zod';
import { MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX } from './musicVideoSubjectLimits.js';
import { executionOptionsSchema } from './aiToolkit/internal/executionOptionsValidation.js';
import { musicVideoPrevizSchema, musicVideoShotSheetSchema, musicVideoTreatmentBriefSchema } from './musicVideoValidation.js';
import { worldMapSchema } from './worldMapValidation.js';
import { PREVIZ_CAMERA_STYLES } from './musicVideoPrevizLimits.js';
import { SHOT_SHEET_PROPOSE_BATCH } from './musicVideoShotSheet.js';
import { STORYBOARD_MUSICAL_ROLES, STORYBOARD_PANEL_FRAMINGS, STORYBOARD_LIMITS } from './storyboardVocabulary.js';

const text = (max) => z.string().max(max);
const id = z.string().min(1).max(120).optional();
const subject = z.object({ id, kind: z.enum(['character', 'place', 'object']), name: text(120).refine((value) => !!value.trim(), 'Name is required'),
  description: text(MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX).optional(), role: z.enum(['protagonist', 'band', 'supporting']).optional() }).strict();
const panel = z.object({ id, action: text(STORYBOARD_LIMITS.panelText).optional(), dialogue: text(STORYBOARD_LIMITS.panelText).optional(),
  framing: z.enum(STORYBOARD_PANEL_FRAMINGS).nullable().optional(), camera: text(STORYBOARD_LIMITS.camera).optional(),
  seconds: z.number().positive().max(STORYBOARD_LIMITS.panelSecondsMax).nullable().optional() }).strict();
const beat = z.object({ id, title: text(STORYBOARD_LIMITS.beatTitle).optional(), what: text(STORYBOARD_LIMITS.beatText).optional(),
  why: text(STORYBOARD_LIMITS.beatText).optional(), emotion: text(STORYBOARD_LIMITS.emotion).optional(),
  musicalRole: z.enum(STORYBOARD_MUSICAL_ROLES).nullable().optional(), panels: z.array(panel).max(12).optional() }).strict();
export const storyProposalSchema = z.object({
  concept: z.object({ prompt: text(8000).optional(), style: text(2000).optional(), songStyle: text(2000).optional() }).strict().optional(),
  brief: musicVideoTreatmentBriefSchema.omit({ referenceNotes: true }).optional(),
  subjects: z.array(subject).max(24).optional(),
  beats: z.array(beat).max(40).optional(),
}).strict();
export const storySummarySchema = z.object({ summary: text(20000), baseSummary: text(20000) }).strict();
export const storyProposeSchema = z.object({
  providerId: text(256).min(1), model: text(256).optional(), effort: text(32).optional(), executionOptions: executionOptionsSchema.optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: text(16000) }).strict()).min(1).max(40),
  draft: storyProposalSchema.optional(), preview: z.boolean().optional(),
}).strict();
export const storyApplySchema = z.object({ basis: text(64).min(1), proposal: storyProposalSchema.omit({ beats: true }).refine(
  (proposal) => Object.keys(proposal.concept || {}).length > 0 || Object.keys(proposal.brief || {}).length > 0 || (proposal.subjects || []).length > 0,
  'Select at least one change',
) }).strict();
export const storyBeatsApplySchema = z.object({ boardId: text(120).min(1), boardBasis: text(64).min(1), basis: text(64).min(1),
  beats: z.array(beat).min(1).max(40) }).strict();
// Art-direction guides drafted from the story (story.js proposeArtGuides).
const guideText = text(12000).optional();
export const artGuideProposalSchema = z.object({ cast: guideText, environments: guideText, visualLanguage: guideText }).strip();
export const artGuideProposeSchema = z.object({
  providerId: text(256).min(1), model: text(256).optional(), effort: text(32).optional(), executionOptions: executionOptionsSchema.optional(),
  instruction: text(4000).optional(), preview: z.boolean().optional(),
}).strict();

// AI on the shot sheet (services/musicVideo/shotSheetProposals.js): a proposal for a batch of shots, never a save.
export const shotSheetProposeSchema = z.object({
  providerId: text(256).min(1), model: text(256).optional(), effort: text(32).optional(), executionOptions: executionOptionsSchema.optional(),
  direction: z.enum(['from-prompts', 'to-prompts', 'split']),
  sceneIds: z.array(text(64).min(1)).min(1).max(SHOT_SHEET_PROPOSE_BATCH),
  instruction: text(4000).optional(), preview: z.boolean().optional(),
}).strict();
// Only the director ticks Done (stored as `checked`), so a proposal can't carry it.
export const shotSheetBackfillSchema = z.object({ sceneId: text(64).min(1), sheet: musicVideoShotSheetSchema.omit({ checked: true, promptFromSheet: true }).strip() }).strip();
// A split: the frame prompt's details as sheet columns, and the rest as the shot's general prompt.
export const shotSheetSplitSchema = z.object({ sceneId: text(64).min(1), sheet: musicVideoShotSheetSchema.omit({ checked: true, promptFromSheet: true }).strip(), generalPrompt: z.string().max(8000) }).strip();
export const shotSheetPromptProposalSchema = z.object({ sceneId: text(64).min(1), framePrompt: text(8000).optional(), prompt: text(8000).optional() }).strip()
  .refine((shot) => shot.framePrompt !== undefined || shot.prompt !== undefined, 'Propose at least one prompt');

// AI edits to the previz (services/musicVideo/previzProposals.js): the director's request, and what may come back.
export const previzProposeSchema = z.object({
  providerId: text(256).min(1), model: text(256).optional(), effort: text(32).optional(), executionOptions: executionOptionsSchema.optional(),
  instruction: text(4000).refine((value) => !!value.trim(), 'Say what to change'), preview: z.boolean().optional(),
}).strict();
const previzSubjectRef = z.string().min(1).max(64);
// A cut edit names the cut and only the fields it changes; null clears.
export const previzCutPatchSchema = z.object({
  id: z.string().min(1).max(64),
  placeSubjectId: previzSubjectRef.nullable().optional(),
  holderSubjectId: previzSubjectRef.nullable().optional(),
  aimSubjectId: previzSubjectRef.nullable().optional(),
  turnToAim: z.boolean().optional(),
  visibleSubjectIds: z.array(previzSubjectRef).max(24).nullable().optional(),
  storyMin: z.number().finite().min(0).max(2880).nullable().optional(),
  cameraSpot: z.tuple([z.number().finite().min(-5000).max(5000), z.number().finite().min(-5000).max(5000)]).nullable().optional(),
}).strip();
// Each part is checked on its own, so one bad part never costs the rest.
export const previzProposalPartSchemas = {
  world: worldMapSchema,
  timeline: musicVideoPrevizSchema.shape.timeline.unwrap().unwrap(),
  vehicles: musicVideoPrevizSchema.shape.vehicles.unwrap(),
  cuts: z.array(z.unknown()).max(600),
  pawnColors: musicVideoPrevizSchema.shape.pawnColors.unwrap(),
  cameraStyles: z.record(z.string().min(1).max(128), z.enum(PREVIZ_CAMERA_STYLES)),
  summary: z.string().max(2000),
};
