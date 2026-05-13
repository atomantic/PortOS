import { z } from 'zod';

export const providerSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['cli', 'api']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  endpoint: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  defaultModel: z.string().nullable().optional(),
  timeout: z.number().int().min(1000).max(600000).optional(),
  enabled: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  secretEnvVars: z.array(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional()
});

export const runSchema = z.object({
  type: z.enum(['ai', 'command']),
  providerId: z.string().optional(),
  model: z.string().optional(),
  workspacePath: z.string().optional(),
  workspaceName: z.string().optional(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  timeout: z.number().int().min(1000).max(600000).optional()
});

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map(e => ({
      path: e.path.join('.'),
      message: e.message
    }))
  };
}
