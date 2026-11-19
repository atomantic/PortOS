/**
 * Zod schemas for the prompt stage, variable, job-skill and preview routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { optionalString, nonEmptyString } from './sharedSchemas.js';
import { stageConfigUpdateSchema } from './pipelineValidation.js';

// Prompt stage names and variable keys become `stages/<name>.md` / a
// variables.json key, so they must be a single safe path segment (#9152).
export const promptStageNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'invalid stage name').max(80);
export const promptVariableKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'invalid variable key').max(80);

// Prompts (routes/prompts.js)
export const promptVariableUpdateBodySchema = z.object({ name: optionalString, category: optionalString, content: optionalString });
export const promptVariableCreateBodySchema = z.object({ key: promptVariableKeySchema, name: optionalString, category: optionalString, content: nonEmptyString });
export const promptStageCreateBodySchema = z.object({
  stageName: promptStageNameSchema,
  name: nonEmptyString,
  description: optionalString,
  model: z.string().default('default'),
  returnsJson: z.boolean().default(false),
  variables: z.array(z.string()).default([]),
  template: z.string().default(''),
});
export const promptStageUpdateBodySchema = stageConfigUpdateSchema.extend({ template: z.string().optional() });
export const promptJobSkillBodySchema = z.object({ content: nonEmptyString });
export const promptPreviewBodySchema = z.object({ testData: z.record(z.string(), z.unknown()).default({}) });
