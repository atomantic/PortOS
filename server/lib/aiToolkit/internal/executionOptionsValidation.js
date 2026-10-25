import { z } from 'zod';
import { validateExecutionOptions } from './executionOptions.js';

export const executionOptionsSchema = z.unknown().transform((value, ctx) => {
  try { return validateExecutionOptions(value); }
  catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
    return z.NEVER;
  }
});
