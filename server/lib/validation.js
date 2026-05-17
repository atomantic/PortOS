import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { ASPECT_RATIOS, QUALITIES, PROJECT_STATUSES, SCENE_STATUSES } from './creativeDirectorPresets.js';
import { WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS } from './writersRoomPresets.js';
import { ALL_STYLE_IDS, STYLE_ID } from './writersRoomStylePresets.js';
import { BIBLE_LIMITS } from './storyBible.js';
import { ARC_SHAPE_IDS, ARC_ROLES } from './storyArc.js';

// gpt-image-2 (codex backend) caps at 3840px per edge and 8,294,400 total
// pixels. Mirror the ceiling for every image-gen route. Local mflux can
// render up to 3840 in principle but is impractically slow past ~2048 — the
// UI's `compatible: ['codex']` filter on the 4K presets keeps those out of
// the local picker. Shared so the cap and refinement message stay identical
// across schemas.
export const MAX_IMAGE_EDGE = 3840;
export const MAX_IMAGE_PIXELS = 8_294_400;
export const imageEdgeSchema = z.number().int().min(64).max(MAX_IMAGE_EDGE).optional();
export const refineImagePixelCap = (d) =>
  !(d.width && d.height) || d.width * d.height <= MAX_IMAGE_PIXELS;
export const PIXEL_CAP_MESSAGE = `Total pixels (width × height) must be ≤ ${MAX_IMAGE_PIXELS.toLocaleString()}`;

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

// Reference-repo entry. Each app can list upstream repos it watches for
// clean-room reimplementation;
// the `reference-watch` scheduled task fetches each one, finds commits since
// `lastReviewedSha`, and produces a REFERENCE_REVIEW.md proposal in the app's
// repo. `notes` is the free-text "what we use from this repo" field — fed
// into the review prompt so the agent knows which features in our app are
// load-bearing for the watch.
export const referenceRepoSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  // Either a clonable URL (https://github.com/owner/repo or scp-style
  // user@host:owner/repo.git) or a local filesystem path. The service
  // detects remote URLs by matching `scheme://` or scp-style
  // `user@host:path` (see isLocalPath in services/referenceRepos.js);
  // anything else is treated as a local path.
  repoUrl: z.string().min(1).max(500),
  branch: z.string().max(120).optional().default('main'),
  // 40-char hex SHA (case-insensitive), or null (no review yet). Validating
  // hex here rather than just length means a bogus PATCH like 'g'.repeat(40)
  // fails fast at the API instead of producing confusing git failures later.
  lastReviewedSha: z.string().regex(/^[0-9a-f]{40}$/i, 'must be a 40-char hex SHA').nullable().optional(),
  lastCheckedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(4000).optional().default(''),
  // Last action's outcome — used by the UI to highlight refs needing
  // attention. 'needs-clone' means the managed clone hasn't been
  // initialized yet (first run will populate it).
  status: z.enum(['ok', 'checking', 'error', 'needs-clone']).optional().default('needs-clone'),
  lastError: z.string().max(2000).nullable().optional(),
  createdAt: z.string().datetime().optional()
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
  // referenceRepos is INTENTIONALLY not part of the create/update API
  // surface. createApp() doesn't persist it and updateApp() (via the
  // omit() in appUpdateSchema) ignores it — the dedicated
  // /api/apps/:appId/reference-repos endpoints own the lifecycle so
  // server-managed fields (status, lastError, createdAt) can't be
  // clobbered through the generic apps API.
});

// Used by routes that POST a NEW reference repo (id/createdAt are server-
// assigned, lastReviewedSha/lastCheckedAt populate after the first check).
// `.trim()` runs before `min(1)` so a name/repoUrl that's just whitespace
// fails validation rather than slipping through and producing confusing
// git failures downstream — matches the project convention used elsewhere
// in this file.
export const referenceRepoCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repoUrl: z.string().trim().min(1).max(500),
  branch: z.string().trim().max(120).optional(),
  notes: z.string().max(4000).optional()
});

