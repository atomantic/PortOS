import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { ASPECT_RATIOS, QUALITIES, PROJECT_STATUSES, SCENE_STATUSES } from './creativeDirectorPresets.js';
import { WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS } from './writersRoomPresets.js';

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

// Per-function AI provider/model override
const aiFunctionConfigSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional()
});

// Agent AI config (preferred provider/model, with optional per-function overrides)
export const agentAiConfigSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  content: aiFunctionConfigSchema.optional(),
  engagement: aiFunctionConfigSchema.optional(),
  challenge: aiFunctionConfigSchema.optional()
}).optional();

// Full agent schema
export const agentSchema = z.object({
  userId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional().default(''),
  personality: agentPersonalitySchema,
  avatar: agentAvatarSchema,
  enabled: z.boolean().default(true),
  aiConfig: agentAiConfigSchema
});

export const agentUpdateSchema = agentSchema.partial();

// =============================================================================
// PLATFORM ACCOUNT SCHEMAS
// =============================================================================

export const platformTypeSchema = z.enum(['moltbook', 'moltworld']);

export const accountCredentialsSchema = z.object({
  apiKey: z.string().min(1),
  username: z.string().min(1).max(100),
  agentId: z.string().min(1).optional()    // Moltworld-specific agent ID
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

export const scheduleActionTypeSchema = z.enum([
  'post', 'comment', 'vote', 'heartbeat', 'engage', 'monitor',
  'mw_explore', 'mw_build', 'mw_say', 'mw_think', 'mw_heartbeat', 'mw_interact'
]);

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

// `ports` is an open-ended label→port map so app-specific keys derived from
// *_PORT env vars (coinbaseIpc, geminiIpc, etc.) survive validation alongside
// the well-known labels (api, ui, devUi, cdp, health).
export const processSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  ports: z.record(z.number().int().min(1).max(65535)).optional(),
  description: z.string().optional()
});

// JIRA integration config for apps
export const jiraConfigSchema = z.object({
  enabled: z.boolean().default(false),
  instanceId: z.string().optional(),
  projectKey: z.string().optional(),
  boardId: z.string().optional(),
  issueType: z.string().optional().default('Task'),
  labels: z.array(z.string()).optional().default([]),
  assignee: z.string().optional(),
  epicKey: z.string().optional(),
  createPR: z.boolean().optional().default(true)
});

// DataDog integration config for apps
export const datadogConfigSchema = z.object({
  enabled: z.boolean().default(false),
  instanceId: z.string().optional(),
  serviceName: z.string().optional(),
  environment: z.string().optional()
});

// App schema for registration/update
export const appSchema = z.object({
  name: z.string().min(1).max(100),
  repoPath: z.string().min(1),
  type: z.string().optional().default('express'),
  uiPort: z.number().int().min(1).max(65535).nullable().optional(),
  devUiPort: z.number().int().min(1).max(65535).nullable().optional(),
  apiPort: z.number().int().min(1).max(65535).nullable().optional(),
  // Optional HTTPS port — set by the "Upgrade to TLS" action. When present,
  // the Launch button prefers `https://<host>:<tlsPort>/` over the plain
  // uiPort. See lib/tailscale-https.js for the helper apps use.
  tlsPort: z.number().int().min(1).max(65535).nullable().optional(),
  buildCommand: z.string().max(200).optional(),
  uiUrl: z.string().url().optional(),
  startCommands: z.array(z.string()).optional(),
  pm2ProcessNames: z.array(z.string()).optional(),
  processes: z.array(processSchema).optional(), // Per-process port configs from ecosystem.config
  envFile: z.string().optional(),
  icon: z.string().nullable().optional(),
  appIconPath: z.string().nullable().optional(), // Absolute path to detected app icon image
  editorCommand: z.string().optional(),
  description: z.string().optional(),
  archived: z.boolean().optional(),
  pm2Home: z.string().optional(), // Custom PM2_HOME path for apps that run in their own PM2 instance
  disabledTaskTypes: z.array(z.string()).optional(), // Legacy: migrated to taskTypeOverrides
  taskTypeOverrides: z.record(z.object({
    enabled: z.boolean().optional(),
    interval: z.string().nullable().optional()
  })).optional(), // Per-task overrides: { [taskType]: { enabled, interval } }
  defaultUseWorktree: z.boolean().optional(),
  defaultOpenPR: z.boolean().optional(),
  jira: jiraConfigSchema.optional().nullable(),
  datadog: datadogConfigSchema.optional().nullable()
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
  submolt: z.string().max(100).optional().nullable(),
  status: z.enum(['draft', 'published']).optional(),
  publishedPostId: z.string().optional().nullable(),
  publishedAt: z.string().optional().nullable()
});

