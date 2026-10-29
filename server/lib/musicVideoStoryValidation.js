import { z } from 'zod';
import { executionOptionsSchema } from './aiToolkit/internal/executionOptionsValidation.js';
import { musicVideoTreatmentBriefSchema } from './musicVideoValidation.js';
import { STORYBOARD_MUSICAL_ROLES, STORYBOARD_PANEL_FRAMINGS, STORYBOARD_LIMITS } from './storyboardVocabulary.js';

const text = (max) => z.string().max(max);
const id = z.string().min(1).max(120).optional();
const subject = z.object({ id, kind: z.enum(['character', 'place', 'object']), name: text(120).refine((value) => !!value.trim(), 'Name is required'),
  description: text(1000).optional(), role: z.enum(['protagonist', 'band', 'supporting']).optional() }).strict();
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