// Patch schema — every field optional. `lastReviewedSha` is also accepted
// here so the UI's "mark as reviewed" button (and the post-check service
// path) can pin a SHA. Same trim-before-min-length convention as the
// create schema. lastReviewedSha is hex-validated so a bad PATCH can't
// persist a non-SHA into apps.json.
export const referenceRepoUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  repoUrl: z.string().trim().min(1).max(500).optional(),
  branch: z.string().trim().max(120).optional(),
  notes: z.string().max(4000).optional(),
  lastReviewedSha: z.string().regex(/^[0-9a-f]{40}$/i, 'must be a 40-char hex SHA').nullable().optional()
});

// Partial schema for updates. referenceRepos is intentionally absent
// from appSchema (see comment there) so it can't sneak in via PUT
// either — all ref CRUD goes through /api/apps/:appId/reference-repos.
export const appUpdateSchema = appSchema.partial();

// Provider schema
export const providerSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['cli', 'api', 'tui']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  endpoint: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  defaultModel: z.string().nullable().optional(),
  timeout: z.number().int().min(1000).max(600000).optional(),
  enabled: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(10000).max(1800000).optional()
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

// Used by both the settings PUT route (.partial() for incremental updates) and
// any direct backup-config endpoint. destPath is nullable: the UI persists an
// empty string when the field is cleared, and the route handler treats empty/
// missing destPath as "not configured" rather than rejecting the save.
export const backupConfigSchema = z.object({
  destPath: z.string().nullable().optional(),
  cronExpression: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  excludePaths: z.array(z.string()).optional().default([]),
  disabledDefaultExcludes: z.array(z.string()).optional().default([])
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

export const writersRoomImageStyleSchema = z.object({
  // 'none' (no style applied), 'custom' (user-authored prompt with no preset),
  // or one of the curated preset ids. The resolved prompt text lives on the
  // work — picking a preset later doesn't retroactively change historical
  // works' rendering.
  presetId: z.enum(ALL_STYLE_IDS).default(STYLE_ID.NONE),
  prompt: z.string().max(2000).default(''),
  negativePrompt: z.string().max(2000).default(''),
}).strict();

export const writersRoomWorkUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  kind: writersRoomWorkKindSchema.optional(),
  status: writersRoomWorkStatusSchema.optional(),
  folderId: wrIdNullable.optional(),
  imageStyle: writersRoomImageStyleSchema.optional(),
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

// Character profile fields are all optional on update so the UI can PATCH
// one field at a time. `name` accepts trimmed non-empty when present; all
// other text fields tolerate '' so the writer can deliberately blank a field
// out and have the next analysis re-fill it.
const wrCharTextField = z.string().max(2000);
// Voice id namespace shared by writers-room + pipeline character routes:
// `engine:voiceName` (e.g. `kokoro:af_heart`). Nullable so a UI clear path
// can null it explicitly.
const wrVoiceIdField = z.string().trim().max(200).nullable();
// Wardrobe array (A2). `id` is omitted on POSTs by the UI — the sanitizer
// fills it from the server-side UUID factory. Limits sourced from
// BIBLE_LIMITS so bumping the constant updates Zod automatically.
const wrWardrobeField = z.array(z.object({
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(BIBLE_LIMITS.WARDROBE_NAME_MAX),
  description: z.string().max(BIBLE_LIMITS.WARDROBE_DESCRIPTION_MAX).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict()).max(BIBLE_LIMITS.WARDROBES_PER_CHARACTER_MAX);
export const writersRoomCharacterCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  role: wrCharTextField.optional(),
  physicalDescription: wrCharTextField.optional(),
  personality: wrCharTextField.optional(),
  background: wrCharTextField.optional(),
  notes: wrCharTextField.optional(),
  voiceId: wrVoiceIdField.optional(),
  wardrobes: wrWardrobeField.optional(),
}).strict();
export const writersRoomCharacterUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  role: wrCharTextField.optional(),
  physicalDescription: wrCharTextField.optional(),
  personality: wrCharTextField.optional(),
  background: wrCharTextField.optional(),
  notes: wrCharTextField.optional(),
  voiceId: wrVoiceIdField.optional(),
  wardrobes: wrWardrobeField.optional(),
}).strict();