// =============================================================================
// MOLTWORLD TOOL SCHEMAS
// =============================================================================

export const moltworldJoinSchema = z.object({
  accountId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  x: z.number().int().min(-240).max(240).optional(),
  y: z.number().int().min(-240).max(240).optional(),
  thinking: z.string().max(500).optional(),
  say: z.string().max(500).optional(),
  sayTo: z.string().optional()
});

export const moltworldBuildSchema = z.object({
  accountId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  x: z.number().int().min(-500).max(500),
  y: z.number().int().min(-500).max(500),
  z: z.number().int().min(0).max(100),
  type: z.enum(['wood', 'stone', 'dirt', 'grass', 'leaves']).optional().default('stone'),
  action: z.enum(['place', 'remove']).optional().default('place')
});

export const moltworldExploreSchema = z.object({
  accountId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  x: z.number().int().min(-240).max(240).optional(),
  y: z.number().int().min(-240).max(240).optional(),
  thinking: z.string().max(500).optional()
});

export const moltworldThinkSchema = z.object({
  accountId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  thought: z.string().min(1).max(500)
});

export const moltworldSaySchema = z.object({
  accountId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  message: z.string().min(1).max(500),
  sayTo: z.string().optional()
});

// =============================================================================
// MOLTWORLD WEBSOCKET SCHEMAS
// =============================================================================

export const moltworldWsConnectSchema = z.object({
  accountId: z.string().min(1)
});

export const moltworldWsMoveSchema = z.object({
  x: z.number().int().min(-240).max(240),
  y: z.number().int().min(-240).max(240),
  thought: z.string().max(500).optional()
});

export const moltworldWsThinkSchema = z.object({
  thought: z.string().min(1).max(500)
});

export const moltworldWsNearbySchema = z.object({
  radius: z.number().int().min(1).max(500).optional()
});

export const moltworldWsInteractSchema = z.object({
  to: z.string().min(1),
  payload: z.record(z.unknown()).optional().default({})
});

export const moltworldQueueActionTypeSchema = z.enum([
  'mw_explore', 'mw_build', 'mw_say', 'mw_think', 'mw_heartbeat', 'mw_interact'
]);

export const moltworldQueueAddSchema = z.object({
  agentId: z.string().min(1),
  actionType: moltworldQueueActionTypeSchema,
  params: z.record(z.unknown()).optional().default({}),
  scheduledFor: z.string().datetime().optional().nullable()
});

// =============================================================================
// GITHUB REPOS SCHEMAS
// =============================================================================

export const githubRepoUpdateSchema = z.object({
  flags: z.record(z.boolean()).optional(),
  managedSecrets: z.array(z.string().min(1)).optional()
});

export const githubSecretSchema = z.object({
  value: z.string().min(1)
});

// =============================================================================
// INSIGHTS SCHEMAS
// =============================================================================

export const insightRefreshSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().optional()
});

// =============================================================================
// SEARCH SCHEMAS
// =============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2).max(200).trim()
});

// =============================================================================
// BACKUP SCHEMAS
// =============================================================================

export const backupConfigSchema = z.object({
  destPath: z.string().min(1),
  cronExpression: z.string().optional(),
  enabled: z.boolean().optional().default(true)
});

export const restoreRequestSchema = z.object({
  snapshotId: z.string().min(1),
  subdirFilter: z.string().optional().nullable(),
  dryRun: z.boolean().optional().default(true)
});

// =============================================================================
// WRITERS ROOM SCHEMAS
// =============================================================================

export const writersRoomWorkKindSchema = z.enum(WORK_KINDS);
export const writersRoomWorkStatusSchema = z.enum(WORK_STATUSES);

// IDs are either null (unfiled / unattached) or a non-empty trimmed string.
// Zod runs chain steps in declared order, so .trim() MUST come before .min(1)
// — otherwise a whitespace-only string passes min(1), then trim() collapses
// it to '' after the guard already accepted it. Same gotcha applies to all
// the .min(1).trim() pairs below.
const wrIdNullable = z.string().trim().min(1).max(100).nullable();

export const writersRoomFolderCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: wrIdNullable.optional(),
  sortOrder: z.number().int().optional()
}).strict();

export const writersRoomWorkCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: writersRoomWorkKindSchema.optional().default('short-story'),
  folderId: wrIdNullable.optional()
}).strict();

