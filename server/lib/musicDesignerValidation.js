import { z } from 'zod';
import { CONCEPT_MAX, PROMPT_MAX, LYRICS_MAX } from './trackLimits.js';
import { isNonBlankStr } from './textUtils.js';

// Authored model inputs are validated without rewriting whitespace or cutting
// text. Count the original string, including whitespace, against its wire cap.
const authoredField = (field, limit) => z.string().superRefine((value, ctx) => {
  if (value.length > limit) ctx.addIssue({ code: 'custom', message: `${field} has ${value.length} characters; limit is ${limit}` });
});
const requiredField = (field, limit) => authoredField(field, limit).refine(isNonBlankStr, `${field} is required`);
export const MUSIC_DESIGNER_GUIDANCE_MAX = 4000;
export const musicDesignerFields = {
  guidance: authoredField('guidance', MUSIC_DESIGNER_GUIDANCE_MAX).optional(),
  template: authoredField('template', PROMPT_MAX).optional(),
};
export const musicDescribeInputSchema = z.object({
  concept: requiredField('concept', CONCEPT_MAX),
  ...musicDesignerFields,
});
export const musicLyricsInputSchema = z.object({
  description: requiredField('description', PROMPT_MAX),
  request: authoredField('request', MUSIC_DESIGNER_GUIDANCE_MAX).optional(),
  targetSeconds: z.number().min(30).max(600).optional(),
  ...musicDesignerFields,
});
export const musicLyricsReviewInputSchema = z.object({
  lyrics: requiredField('lyrics', LYRICS_MAX),
  description: authoredField('description', PROMPT_MAX).optional(),
  request: authoredField('request', MUSIC_DESIGNER_GUIDANCE_MAX).optional(),
  guidance: musicDesignerFields.guidance,
});