const wrSettingTextField = z.string().max(2000);
// Inner ZodObject (without refine) — exposed so the Pipeline can `.extend()`
// it; `.refine()` returns a ZodEffects which has no `.extend()`.
const writersRoomSettingCreateObject = z.object({
  name: z.string().trim().max(200).optional(),
  slugline: z.string().trim().max(200).optional(),
  description: wrSettingTextField.optional(),
  palette: wrSettingTextField.optional(),
  era: wrSettingTextField.optional(),
  weather: wrSettingTextField.optional(),
  recurringDetails: wrSettingTextField.optional(),
  notes: wrSettingTextField.optional(),
  // Cluster A — INT/EXT + time-of-day taxonomy. Case-insensitive accept
  // mirrors the sanitizer (`INT`/`int` both normalize to `INT`).
  intExt: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(['INT', 'EXT']),
  ).nullable().optional(),
  timeOfDay: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z.enum(['dawn', 'day', 'dusk', 'night']),
  ).nullable().optional(),
}).strict();
const settingHasIdentifier = (v) =>
  (v.name && v.name.trim()) || (v.slugline && v.slugline.trim());
export const writersRoomSettingCreateSchema = writersRoomSettingCreateObject.refine(
  settingHasIdentifier,
  { message: 'Setting requires either a slugline or a name' },
);
export const writersRoomSettingUpdateSchema = z.object({
  name: z.string().trim().max(200).optional(),
  slugline: z.string().trim().max(200).optional(),
  description: wrSettingTextField.optional(),
  palette: wrSettingTextField.optional(),
  era: wrSettingTextField.optional(),
  weather: wrSettingTextField.optional(),
  recurringDetails: wrSettingTextField.optional(),
  notes: wrSettingTextField.optional(),
  // Cluster A — INT/EXT + time-of-day taxonomy. Case-insensitive accept
  // mirrors the sanitizer (`INT`/`int` both normalize to `INT`).
  intExt: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.enum(['INT', 'EXT']),
  ).nullable().optional(),
  timeOfDay: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z.enum(['dawn', 'day', 'dusk', 'night']),
  ).nullable().optional(),
}).strict();

const wrObjectTextField = z.string().max(2000);
export const writersRoomObjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  description: wrObjectTextField.optional(),
  significance: wrObjectTextField.optional(),
  notes: wrObjectTextField.optional(),
}).strict();
export const writersRoomObjectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  description: wrObjectTextField.optional(),
  significance: wrObjectTextField.optional(),
  notes: wrObjectTextField.optional(),
}).strict();

// Generic bible-entry schemas — re-exports of the writers-room schemas under
// kind-neutral names so the Pipeline routes share the same validation
// surface and funnel through the canonical sanitizer in storyBible.js.
// `settingBibleCreateSchema` is the un-refined ZodObject (not the refined
// `writersRoomSettingCreateSchema`) so Pipeline can `.extend()` it.
export const characterBibleCreateSchema = writersRoomCharacterCreateSchema;
export const characterBibleUpdateSchema = writersRoomCharacterUpdateSchema;
export const settingBibleCreateSchema = writersRoomSettingCreateObject;
export const settingBibleUpdateSchema = writersRoomSettingUpdateSchema;
export const objectBibleCreateSchema = writersRoomObjectCreateSchema;
export const objectBibleUpdateSchema = writersRoomObjectUpdateSchema;

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
// MEDIA COLLECTIONS — bulk add/remove items
// =============================================================================