export const writersRoomWorkUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  kind: writersRoomWorkKindSchema.optional(),
  status: writersRoomWorkStatusSchema.optional(),
  folderId: wrIdNullable.optional()
}).strict();

export const writersRoomDraftSaveSchema = z.object({
  body: z.string().max(5_000_000) // 5 MB ceiling — well over a long novel in plain text
}).strict();

export const writersRoomSnapshotSchema = z.object({
  label: z.string().trim().min(1).max(100).optional()
}).strict();

export const writersRoomExerciseCreateSchema = z.object({
  workId: wrIdNullable.optional(),
  prompt: z.string().max(2000).optional().default(''),
  durationSeconds: z.number().int().min(60).max(3600).default(600),
  startingWords: z.number().int().min(0).default(0)
}).strict();

export const writersRoomExerciseFinishSchema = z.object({
  endingWords: z.number().int().min(0).optional(),
  appendedText: z.string().max(100000).nullable().optional()
}).strict();

export const writersRoomAnalysisCreateSchema = z.object({
  kind: z.enum(ANALYSIS_KINDS)
}).strict();

// =============================================================================
// FEATURE AGENT SCHEMAS
// =============================================================================

export const featureAgentStatusSchema = z.enum(['draft', 'active', 'paused', 'completed', 'error']);
export const featureAgentScheduleModeSchema = z.enum(['continuous', 'interval']);
export const featureAgentAutonomySchema = z.enum(['standby', 'assistant', 'manager', 'yolo']);
export const featureAgentPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const featureAgentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  persona: z.string().max(5000).optional().default(''),
  appId: z.string().min(1),
  schedule: z.object({
    mode: featureAgentScheduleModeSchema.default('continuous'),
    intervalMs: z.number().int().min(30000).optional(),
    pauseBetweenRunsMs: z.number().int().min(0).default(60000)
  }).default({}),
  goals: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  providerId: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  autonomyLevel: featureAgentAutonomySchema.default('assistant'),
  priority: featureAgentPrioritySchema.default('MEDIUM')
});

// Update schema: all fields optional, no defaults (prevents overwriting existing values)
export const featureAgentUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  persona: z.string().max(5000).optional(),
  appId: z.string().min(1).optional(),
  schedule: z.object({
    mode: featureAgentScheduleModeSchema.optional(),
    intervalMs: z.number().int().min(30000).optional(),
    pauseBetweenRunsMs: z.number().int().min(0).optional()
  }).optional(),
  goals: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  providerId: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  autonomyLevel: featureAgentAutonomySchema.optional(),
  priority: featureAgentPrioritySchema.optional()
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

/**
 * Validate data against a Zod schema, throwing on failure.
 * Returns parsed data on success, throws ServerError on failure.
 */
export function validateRequest(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const errors = result.error.errors.map(e => ({
    path: e.path.join('.'),
    message: e.message
  }));
  throw new ServerError('Validation failed', {
    status: 400,
    code: 'VALIDATION_ERROR',
    context: { details: errors }
  });
}

// =============================================================================
// PAGINATION HELPERS
// =============================================================================

/**
 * Parse limit/offset pagination from query params with defaults and clamping.
 * @param {object} query - req.query object
 * @param {object} options - { defaultLimit, maxLimit }
 * @returns {{ limit: number, offset: number }}
 */
export function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = parseInt(query?.limit, 10);
  const rawOffset = parseInt(query?.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

// =============================================================================
// TASK METADATA SANITIZATION
// =============================================================================

// Agent behavior flags that can be overridden per-pipeline-stage
export const PIPELINE_BEHAVIOR_FLAGS = ['useWorktree', 'openPR', 'simplify', 'reviewLoop'];

// Absolute cap on total agent spawns per task (across all retry types)
export const MAX_TOTAL_SPAWNS = 5;

const ALLOWED_TASK_METADATA_KEYS = [...PIPELINE_BEHAVIOR_FLAGS, 'readOnly'];

/**
 * Sanitize taskMetadata to only allowed agent-option keys with boolean values.
 * Prevents prototype pollution and reserved metadata field overrides.
 * Returns a clean plain object or null if input is empty/invalid.
 */
export function sanitizeTaskMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clean = Object.create(null);
  let hasKeys = false;
  for (const key of ALLOWED_TASK_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === 'boolean') {
      clean[key] = raw[key];
      hasKeys = true;
    }
  }
  // Pass through pipeline config (validated shape: object with stages array)
  if (raw.pipeline && typeof raw.pipeline === 'object' && Array.isArray(raw.pipeline.stages)) {
    clean.pipeline = raw.pipeline;
    hasKeys = true;
  }
  return hasKeys ? { ...clean } : null;
}


