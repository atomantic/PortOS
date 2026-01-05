import { z } from 'zod';

// Process definition schema (for PM2 processes with ports)
export const processSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  description: z.string().optional()
});

// App schema for registration/update
export const appSchema = z.object({
  name: z.string().min(1).max(100),
  repoPath: z.string().min(1),
  type: z.string().optional().default('express'),
  uiPort: z.number().int().min(1).max(65535).nullable().optional(),
  apiPort: z.number().int().min(1).max(65535).nullable().optional(),
  uiUrl: z.string().url().optional(),
  startCommands: z.array(z.string()).min(1).optional(),
  pm2ProcessNames: z.array(z.string()).optional(),
  processes: z.array(processSchema).optional(), // Per-process port configs from ecosystem.config
  envFile: z.string().optional(),
  icon: z.string().nullable().optional(),
  editorCommand: z.string().optional(),
  description: z.string().optional()
});

// Partial schema for updates
export const appUpdateSchema = appSchema.partial();

// Provider schema
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
  envVars: z.record(z.string()).optional()
});

// Run command schema
export const runSchema = z.object({
  type: z.enum(['ai', 'command']),
  providerId: z.string().optional(),
  model: z.string().optional(),
  workspaceId: z.string(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  timeout: z.number().int().min(1000).max(600000).optional()
});

/**
 * Validate data against a schema
 * Returns { success: true, data } or { success: false, errors }
 */
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