// `ref` rules mirror server/services/mediaCollections.js#sanitizeItem: ":"
// is the API key separator (`<kind>:<ref>` split on first ":"), so a ref
// containing one would be unaddressable for DELETE/coverKey lookups.
const mediaCollectionItemSchema = z.object({
  kind: z.enum(['image', 'video']),
  ref: z.string().trim().min(1).max(500).refine((s) => !s.includes(':'), {
    message: 'ref may not contain ":"',
  }),
}).strict();

// Remove keys are `<kind>:<ref>` strings the client already addresses items
// by — kept loose here (length cap only) because invalid keys are silently
// ignored by the service. Strict validation would force the client to filter
// stale selections itself.
const mediaCollectionRemoveKeySchema = z.string().min(3).max(520);

// Bulk endpoint: { add?, remove? } — at least one of the two arrays must be
// non-empty so a no-op call surfaces as a 400 instead of an opaque success.
export const mediaCollectionBulkItemsSchema = z.object({
  add: z.array(mediaCollectionItemSchema).max(1000).optional(),
  remove: z.array(mediaCollectionRemoveKeySchema).max(1000).optional(),
}).strict().refine(
  (d) => (Array.isArray(d.add) && d.add.length > 0) || (Array.isArray(d.remove) && d.remove.length > 0),
  { message: 'bulk update requires at least one item in add or remove' },
);

// =============================================================================
// SHARING (cross-network share buckets via cloud-synced folders)
// =============================================================================

export const bucketModeSchema = z.enum(['auto-merge', 'inbox']);

export const bucketCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(2000),
  mode: bucketModeSchema.optional().default('inbox'),
  displayNameOverride: z.string().trim().max(120).optional().nullable(),
  bioOverride: z.string().trim().max(2000).optional().nullable(),
}).strict();

export const bucketUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  mode: bucketModeSchema.optional(),
  displayNameOverride: z.string().trim().max(120).nullable().optional(),
  bioOverride: z.string().trim().max(2000).nullable().optional(),
}).strict();

// Items shape for kind:'media'. Mirrors mediaCollections item key
// — { kind: 'image'|'video', ref: '<filename>' }.
const sharingMediaItemSchema = z.object({
  kind: z.enum(['image', 'video']),
  ref: z.string().min(1).max(500),
}).strict();

export const sharingExportSchema = z.object({
  kind: z.enum(['series', 'universe', 'media']),
  ids: z.array(z.string().min(1).max(120)).max(50).optional(),
  items: z.array(sharingMediaItemSchema).max(200).optional(),
}).strict().refine(
  (data) => {
    if (data.kind === 'media') return Array.isArray(data.items) && data.items.length > 0;
    return Array.isArray(data.ids) && data.ids.length > 0;
  },
  { message: "Provide 'ids' for kind=series|universe, or 'items' for kind=media" },
);

// User-level sharing config — extends settings.json.
export const sharingSettingsPatchSchema = z.object({
  sharingDisplayName: z.string().trim().max(120).optional(),
  sharingBio: z.string().trim().max(2000).optional(),
}).strict();

// Subscription creation: persistent (bucket, record) tuple. Series + universe
// are the subscribable kinds (records that change over time and benefit from
// auto-re-export). Media is one-shot via /buckets/:id/export.
export const subscriptionCreateSchema = z.object({
  bucketId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['series', 'universe']),
  recordId: z.string().trim().min(1).max(120),
}).strict();

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
  // Optional back-pointer to the pipeline issue that spawned this project,
  // used by the stitch step to mix in audio-stage music. Bare CD projects
  // (no pipeline origin) leave this null.
  sourceIssueId: z.string().min(1).max(64).nullable().optional(),
});