// =============================================================================
// CREATIVE DIRECTOR SCHEMAS
// =============================================================================

export const creativeDirectorAspectRatioSchema = z.enum(ASPECT_RATIOS);
export const creativeDirectorQualitySchema = z.enum(QUALITIES);

// Top-level project create. modelId is required because each LTX variant
// has a different speed/VRAM/quality profile and the project locks it at
// creation. targetDurationSeconds is capped at 600 (10 min) per the v1 plan
// — much beyond that and the agent's treatment quality drifts hard.
// Strict basename: rejects path separators and the exact `.`/`..` segments.
// Used for both startingImageFile (project create) and sourceImageFile
// (per-scene) since both feed into `join(PATHS.images, ...)` later. The
// downstream consumers also do a resolve+prefix-check against PATHS.images
// (sceneRunner.js) — that's the real traversal guard; this validator just
// catches the obvious bad values at the route boundary. Note: a substring
// check on `..` would over-reject legitimate names like `my..image.png`,
// so we only reject the exact dot segments and rely on prefix-checks for
// the actual escape protection.
const safeBasename = z.string()
  .max(256)
  .regex(/^[^/\\]+$/, 'must be a basename (no path separators)')
  .refine((v) => v !== '.' && v !== '..',
    'must not be `.` or `..`');

export const creativeDirectorProjectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  aspectRatio: creativeDirectorAspectRatioSchema,
  quality: creativeDirectorQualitySchema,
  modelId: z.string().min(1).max(64),
  targetDurationSeconds: z.number().int().min(5).max(600),
  styleSpec: z.string().max(5000).default(''),
  startingImageFile: safeBasename.nullable().optional(),
  userStory: z.string().max(10000).nullable().optional(),
  // Audio defaults OFF for CD projects — current model audio output is
  // inconsistent across renders and the user can re-enable per-project.
  // (videoGen one-offs still default to enabled.)
  disableAudio: z.boolean().optional().default(true),
  autoAcceptScenes: z.boolean().optional().default(false),
});

// Update is restricted to a few editable fields. modelId / aspectRatio /
// quality / targetDurationSeconds are locked at creation — changing them
// mid-project would invalidate already-rendered segments.
export const creativeDirectorProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  styleSpec: z.string().max(5000).optional(),
  userStory: z.string().max(10000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  finalVideoId: z.string().max(64).nullable().optional(),
  timelineProjectId: z.string().max(64).nullable().optional(),
  failureReason: z.string().max(500).nullable().optional(),
  // Toggleable post-creation — only affects future scene renders.
  disableAudio: z.boolean().optional(),
}).strict();

// One scene in the treatment, written by the agent on the treatment task.
export const creativeDirectorSceneSchema = z.object({
  sceneId: z.string().min(1).max(64),
  order: z.number().int().min(0),
  intent: z.string().min(1).max(1000),
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional().default(''),
  durationSeconds: z.number().min(1).max(10),
  useContinuationFromPrior: z.boolean().default(false),
  sourceImageFile: safeBasename.nullable().optional(),
  status: z.enum(SCENE_STATUSES).default('pending'),
  retryCount: z.number().int().min(0).max(10).default(0),
  renderedJobId: z.string().max(64).nullable().optional(),
  evaluation: z.object({
    score: z.number().min(0).max(1).optional(),
    notes: z.string().max(2000).optional(),
    accepted: z.boolean(),
    sampledAt: z.string().optional(),
  }).nullable().optional(),
});

// The full treatment doc the agent writes after the planning task.
export const creativeDirectorTreatmentSchema = z.object({
  logline: z.string().min(1).max(500),
  synopsis: z.string().min(1).max(5000),
  scenes: z.array(creativeDirectorSceneSchema).min(1).max(120),
});

// Used by the agent when finishing a scene render.
export const creativeDirectorSceneUpdateSchema = z.object({
  // Full SCENE_STATUSES — the evaluator agent flips a scene back to 'pending'
  // (with an updated prompt + bumped retryCount) to request a re-render; see
  // creativeDirectorPrompts.js and completionHook.js's advanceAfterSceneSettled.
  status: z.enum(SCENE_STATUSES).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  renderedJobId: z.string().max(64).nullable().optional(),
  prompt: z.string().min(1).max(2000).optional(),
  evaluation: z.object({
    score: z.number().min(0).max(1).optional(),
    notes: z.string().max(2000).optional(),
    accepted: z.boolean(),
    sampledAt: z.string().optional(),
  }).nullable().optional(),
}).strict();
