import { z } from 'zod';

// =============================================================================
// AGENT PERSONALITY SCHEMAS
// =============================================================================

// Agent personality style
export const personalityStyleSchema = z.enum([
  'professional',
  'casual',
  'witty',
  'academic',
  'creative'
]);

// Agent personality object
export const agentPersonalitySchema = z.object({
  style: personalityStyleSchema,
  tone: z.string().max(500).optional().default(''),
  topics: z.array(z.string().max(100)).default([]),
  quirks: z.array(z.string().max(200)).default([]),
  promptPrefix: z.string().max(2000).optional().default('')
});

// Agent avatar
export const agentAvatarSchema = z.object({
  imageUrl: z.string().url().optional(),
  emoji: z.string().max(10).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
}).optional();

// Full agent schema
export const agentSchema = z.object({
  userId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional().default(''),
  personality: agentPersonalitySchema,
  avatar: agentAvatarSchema,
  enabled: z.boolean().default(true)
});

export const agentUpdateSchema = agentSchema.partial();

// =============================================================================
// PLATFORM ACCOUNT SCHEMAS
// =============================================================================

export const platformTypeSchema = z.enum(['moltbook']);

export const accountCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  username: z.string().min(1).max(100)
});

export const accountStatusSchema = z.enum(['active', 'pending', 'suspended', 'error']);

export const platformAccountSchema = z.object({
  agentId: z.string().min(1),
  platform: platformTypeSchema,
  credentials: accountCredentialsSchema,
  status: accountStatusSchema.default('pending'),
  platformData: z.record(z.unknown()).optional().default({})
});

export const platformAccountUpdateSchema = platformAccountSchema.partial();

// Account registration (when creating new Moltbook account)
export const accountRegistrationSchema = z.object({
  agentId: z.string().min(1),
  platform: platformTypeSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default('')
});

// =============================================================================
// AUTOMATION SCHEDULE SCHEMAS
// =============================================================================

export const scheduleActionTypeSchema = z.enum(['post', 'comment', 'vote', 'heartbeat', 'engage', 'monitor']);

export const scheduleActionSchema = z.object({
  type: scheduleActionTypeSchema,
  params: z.record(z.unknown()).optional().default({})
});

export const scheduleTypeSchema = z.enum(['cron', 'interval', 'random']);

export const scheduleTimingSchema = z.object({
  type: scheduleTypeSchema,
  cron: z.string().optional(),
  intervalMs: z.number().int().min(1000).optional(),
  randomWindow: z.object({
    minMs: z.number().int().min(1000),
    maxMs: z.number().int().min(1000)
  }).optional()
}).refine(
  (data) => {
    if (data.type === 'cron') return !!data.cron;
    if (data.type === 'interval') return !!data.intervalMs;
    if (data.type === 'random') return !!data.randomWindow;
    return false;
  },
  { message: 'Schedule timing must match its type' }
);

export const scheduleRateLimitSchema = z.object({
  maxPerDay: z.number().int().min(1).optional(),
  cooldownMs: z.number().int().min(0).optional()
}).optional();

export const automationScheduleSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  action: scheduleActionSchema,
  schedule: scheduleTimingSchema,
  rateLimit: scheduleRateLimitSchema,
  enabled: z.boolean().default(true)
});

export const automationScheduleUpdateSchema = automationScheduleSchema.partial();

// =============================================================================
// EXISTING SCHEMAS
// =============================================================================

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
  description: z.string().optional(),
  archived: z.boolean().optional().default(false)
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

// =============================================================================
// SOCIAL ACCOUNT SCHEMAS (Digital Twin)
// =============================================================================

export const socialPlatformSchema = z.enum([
  'github', 'instagram', 'facebook', 'linkedin', 'x',
  'substack', 'medium', 'youtube', 'tiktok', 'reddit',
  'bluesky', 'mastodon', 'threads', 'other'
]);

export const socialAccountSchema = z.object({
  platform: socialPlatformSchema,
  username: z.string().min(1).max(200),
  displayName: z.string().max(200).optional(),
  url: z.string().url().optional(),
  bio: z.string().max(2000).optional().default(''),
  contentTypes: z.array(z.string().max(50)).optional().default([]),
  ingestionEnabled: z.boolean().optional().default(false),
  notes: z.string().max(2000).optional().default('')
});

export const socialAccountUpdateSchema = socialAccountSchema.partial();

// =============================================================================
// AGENT TOOLS SCHEMAS
// =============================================================================

export const generatePostSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  submolt: z.string().max(100).optional(),
  providerId: z.string().optional(),
  model: z.string().optional()
});

export const generateCommentSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  postId: z.string().min(1),
  parentId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional()
});

export const publishPostSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  submolt: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(10000)
});

export const publishCommentSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  postId: z.string().min(1),
  content: z.string().min(1).max(5000),
  parentId: z.string().optional()
});

export const engageSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  maxComments: z.number().int().min(0).max(5).optional().default(1),
  maxVotes: z.number().int().min(0).max(10).optional().default(3)
});

export const checkPostsSchema = z.object({
  agentId: z.string().min(1),
  accountId: z.string().min(1),
  days: z.number().int().min(1).max(30).optional().default(7),
  maxReplies: z.number().int().min(0).max(5).optional().default(2),
  maxUpvotes: z.number().int().min(0).max(20).optional().default(10)
});

export const createDraftSchema = z.object({
  agentId: z.string().min(1),
  type: z.enum(['post', 'comment']),
  title: z.string().max(300).optional().nullable(),
  content: z.string().min(1).max(10000),
  submolt: z.string().max(100).optional().nullable(),
  postId: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  postTitle: z.string().max(300).optional().nullable(),
  accountId: z.string().optional().nullable()
});

export const updateDraftSchema = z.object({
  title: z.string().max(300).optional().nullable(),
  content: z.string().min(1).max(10000).optional(),
  submolt: z.string().max(100).optional().nullable()
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