// Update is restricted to a few editable fields. modelId / aspectRatio /
// quality / targetDurationSeconds are locked at creation — changing them
// mid-project would invalidate already-rendered segments.
//
// Server-managed fields (timelineProjectId, runs, treatment) are
// intentionally NOT in this schema. timelineProjectId is set only by
// stitchRunner.js — accepting it in PATCH payloads would let a client
// point a CD project at an unrelated user timeline project, which the
// next stitch would silently overwrite via updateTimelineProject.
export const creativeDirectorProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  styleSpec: z.string().max(5000).optional(),
  userStory: z.string().max(10000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  finalVideoId: z.string().max(64).nullable().optional(),
  failureReason: z.string().max(500).nullable().optional(),
  // Toggleable post-creation — only affects future scene renders.
  disableAudio: z.boolean().optional(),
}).strict();

// One scene in the treatment, written by the agent on the treatment task.
export const creativeDirectorSceneSchema = z.object({
  sceneId: z.string().min(1).max(64),
  order: z.number().int().min(0),
  intent: z.string().min(1).max(1000),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(8000).optional().default(''),
  durationSeconds: z.number().min(1).max(10),
  useContinuationFromPrior: z.boolean().default(false),
  sourceImageFile: safeBasename.nullable().optional(),
  // How strongly the source image conditions the i2v render. 1.0 = preserve
  // source closely; lower values give the model more freedom to drift.
  // Null lets the runtime pick — `sceneRunner.js` applies 0.85 as the
  // default for continuation scenes (anchors the next clip to the prior
  // last-frame so renders don't drift hard), and leaves it null otherwise
  // (mlx_video / dgrauet uses its own default).
  imageStrength: z.number().min(0).max(1).nullable().optional(),
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
  prompt: z.string().min(1).max(8000).optional(),
  // Evaluator may adjust per-scene strength on retry — e.g. drop from
  // 0.85 → 0.6 when the seed image is too dominant or raise toward 1.0
  // when continuation drifted.
  imageStrength: z.number().min(0).max(1).nullable().optional(),
  evaluation: z.object({
    score: z.number().min(0).max(1).optional(),
    notes: z.string().max(2000).optional(),
    accepted: z.boolean(),
    sampledAt: z.string().optional(),
  }).nullable().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Create Suite — Importer.
//
// The importer takes a finished prose/script source and reverse-engineers
// universe canon + series arc + issue split. Zod here enforces the wire
// shape; the heavy validation (entry-level field caps, kind-specific
// trimming) lives in storyBible.sanitizeBibleList + storyArc.sanitizeArc so
// commit-side mutations always run through the same sanitizers the rest of
// the pipeline uses. The canon/arc/issue entries below therefore use
// `.passthrough()` — we want every field the LLM picked to reach the
// sanitizer, not get stripped at the schema gate.
// ---------------------------------------------------------------------------

export const IMPORTER_CONTENT_TYPES = Object.freeze([
  'short-story', 'novel', 'screenplay', 'comic-script',
]);

// Hard ceiling at the schema layer; the orchestrator enforces a tighter
// 200K business-rule limit and returns a friendlier error. The 5MB ceiling
// here mirrors writersRoomDraftSaveSchema.
const importerSourceField = z.string().min(1).max(5_000_000);

// Classify endpoint only sees the source — no universe/series context. The
// LLM only consumes the head, so the schema is intentionally minimal.
export const importerClassifySchema = z.object({
  source: importerSourceField,
  providerOverride: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().trim().max(120).optional(),
  ),
}).strict();

export const importerAnalyzeSchema = z.object({
  universeName: z.string().trim().min(1).max(200),
  seriesName: z.string().trim().min(1).max(200),
  contentType: z.enum(IMPORTER_CONTENT_TYPES),
  source: importerSourceField,
  // UI sends `''` for "no override picked"; coerce to undefined so the
  // server's `await getProviderById(undefined)` short-circuit kicks in.
  providerOverride: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().trim().max(120).optional(),
  ),
  targetIssueCount: z.number().int().min(1).max(50).optional(),
}).strict();

// Single canon-entry schema — every per-kind sanitizer (character / place /
// object) only requires a `name`; `.passthrough()` keeps every LLM-emitted
// field (firstAppearance, slugline, palette, …) for the sanitizer.
const importerCanonEntry = z.object({
  name: z.string().trim().min(1).max(BIBLE_LIMITS.NAME_MAX),
}).passthrough();

// Arc shape — every field optional so a partial preview (user cleared some
// fields in the Review step) still validates; sanitizeArc fills in the
// shape-level defaults.
const importerArcShape = z.object({
  logline: z.string().max(500).optional(),
  summary: z.string().max(8000).optional(),
  protagonistArc: z.string().max(4000).optional(),
  themes: z.array(z.string().max(100)).max(20).optional(),
  shape: z.enum(ARC_SHAPE_IDS).optional(),
}).passthrough();

// Season + issue entries used inside the commit payload. Seasons stay
// permissive (sanitizer normalizes numbers + ids + status); issues need
// `title` for createIssue but otherwise let the orchestrator decide.
const importerSeasonEntry = z.object({
  number: z.number().int().min(1).max(99).optional(),
  title: z.string().trim().max(200).optional(),
  logline: z.string().max(500).optional(),
  synopsis: z.string().max(4000).optional(),
  endingHook: z.string().max(1000).optional(),
  episodeCountTarget: z.number().int().min(0).max(999).optional(),
}).passthrough();

const importerIssueEntry = z.object({
  title: z.string().trim().min(1).max(300),
  // Optional — the service's commitImport auto-assigns the next free
  // arcPosition when omitted (mirrors the season.number auto-assign).
  // The wire previously required this, which orphaned the service-side
  // auto-assign as dead code for HTTP callers; making it optional puts
  // wire + service on one contract and keeps the auto-assign reachable.
  arcPosition: z.number().int().min(1).max(9999).optional(),
  // The LLM may legitimately omit arcRole on a B-plot-light volume; gate
  // the enum but allow the field to be missing. Wrap with z.preprocess so
  // an empty string from the UI's "clear" affordance maps to undefined.
  arcRole: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.enum(ARC_ROLES).optional(),
  ),
  // Season the issue belongs to. Optional — orchestrator picks the first
  // season when omitted on a multi-season import.
  seasonNumber: z.number().int().min(1).max(99).optional(),
  logline: z.string().max(500).optional(),
  synopsis: z.string().max(4000).optional(),
  // 500K cap matches the issue's stages.prose.output limit so a long
  // novel chapter can land verbatim. Optional — the LLM may omit the
  // excerpt on some issues. When present, must be non-empty + non-whitespace
  // so it doesn't seed prose.output with whitespace and mark the stage
  // `ready` misleadingly.
  proseExcerpt: z.string().min(1).max(500_000).refine(
    (s) => s.trim().length > 0,
    { message: 'proseExcerpt must contain non-whitespace content' },
  ).optional(),
}).passthrough();

export const importerCommitSchema = z.object({
  universeId: z.string().trim().min(1).max(120),
  seriesId: z.string().trim().min(1).max(120),
  canonSelections: z.object({
    characters: z.array(importerCanonEntry).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX).default([]),
    places: z.array(importerCanonEntry).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX).default([]),
    objects: z.array(importerCanonEntry).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX).default([]),
  }).default({ characters: [], places: [], objects: [] }),
  arc: importerArcShape.nullable().optional(),
  seasons: z.array(importerSeasonEntry).max(50).default([]),
  issues: z.array(importerIssueEntry).min(1).max(50),
  // Replace-mode flag — when true, every existing issue on the series is
  // deleted before the incoming `issues` are created, and `series.arc` +
  // `series.seasons[]` are written verbatim (not merged). Canon is still
  // merged additively even in replace mode — universe canon is shared
  // across series, so a per-series destructive replace would be wrong.
  // Defaults to false to preserve the additive merge behavior.
  replaceMode: z.boolean().optional().default(false),
}).strict();
