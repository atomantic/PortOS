import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { partialWithoutDefaults, emptyToUndefined, emptyToNull } from './zodCompat.js';
import { WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS } from './writersRoomPresets.js';
import { ALL_STYLE_IDS, STYLE_ID } from './writersRoomStylePresets.js';
import { BIBLE_LIMITS, RELATIONSHIP_LINK_TYPES, RELATIONSHIP_OPPOSITION_AXES, ATTACHMENT_ROLES } from './storyBible.js';
import { MIN_TIMEOUT as STAGE_TIMEOUT_MIN_MS, MAX_TIMEOUT as STAGE_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';
import { CHECK_SCOPES, CHECK_SEVERITIES } from './editorial/checkRegistry.js';
import { SHOT_TYPES, SCREEN_DIRECTIONS } from './shotGrammar.js';
import { WORK_TRACKERS } from './workTracker.js';

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

// Reject a record id that isn't a bare filename segment. Use before a
// peer-supplied / externally-sourced id is interpolated into a filesystem path
// (e.g. the sharing importer's raw `join(bucket, …, `${id}.json`)` reads, or
// the conflict journal's `recordDir(id)`), so a `../`-bearing id can't turn the
// read/delete into a path-traversal oracle. Records persisted through a
// collectionStore are already gated by its `idPattern`; this guards the raw
// path sites that don't go through a store.
export const isSafeRecordId = (id) =>
  typeof id === 'string' && id.length > 0
  && id !== '.' && id !== '..'
  && !id.includes('/') && !id.includes('\\') && !id.includes('\0');

// Build a sparse-map Zod shape from a string array of boolean-typed keys.
// Returns the raw record so callers can either spread it (...optionalBooleanMap(KEYS))
// into a larger object schema or wrap it directly (z.object(optionalBooleanMap(KEYS))).
// Mirrors the `{ field?: boolean }` shape used for per-field lock maps.
export const optionalBooleanMap = (keys) =>
  Object.fromEntries(keys.map((k) => [k, z.boolean().optional()]));

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

// partialWithoutDefaults handles the top-level fields; the nested `personality`
// object is also field-merged by updateAgent(), so it needs its own default-free
// partial — otherwise a PATCH of one personality key (e.g. just `style`) injects
// the other keys' defaults and clobbers the stored tone/topics/quirks/promptPrefix.
export const agentUpdateSchema = partialWithoutDefaults(agentSchema).extend({
  personality: partialWithoutDefaults(agentPersonalitySchema).optional(),
});

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

export const platformAccountUpdateSchema = partialWithoutDefaults(platformAccountSchema);

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

export const automationScheduleUpdateSchema = partialWithoutDefaults(automationScheduleSchema);

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
// `lastReviewedSha`, and appends slug-tagged `[ref-watch-…]` checklist items
// to the app's PLAN.md for `/claim` / `plan-task` to pick up. `notes` is the
// free-text "what we use from this repo" field — fed into the review prompt
// so the agent knows which features in our app are load-bearing for the watch.
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
// Workspace Context (#902) — the only input is an app id (the apps-registry
// key, or the fixed 'portos-default' baseline). Mirrors the apps-registry id
// shape: uuid-style ids plus the literal baseline id, so a hand-crafted path
// segment can't reach the service with a junk id.
export const workspaceContextParamsSchema = z.object({
  appId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'invalid app id')
});

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
  datadog: datadogConfigSchema.optional().nullable(),
  // Where this app's autonomous work items live (single source per app).
  // 'auto' (default) resolves to a concrete tracker from the git origin host
  // — see server/lib/workTracker.js + the `claim-work` router in
  // cosTaskGenerator.js. WORK_TRACKERS is the single source of truth for the
  // value set.
  workTracker: z.enum(WORK_TRACKERS).optional()
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
export const appUpdateSchema = partialWithoutDefaults(appSchema);

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

export const socialAccountUpdateSchema = partialWithoutDefaults(socialAccountSchema);

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
// COS TASK SCHEMAS
// =============================================================================

// Reviewer choices for the Review Loop. `copilot` requests a native GitHub
// Copilot review; `claude`/`antigravity`/`codex` instruct the review-loop follow-up
// agent to invoke the named CLI to critique the PR diff; `lmstudio`/`ollama`
// route the diff through PortOS's local code-review endpoint
// (`POST /api/code-review/local`) which runs the configured local LLM model.
// Mirrored in client/src/components/cos/constants.js → REVIEWER_OPTIONS.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'lmstudio', 'ollama'];
export const REVIEWER_ALIASES = { gemini: 'antigravity' };
export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = ['copilot'];
// Reviewers that resolve to a local-LLM backend (rather than a CLI or GitHub
// bot). Used by the code-review endpoint, settings panel, and prompt builder
// to gate model-id resolution.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama'];
// Stop-mode for the multi-reviewer loop (slashdo `--review-stop-on-*`).
export const REVIEW_STOP_MODES = ['all', 'on-findings', 'on-clean'];
export const DEFAULT_REVIEW_STOP_MODE = 'all';

/**
 * Resolve task metadata to an ordered, deduped reviewer list. Prefers the new
 * `reviewers` array; falls back to the legacy single `reviewer` string. When
 * the metadata yields nothing, returns `fallback` (default `['copilot']`) —
 * pass the settings-resolved defaults here so a Review Loop run picks up the
 * user's Code Review Defaults instead of the hardcoded copilot when the task
 * itself didn't pin reviewers. Filters to known reviewers and preserves
 * first-occurrence order.
 */
export function normalizeReviewers(meta, fallback = DEFAULT_REVIEWERS) {
  const raw = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const source = Array.isArray(raw.reviewers)
    ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const seen = new Set();
  const out = [];
  for (const r of source) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  if (out.length) return out;
  const fallbackList = [];
  const fallbackSeen = new Set();
  for (const r of Array.isArray(fallback) ? fallback : []) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !fallbackSeen.has(normalized)) {
      fallbackSeen.add(normalized);
      fallbackList.push(normalized);
    }
  }
  return fallbackList.length ? [...fallbackList] : [...DEFAULT_REVIEWERS];
}

/**
 * Build the slashdo review flag string for an ordered reviewer list.
 * - `--review-with a,b,c` only when the list isn't the lone default copilot.
 * - `--review-stop-on-*` only when 2+ reviewers (stop-mode is meaningless for one).
 * - `--reviewer-applies` only when a non-copilot reviewer is present (no-op on copilot).
 */
export function buildReviewWithArgs(reviewers, stopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false) {
  const list = normalizeReviewers({ reviewers });
  const isDefaultOnly = list.length === 1 && list[0] === DEFAULT_REVIEWER;
  const hasNonCopilot = list.some(r => r !== DEFAULT_REVIEWER);
  const parts = [];
  if (!isDefaultOnly) parts.push(`--review-with ${list.join(',')}`);
  if (list.length >= 2) {
    if (stopMode === 'on-findings') parts.push('--review-stop-on-findings');
    else if (stopMode === 'on-clean') parts.push('--review-stop-on-clean');
  }
  if (reviewerApplies && hasNonCopilot) parts.push('--reviewer-applies');
  return parts.join(' ');
}

export const createCosTaskSchema = z.object({
  description: z.string().min(1),
  priority: z.string().optional(),
  context: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  app: z.string().optional(),
  type: z.string().optional().default('user'),
  approvalRequired: z.boolean().optional(),
  screenshots: z.array(z.string()).optional(),
  attachments: z.array(z.string()).optional(),
  position: z.enum(['top', 'bottom']).optional().default('bottom'),
  createJiraTicket: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  jiraTicketId: z.string().optional(),
  jiraTicketUrl: z.string().optional(),
  useWorktree: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  openPR: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  simplify: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  reviewLoop: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  reviewer: z.preprocess(
    v => v === '' ? undefined : (typeof v === 'string' ? (REVIEWER_ALIASES[v] ?? v) : v),
    z.enum(REVIEWER_VALUES).optional()
  ),
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
  ),
  reviewStopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
});

export const updateCosTaskSchema = z.object({
  description: z.string().min(1).optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  context: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  app: z.string().optional(),
  blockedReason: z.string().optional(),
  type: z.string().optional().default('user'),
});

// =============================================================================
// LOOP SCHEMAS
// =============================================================================

export const createLoopSchema = z.object({
  prompt: z.string().min(1),
  interval: z.union([z.string().min(1), z.number().positive()]),
  name: z.string().optional(),
  cwd: z.string().optional(),
  providerId: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  timeout: z.number().positive().optional(),
  runImmediately: z.boolean().optional(),
});

// =============================================================================
// COS JOB SCHEMAS
// =============================================================================

export const createCosJobSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['agent', 'shell', 'script']).optional(),
  interval: z.string().optional(),
  intervalMs: z.number().positive().int().optional(),
  scheduledTime: z.string().optional(),
  cronExpression: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.string().optional(),
  autonomyLevel: z.enum(['standby', 'assistant', 'manager', 'yolo']).optional(),
  promptTemplate: z.string().optional(),
  command: z.string().optional(),
  triggerAction: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  // Optional AI provider + model override for agent jobs. Empty string from the
  // UI picker → null so a PUT can actively clear the override back to the active
  // provider/default model (updateJob only skips `undefined`). Forwarded into the
  // generated task's metadata as `provider`/`model` by generateTaskFromJob.
  providerId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  model: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional managed-app scope. Empty string from the UI picker → null so a PUT
  // can actively un-scope a job back to global (updateJob only skips `undefined`,
  // so undefined would silently preserve the old scope). Absent key stays
  // undefined (preserve existing on PUT, default null on create).
  appId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional git-workflow options for app-scoped agent jobs.
  taskMetadata: z.object({
    useWorktree: z.boolean().optional(),
    openPR: z.boolean().optional(),
    simplify: z.boolean().optional(),
  }).optional(),
});

export const updateCosJobSchema = createCosJobSchema.partial().extend({
  weekdaysOnly: z.boolean().optional(),
});

// =============================================================================
// COS LEARNING SCHEMAS
// =============================================================================

export const recordLearningInsightSchema = z.object({
  type: z.string().optional(),
  message: z.string().min(1),
  taskType: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

export const dismissRecommendationSchema = z.object({
  id: z.string().min(1),
  snapshot: z.unknown().optional(),
});

export const restoreRecommendationSchema = z.object({
  id: z.string().min(1),
});

export const generateWeeklyDigestSchema = z.object({
  weekId: z.string().optional(),
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

// Per-API external-access flags (issue: public API surface). Stored under the
// top-level `apiAccess` settings key (client-readable — NOT under `secrets`).
// Drives `server/lib/apiRegistry.js`: an entry that is `exposed && !requireAuth`
// re-opens its public mount even when the PortOS password is on. Both flags are
// optional so a partial PUT only patches what it carries; the registry fills
// absent flags from its per-API defaults (exposed:false, requireAuth:false).
export const apiAccessEntrySchema = z.object({
  exposed: z.boolean().optional(),
  requireAuth: z.boolean().optional(),
}).strict();

export const apiAccessSettingsSchema = z.object({
  voice: apiAccessEntrySchema.optional(),
  sdapi: apiAccessEntrySchema.optional(),
}).strict();

export const restoreRequestSchema = z.object({
  snapshotId: z.string().min(1),
  subdirFilter: z.string().optional().nullable(),
  dryRun: z.boolean().optional().default(true)
});

export const restoreDbRequestSchema = z.object({
  snapshotId: z.string().min(1),
  dryRun: z.boolean().optional().default(true)
});

// CyberCity snapshot pipeline (issue #877): how often to capture a city-state
// frame and how many to retain. Validated as a settings slice on PUT /api/settings;
// service-side defaults (DEFAULT_SNAPSHOT_CONFIG) fill any absent field so an
// install with no `citySnapshots` key still captures.
export const citySnapshotConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
  maxSnapshots: z.number().int().min(10).max(100000).optional()
});

// Shared LoRA-training parameter bounds — used by both the settings-slice
// defaults and the per-run override on POST /api/lora-training/runs.
const loraTrainingParamsSchema = z.object({
  steps: z.number().int().min(10).max(10000).optional(),
  rank: z.number().int().min(1).max(128).optional(),
  learningRate: z.number().positive().max(0.1).optional(),
  resolution: z.union([z.literal(512), z.literal(768), z.literal(1024)]).optional(),
  seed: z.number().int().optional(),
  checkpointEvery: z.number().int().min(0).max(5000).optional(),
  sampleEvery: z.number().int().min(0).max(5000).optional(),
  samplePrompt: z.string().max(2000).optional(),
  // Per-run frozen-base overrides (issue #1321/#1407), mflux runtime only.
  // `baseQuant` picks the quant of the frozen base — 16 = unquantized bf16, 8/4
  // = QLoRA bit-width — letting a run opt into a heavier/lighter base than the
  // memory-derived default without a code change. `lowRam` toggles the on-disk
  // latent-cache spill. `null` is the form's "Auto": a deliberate clear that
  // forces the deriveMfluxMemoryConfig tier even when a saved default exists
  // (distinct from absent, which lets the saved default merge through). An
  // explicit value still cannot exceed the LORA_TRAIN_MAX_QUANT_BITS cap.
  baseQuant: z.union([z.literal(4), z.literal(8), z.literal(16)]).nullable().optional(),
  lowRam: z.boolean().nullable().optional(),
});

// LoRA training settings slice (`settings.loraTraining`) — vision-caption
// provider pick + training parameter defaults. Code-level defaults live in
// `services/loraTraining/runtimes.js` so an absent slice needs no migration.
export const loraTrainingConfigSchema = z.object({
  // Both nullable — the caption-model picker clears them to null on "Auto"
  // (defer to the server's vision-model auto-pick).
  captionProviderId: z.string().max(128).nullable().optional(),
  captionModel: z.string().max(256).nullable().optional(),
  defaults: loraTrainingParamsSchema.optional(),
  // Segmented mflux training (watchdog-panic mitigation, default ON in
  // services/loraTraining/runtimes.js). Setting this false runs the trainer as
  // one sustained process again — flip it once a macOS/mflux update resolves
  // the GPU-driver hang. Cooldown is the GPU idle gap (seconds) between segments.
  segmentation: z.boolean().optional(),
  segmentCooldownSec: z.number().int().min(0).max(3600).optional(),
  // Phase-aware soft-hang stall watchdog (issue #1330, default ON in
  // services/loraTraining/index.js). Detects a wedged GPU mid-training (steps
  // stop arriving within a step-rate-derived budget) and SIGKILLs + auto-resumes
  // from the newest checkpoint. Set false to fall back to only the flat 30-min
  // idle watchdog (e.g. if a future driver fix makes soft hangs impossible).
  stallWatchdog: z.boolean().optional(),
});

// POST /api/lora-training/runs — start a training run for a dataset.
export const startTrainingRunSchema = z.object({
  datasetId: z.string().min(1).max(128),
  baseModelId: z.string().min(1).max(128),
  name: z.string().trim().max(120).optional(),
  params: loraTrainingParamsSchema.optional(),
});

// Query for GET /api/city/snapshots — `since` (ISO timestamp) and `limit`
// (most-recent N) both arrive as strings on the query string.
export const citySnapshotsQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100000).optional()
});

// Per-feature AI provider assignment: which configured CLI provider/model a
// feature runs through (e.g. `settings.autofixer`, `settings.calendarSync`).
// Empty string (UI "unset" sentinel) is coerced to undefined so it round-trips
// as "use the default" rather than a bogus id. Both the autofixer (file edits
// + pm2) and Google Calendar MCP sync require an agentic CLI provider; the
// picker resolution layer (`pickCliProvider`) enforces type 'cli'.
// `emptyToUndefined` now lives in zodCompat.js (so per-domain schema files can
// use it without a cycle through this module) — re-exported for deep imports.
export { emptyToUndefined };
export const featureProviderConfigSchema = z.object({
  providerId: z.preprocess(emptyToUndefined, z.string().optional()),
  model: z.preprocess(emptyToUndefined, z.string().optional()),
});

// Global Code Review Loop defaults (settings.codeReview). Surfaced on the AI
// Providers page; TaskAddForm + ScheduleTab seed from this when the user
// hasn't already chosen a per-task / per-task-type reviewer list. The follow-
// up spawner reads it as the fallback for `reviewers` when none are passed in.
// `lmstudioModel` / `ollamaModel` are the installed model ids the local-LLM
// reviewer should run with (empty/undefined = pick the active default model).
export const codeReviewSettingsSchema = z.object({
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
  ),
  stopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.boolean().optional(),
  lmstudioModel: z.preprocess(emptyToUndefined, z.string().optional()),
  ollamaModel: z.preprocess(emptyToUndefined, z.string().optional()),
}).strict();

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

// Phase 5 live-mode opt-in (per work). `enabled` gates the editor's
// background continuation suggestions; `debounceMs` is the client's
// idle-after-typing throttle before it asks; `dailyCallBudget` caps how many
// suggest calls the server will run per UTC day (0 = unlimited);
// `dailyRenderBudget` is the distinct cap on live render previews (renders cost
// materially more than text, so they get their own knob). The server-tracked
// `usage` / `renderUsage` counters are NOT user-editable — they're bumped by
// the suggest / render-reserve paths and reset on a new day — so they live
// outside this update schema (mirrors how `pipelineSeriesId` is set by
// linkToPipeline, not updateWork).
export const writersRoomLiveModeSchema = z.object({
  enabled: z.boolean().default(false),
  debounceMs: z.number().int().min(800).max(30_000).default(2500),
  dailyCallBudget: z.number().int().min(0).max(10_000).default(100),
  dailyRenderBudget: z.number().int().min(0).max(10_000).default(20),
}).strict();

export const writersRoomWorkUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  kind: writersRoomWorkKindSchema.optional(),
  status: writersRoomWorkStatusSchema.optional(),
  folderId: wrIdNullable.optional(),
  imageStyle: writersRoomImageStyleSchema.optional(),
  // partialWithoutDefaults (not .partial()) so a single-knob PATCH doesn't inject
  // the other knobs' defaults and clobber their stored values (Zod 4 .partial()
  // keeps inner defaults — see zodCompat.js). The service field-merges each knob.
  liveMode: partialWithoutDefaults(writersRoomLiveModeSchema).optional(),
}).strict();

// Cursor-context payload for the live continuation suggest route. The three
// prose slices are bounded so a runaway editor can't ship a multi-MB body on
// every keystroke — the server only needs a window around the cursor, not the
// whole manuscript.
export const writersRoomLiveSuggestSchema = z.object({
  before: z.string().max(12_000).optional().default(''),
  after: z.string().max(12_000).optional().default(''),
  selection: z.string().max(8_000).optional().default(''),
}).strict();

// Live render-preview reservation takes no body — the work id is in the path
// and the budget is server-owned. A strict empty object rejects any crafted
// payload (e.g. an attempt to smuggle a usage counter) instead of ignoring it.
export const writersRoomLiveRenderPreviewSchema = z.object({}).strict();

// =============================================================================
// EDITORIAL CHECKS (#1284) — registry-driven editorial review
// =============================================================================
// Per-check enable/config. `config` is a free-form blob validated a second time
// against the check's own Zod `configSchema` in the registry (resolveCheckConfig)
// — this gate just bounds the wire shape so a malformed PATCH can't write junk.
export const editorialCheckConfigSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();

// POST .../editorial/checks/run — run all enabled checks, or a named subset.
// providerId/model are optional overrides forwarded to LLM-kind checks.
export const editorialChecksRunSchema = z.object({
  checkIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).strict();

// User-defined editorial check (#1346). The base authored-field shapes carry NO
// `.default()` so the UPDATE schema (a `.partial()` of them) leaves an omitted
// field unchanged — a defaulted optional would silently RESET the stored value
// on a field-specific PATCH (Zod's `.partial()` keeps the inner `.default()`,
// which still fires when the key is absent). `scope`/`severityDefault` reuse the
// registry's own enums so the wire gate can't drift from `buildCustomCheck`.
const editorialCustomCheckShape = {
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  prompt: z.string().trim().min(1).max(8_000),
  scope: z.enum([...CHECK_SCOPES]),
  category: z.string().trim().max(60),
  severityDefault: z.enum([...CHECK_SEVERITIES]),
};

// Create: label + prompt required; the rest optional with sensible defaults (so
// a new check is fully-formed). The JSON output contract is enforced server-side
// (buildCustomCheckPrompt), so no schema field captures it.
export const editorialCustomCheckCreateSchema = z.object({
  ...editorialCustomCheckShape,
  description: editorialCustomCheckShape.description.optional().default(''),
  scope: editorialCustomCheckShape.scope.optional().default('issue'),
  category: editorialCustomCheckShape.category.optional().default('custom'),
  severityDefault: editorialCustomCheckShape.severityDefault.optional().default('medium'),
}).strict();

// Edit (the id is in the URL): every field optional, NO defaults, so an omitted
// field is left unchanged rather than reset.
export const editorialCustomCheckUpdateSchema = z.object(editorialCustomCheckShape).partial().strict();

// settings.pipelineEditorialChecks slice (validated on PUT /api/settings when
// present). `checks` maps a checkId → its persisted enable/config; `customChecks`
// holds the user-defined check definitions (#1346).
//
// `customChecks` items are gated LENIENTLY (any object, unknown keys preserved):
// the authoring CRUD routes (editorialCustomCheck{Create,Update}Schema) are the
// strict input gate, while this wholesale-settings path must stay forward/older-
// peer compatible — a def carrying a future field (or a newer scope value) must
// not 400 an unrelated settings save. `buildCustomCheck`/`isValidCustomCheckDef`
// decide at read time which stored defs are actually runnable.
// `readinessGate` (#1316) is the editorial health convergence gate the autopilot
// loop + UI read as "manuscript clean": 'noOpenHigh' (default), the stricter
// 'noOpenHighOrMedium', or 'none' (disable). Optional + additive, so older peers
// and a never-configured install fall through to the service default.
export const pipelineEditorialChecksSettingsSchema = z.object({
  checks: z.record(editorialCheckConfigSchema).optional(),
  customChecks: z.array(z.object({}).passthrough()).optional(),
  readinessGate: z.enum(['noOpenHigh', 'noOpenHighOrMedium', 'none']).optional(),
}).strict();

// Cursor-context payload for the CD-bridge suggest route — identical shape to
// the live continuation suggest (the server only needs a window around the
// cursor, not the whole manuscript).
export const writersRoomCdBridgeSuggestSchema = z.object({
  before: z.string().max(12_000).optional().default(''),
  after: z.string().max(12_000).optional().default(''),
  selection: z.string().max(8_000).optional().default(''),
}).strict();

// The reviewed CD-bridge proposal the writer sends into a new Creative Director
// project. Caps align with creativeDirectorTreatmentSchema / creativeDirectorSceneSchema
// so a gate-passing proposal always validates again at setTreatment time. The
// scene shape here is the PROPOSAL subset (intent/prompt/duration); the service
// assigns sceneId/order/useContinuationFromPrior before calling setTreatment.
export const writersRoomCdBridgeSendSchema = z.object({
  proposal: z.object({
    logline: z.string().trim().min(1).max(500),
    synopsis: z.string().trim().min(1).max(5000),
    styleSpec: z.string().max(5000).optional().default(''),
    scenes: z.array(z.object({
      intent: z.string().trim().min(1).max(1000),
      prompt: z.string().trim().min(1).max(8000),
      durationSeconds: z.number().int().min(1).max(10),
    }).strict()).min(1).max(120),
  }).strict(),
}).strict();

export const writersRoomDraftSaveSchema = z.object({
  body: z.string().max(5_000_000), // 5 MB ceiling — well over a long novel in plain text
  // Catalog ingredient ids this draft version references. Optional: when
  // absent the server scans the prose against the work's linked cast and
  // derives the list itself; when present (e.g. a client that already knows
  // the set) it's trusted as the snapshot. Bounded so a malformed body can't
  // balloon the manifest.
  referencedIngredientIds: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
}).strict();

export const writersRoomSnapshotSchema = z.object({
  label: z.string().trim().min(1).max(100).optional()
}).strict();

// A single storyboard shot within `stages.storyboards.scenes[].shots[]` (#1315).
// Validates the known shot fields and the new film-grammar enums (`shotType`,
// `screenDirection`) — each nullable + tolerant of the UI's "not captured"
// sentinel (null) and an empty-string clear (preprocessed to undefined). It is
// `.passthrough()` (NOT strip) because render-time hooks stamp extra fields onto
// a shot (`startFrameJobId`) that must survive a re-PATCH of the scenes array;
// the load-bearing normalization still happens in `sanitizeShot`
// (sceneExtractor.js) on the auto-extract path, but the route validates the
// enums up front so an invalid framing/direction is rejected, not silently kept.
export const storyboardShotSchema = z.object({
  // id / description are optional here (not at the sanitizer) so the route stays
  // as tolerant as `sanitizeShot`, which synthesizes a missing id and drops a
  // description-less shot — the route's job is only to reject a bad enum, not to
  // tighten the existing client contract.
  id: z.string().trim().max(80).optional(),
  // Bound loosely to the UI's textarea limit (maxLength=4000), NOT the
  // sanitizer's SHOT_DESCRIPTION_MAX (2000). The sanitizer truncates a long
  // description to 2000 downstream; the route must not REJECT one the UI lets a
  // user type (2001–4000) — that would turn the previously-passthrough scenes
  // contract into a 400. The route's job here is only to reject a bad enum.
  description: z.string().max(4000).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  continuityFromShotId: z.string().trim().max(80).nullable().optional(),
  shotType: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(SHOT_TYPES).nullable().optional(),
  ),
  screenDirection: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(SCREEN_DIRECTIONS).nullable().optional(),
  ),
}).passthrough();

// A storyboard scene as submitted through the visual-stage PATCH. Kept
// `.passthrough()` so the rich, evolving scene shape (heading, slugline,
// dialogue, sceneVideoJobId, …) flows through untouched — only `shots[]` is
// validated (through storyboardShotSchema) so a bad shotType/screenDirection
// is caught at the route instead of persisting unnormalized.
export const storyboardSceneSchema = z.object({
  shots: z.array(storyboardShotSchema).max(64).optional(),
}).passthrough();

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
// Structured relationship links (#1287). `id` is omitted on POSTs — the
// sanitizer mints it. `type` / `opposition.axis` accept the known enum tokens;
// an unrecognized value (legacy/peer payload) is coerced to `custom` by the
// sanitizer, not rejected here, so older clients never 400. Limits sourced
// from BIBLE_LIMITS so bumping a constant updates Zod automatically.
const wrOppositionField = z.object({
  axis: z.enum(RELATIONSHIP_OPPOSITION_AXES).or(z.string().trim().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_AXIS_MAX)),
  thisRole: z.string().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_ROLE_MAX).optional(),
  targetRole: z.string().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_ROLE_MAX).optional(),
  note: z.string().max(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_NOTE_MAX).optional(),
}).strict();
const wrRelationshipLinksField = z.array(z.object({
  id: z.string().trim().max(64).optional(),
  targetCharacterId: z.string().trim().min(1).max(BIBLE_LIMITS.RELATIONSHIP_TARGET_ID_MAX),
  type: z.enum(RELATIONSHIP_LINK_TYPES).or(z.string().trim().max(BIBLE_LIMITS.RELATIONSHIP_TYPE_MAX)).optional(),
  description: z.string().max(BIBLE_LIMITS.RELATIONSHIP_DESCRIPTION_MAX).optional(),
  opposition: wrOppositionField.nullable().optional(),
  locked: z.boolean().optional(),
}).strict()).max(BIBLE_LIMITS.RELATIONSHIP_LINKS_PER_CHARACTER_MAX);
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
  relationshipLinks: wrRelationshipLinksField.optional(),
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
  relationshipLinks: wrRelationshipLinksField.optional(),
}).strict();

const wrPlaceTextField = z.string().max(2000);
// Inner ZodObject (without refine) — exposed so the Pipeline can `.extend()`
// it; `.refine()` returns a ZodEffects which has no `.extend()`.
const writersRoomPlaceCreateObject = z.object({
  name: z.string().trim().max(200).optional(),
  slugline: z.string().trim().max(200).optional(),
  description: wrPlaceTextField.optional(),
  palette: wrPlaceTextField.optional(),
  era: wrPlaceTextField.optional(),
  weather: wrPlaceTextField.optional(),
  recurringDetails: wrPlaceTextField.optional(),
  notes: wrPlaceTextField.optional(),
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
const placeHasIdentifier = (v) =>
  (v.name && v.name.trim()) || (v.slugline && v.slugline.trim());
export const writersRoomPlaceCreateSchema = writersRoomPlaceCreateObject.refine(
  placeHasIdentifier,
  { message: 'Place requires either a slugline or a name' },
);
export const writersRoomPlaceUpdateSchema = z.object({
  name: z.string().trim().max(200).optional(),
  slugline: z.string().trim().max(200).optional(),
  description: wrPlaceTextField.optional(),
  palette: wrPlaceTextField.optional(),
  era: wrPlaceTextField.optional(),
  weather: wrPlaceTextField.optional(),
  recurringDetails: wrPlaceTextField.optional(),
  notes: wrPlaceTextField.optional(),
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
// Structured object↔character attachment links (#1288). `id` is omitted on
// POSTs — the sanitizer mints it. `role` accepts the known archetype tokens; an
// unrecognized value (legacy/peer payload) is coerced to `custom` by the
// sanitizer, not rejected here, so older clients never 400. Limits sourced from
// BIBLE_LIMITS so bumping a constant updates Zod automatically.
const wrAttachmentsField = z.array(z.object({
  id: z.string().trim().max(64).optional(),
  characterId: z.string().trim().min(1).max(BIBLE_LIMITS.ATTACHMENT_CHARACTER_ID_MAX),
  emotion: z.string().max(BIBLE_LIMITS.ATTACHMENT_EMOTION_MAX).optional(),
  significance: z.string().max(BIBLE_LIMITS.ATTACHMENT_SIGNIFICANCE_MAX).optional(),
  origin: z.string().max(BIBLE_LIMITS.ATTACHMENT_ORIGIN_MAX).optional(),
  role: z.enum(ATTACHMENT_ROLES).or(z.string().trim().max(60)).optional(),
  locked: z.boolean().optional(),
}).strict()).max(BIBLE_LIMITS.ATTACHMENTS_PER_OBJECT_MAX);
export const writersRoomObjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  description: wrObjectTextField.optional(),
  significance: wrObjectTextField.optional(),
  attachments: wrAttachmentsField.optional(),
  notes: wrObjectTextField.optional(),
}).strict();
export const writersRoomObjectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  description: wrObjectTextField.optional(),
  significance: wrObjectTextField.optional(),
  attachments: wrAttachmentsField.optional(),
  notes: wrObjectTextField.optional(),
}).strict();

// Generic bible-entry schemas — re-exports of the writers-room schemas under
// kind-neutral names so the Pipeline routes share the same validation
// surface and funnel through the canonical sanitizer in storyBible.js.
// `placeBibleCreateSchema` is the un-refined ZodObject (not the refined
// `writersRoomPlaceCreateSchema`) so Pipeline can `.extend()` it.
export const characterBibleCreateSchema = writersRoomCharacterCreateSchema;
export const characterBibleUpdateSchema = writersRoomCharacterUpdateSchema;
export const placeBibleCreateSchema = writersRoomPlaceCreateObject;
export const placeBibleUpdateSchema = writersRoomPlaceUpdateSchema;
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
  // .prefault({}) (not .default({})) so the nested field defaults still apply
  // when `schedule` is omitted — Zod 4's .default() no longer re-parses its
  // value, so a bare .default({}) would yield {} instead of the filled object.
  schedule: z.object({
    mode: featureAgentScheduleModeSchema.default('continuous'),
    intervalMs: z.number().int().min(30000).optional(),
    pauseBetweenRunsMs: z.number().int().min(0).default(60000)
  }).prefault({}),
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
    errors: result.error.issues.map(e => ({
      path: e.path.join('.'),
      message: e.message
    }))
  };
}

// =============================================================================
// PROMPT STAGE CONFIG (server/routes/prompts.js PUT /:stage body)
// =============================================================================

// Per-call timeout bounds: STAGE_TIMEOUT_MIN_MS / STAGE_TIMEOUT_MAX_MS are
// imported (aliased) from aiToolkit/constants.js at the top of this file so
// the route validator, the runner (server/lib/stageRunner.js), and the
// toolkit's own provider/run validation all share one source of truth. The
// client mirror in client/src/utils/formatters.js can't import across the
// server boundary — comments on both sides flag the requirement to keep
// them in lockstep.

// Accept either a number or a numeric string (UI inputs frequently serialize
// as strings) and validate the resulting integer. `nullable` lets the client
// clear the override explicitly with `null`; absence leaves it untouched.
export const stageConfigUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  timeout: z.preprocess(
    // Treat empty string as a "clear override" (null). Coerce digit-only
    // strings to numbers so form clients that send "900000" still parse —
    // but reject "1e3" / "1.5" / "0x10" by leaving them as the original
    // string so the inner `.number()` check fails. The digit-only rule
    // (and the `.trim()` before it) mirror `parseTimeoutMs` in
    // client/src/utils/formatters.js and `normalizeTimeout` in
    // server/lib/stageRunner.js so all three reject the same shapes.
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed === '') return null;
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
      }
      return v;
    },
    z.number().int().min(STAGE_TIMEOUT_MIN_MS).max(STAGE_TIMEOUT_MAX_MS).nullable().optional()
  ),
  returnsJson: z.boolean().optional(),
  variables: z.array(z.string()).optional(),
}).strip();
// `.strip()` (Zod default) silently drops unknown keys instead of letting
// them flow into `updateStageConfig`'s `{...existing, ...updatedConfig}`
// spread. Stripping prevents prototype-pollution shapes (`__proto__`,
// `constructor`, `prototype`) and config-key squatting from a client that
// sends an unmodelled field. If a future stage field is added, extend the
// schema rather than reintroducing `.passthrough()`.

// === Local LLM backends (Ollama / LM Studio) ===
export const localLlmBackendSchema = z.enum(['ollama', 'lmstudio']);
// modelId is passed positionally to the `lms` CLI (execFile, no shell) — reject
// a leading dash (would be parsed as a flag) and control chars (NUL / newline).
export const localLlmModelIdSchema = z.string().min(1).max(256)
  .refine((v) => !v.startsWith('-'), { message: 'modelId may not start with "-"' })
  .refine((v) => !/[\0\r\n]/.test(v), { message: 'modelId may not contain control characters (NUL, CR, LF)' });
export const localLlmInstallSchema = z.object({
  backend: localLlmBackendSchema,
  modelId: localLlmModelIdSchema,
});
export const localLlmDeleteSchema = localLlmInstallSchema;
// Memory-management unload: same `backend` + `modelId` shape as install/delete
// so the validator catches the same set of malformed ids (no leading dash,
// no control chars) — those reach Ollama via `/api/generate` body fields and
// then echo into PortOS's emoji-prefixed unload log line.
export const localLlmUnloadSchema = localLlmInstallSchema;
export const localLlmSwitchSchema = z.object({ to: localLlmBackendSchema });
// Migrate moves models from the OTHER backend onto `to` (bidirectional, never
// flips the default marker). `mode` picks how the GGUF lands on disk: 'link'
// hardlinks/shares it (default), 'copy' duplicates it.
export const localLlmMigrateSchema = z.object({
  to: localLlmBackendSchema,
  mode: z.enum(['link', 'copy']).optional().default('link'),
});
export const localLlmInstallBackendSchema = z.object({ backend: localLlmBackendSchema });
export const localLlmOllamaServiceSchema = z.object({ action: z.enum(['start', 'stop', 'enable', 'disable']) });
export const localLlmHuggingFaceSearchSchema = z.object({
  backend: localLlmBackendSchema,
  q: z.string().max(160).optional().default(''),
  category: z.string().max(40).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(30).optional().default(12),
});
export const localLlmPlaygroundOptionsSchema = z.object({
  systemPrompt: z.string().max(8000).optional().default(''),
  temperature: z.coerce.number().min(0).max(2).optional().default(0.3),
  maxTokens: z.coerce.number().int().min(1).max(8192).optional().default(1000),
  timeoutMs: z.coerce.number().int().min(1000).max(600000).optional().default(300000),
});
export const localLlmTestSchema = localLlmPlaygroundOptionsSchema.extend({
  backend: localLlmBackendSchema,
  modelId: localLlmModelIdSchema,
  prompt: z.string().trim().min(1).max(50000),
});
export const localLlmCompareSchema = z.object({
  mode: z.enum(['round-robin', 'parallel']).optional().default('round-robin'),
  prompt: z.string().trim().min(1).max(50000),
  targets: z.array(z.object({
    backend: localLlmBackendSchema,
    modelId: localLlmModelIdSchema,
  })).min(1).max(6),
  options: localLlmPlaygroundOptionsSchema.optional().default({}),
});

/**
 * Validate data against a Zod schema, throwing on failure.
 * Returns parsed data on success, throws ServerError on failure.
 */
export function validateRequest(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const errors = result.error.issues.map(e => ({
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
// CLIENT ERROR REPORT
// =============================================================================

// Browser-emitted error reports (window.onerror + unhandledrejection).
// The field caps here are outer bounds — anything bigger is a runaway producer
// and is refused before validation; the storage-size caps live in
// services/clientErrors.js and are intentionally lower (the Review Hub entry
// is a UI surface, not a forensic log).
export const CLIENT_ERROR_TYPES = ['error', 'unhandledrejection'];
export const clientErrorReportSchema = z.object({
  type: z.enum(CLIENT_ERROR_TYPES),
  message: z.string().min(1).max(2000),
  stack: z.string().max(20000).optional(),
  source: z.string().max(2000).optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(1000).optional(),
});

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

// pr-watcher author-gate values. 'self' = PRs opened by the gh-authenticated
// user (the PortOS operator / their automation); 'others' = everyone else;
// 'any' = no gate. Kept here so both the sanitizer and the prWatcher service
// agree on the vocabulary.
export const PR_AUTHOR_FILTERS = ['any', 'self', 'others'];

// claim-issue author-gate values. 'owner' = only claim issues filed by the
// repository owner/creator (matches the `/claim --issues` default); 'any' =
// claim any open issue regardless of who filed it. Kept here so both the
// sanitizer and the claim-issue prompt-builder agree on the vocabulary.
export const ISSUE_AUTHOR_FILTERS = ['owner', 'any'];

/**
 * Sanitize taskMetadata to an allow-list of agent-option keys. Boolean flags
 * (`useWorktree`/`openPR`/`simplify`/`reviewLoop`/`readOnly`/`reviewerApplies`)
 * are kept only when actually boolean; the review-loop keys are constrained by
 * value — `reviewer` to a known reviewer, `reviewers` to a filtered/deduped list
 * of known reviewers, `reviewStopMode` to a known stop-mode — plus a validated
 * `pipeline` object. Prevents prototype pollution and reserved-field overrides.
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
  // `reviewer` is a legacy single constrained string.
  const normalizedReviewer = REVIEWER_ALIASES[raw.reviewer] || raw.reviewer;
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewer') && REVIEWER_VALUES.includes(normalizedReviewer)) {
    clean.reviewer = normalizedReviewer;
    hasKeys = true;
  }
  // `reviewers` is the ordered multi-reviewer list — filter to known values, dedupe, preserve order.
  if (Array.isArray(raw.reviewers)) {
    const seen = new Set();
    const list = [];
    for (const r of raw.reviewers) {
      const normalized = REVIEWER_ALIASES[r] || r;
      if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); list.push(normalized); }
    }
    if (list.length) { clean.reviewers = list; hasKeys = true; }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewStopMode') && REVIEW_STOP_MODES.includes(raw.reviewStopMode)) {
    clean.reviewStopMode = raw.reviewStopMode;
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewerApplies') && typeof raw.reviewerApplies === 'boolean') {
    clean.reviewerApplies = raw.reviewerApplies;
    hasKeys = true;
  }
  // `prAuthorFilter` gates pr-watcher dispatch on PR authorship — constrained
  // to a known value so a hand-edited config can't smuggle in an arbitrary
  // string the watcher would silently treat as "any".
  if (Object.prototype.hasOwnProperty.call(raw, 'prAuthorFilter') && PR_AUTHOR_FILTERS.includes(raw.prAuthorFilter)) {
    clean.prAuthorFilter = raw.prAuthorFilter;
    hasKeys = true;
  }
  // `issueAuthorFilter` gates claim-issue dispatch on issue authorship —
  // constrained to a known value so a hand-edited config can't smuggle in an
  // arbitrary string the claim flow would silently treat as "owner".
  if (Object.prototype.hasOwnProperty.call(raw, 'issueAuthorFilter') && ISSUE_AUTHOR_FILTERS.includes(raw.issueAuthorFilter)) {
    clean.issueAuthorFilter = raw.issueAuthorFilter;
    hasKeys = true;
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

// Geographic home location for location-aware features — the `weather_now`
// voice tool today, any future location-dependent surface tomorrow. Stored on
// `settings.location`. lat/lon are nullable so the user can clear a saved
// location and fall the consuming tool back to its default. The refine enforces
// both-or-neither so a half-set pair can't pin a nonsensical coordinate
// (e.g. a custom latitude with a default longitude).
export const locationSettingsSchema = z.object({
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
}).strict().refine(
  (d) => (d.lat == null) === (d.lon == null),
  { message: 'Provide both lat and lon, or neither.' },
);

// Provider-agnostic embeddings settings. `provider: 'none'` is the default and
// makes embedText() a no-op — rows persist without an embedding and a future
// admin "Re-embed missing" action backfills. Model is optional so the user can
// pick provider first and choose a model from the live list in the UI.
export const settingsEmbeddingsSchema = z.object({
  provider: z.enum(['ollama', 'lmstudio', 'none']),
  model: z.string().trim().max(200).optional().nullable(),
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
// PIPELINE ISSUE QUERY SCHEMAS
// =============================================================================

// Query params for GET /api/pipeline/series/:id/issues — both are optional;
// when either is present the route returns { items, total, offset, limit }
// instead of the legacy raw array so callers can page large series.
export const issuesListQuerySchema = z.object({
  offset: z.preprocess((v) => (v === undefined ? 0 : Number(v)), z.number().int().min(0)).default(0),
  limit: z.preprocess((v) => (v === undefined ? 1000 : Number(v)), z.number().int().min(1).max(1000)).default(1000),
});


// Per-request LLM provider/model override. Shared by universe-builder expand
// routes and pipeline arc-planning routes. Optional so callers that omit the
// llm field fall back to the server's active provider.
export const llmSchema = z.object({
  provider: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
}).optional();

// =============================================================================
// DOCUMENT EDITING SCHEMAS  (shared by apps.js and gsd.js document routes)
// =============================================================================

/**
 * Body schema for PUT /api/apps/:id/documents/:filename and
 * PUT /api/cos/gsd/projects/:appId/documents/:docName.
 * Both routes accept a content string plus an optional commit message.
 */
export const documentUpdateSchema = z.object({
  content: z.string().max(500000),
  commitMessage: z.string().max(200).optional()
});

// Legacy Export (issue #901) — portable identity bundle. `sections` optionally
// narrows the bundle to a subset of domains; omitted/empty means "all present
// sections". The enum is kept in sync with `legacyExport.js#getSectionKeys()`
// (asserted in legacyExport's tests) — validation.js must not import from
// services (cycle), so the keys are inlined here.
export const LEGACY_EXPORT_SECTIONS = ['identity', 'autobiography', 'brain', 'goals', 'decisions', 'health'];
export const legacyExportSchema = z.object({
  sections: z.array(z.enum(LEGACY_EXPORT_SECTIONS)).optional(),
  // Phase 2: render a `legacy-portrait.pdf` from the section Markdown. Default
  // false — the Markdown/JSON bundle is the primary artifact.
  includePdf: z.boolean().optional()
});

// =============================================================================
// TRANSITIONAL RE-EXPORTS (issue #1151 split)
// =============================================================================
// These domain schema groups moved to their own per-domain files (the
// brainValidation.js pattern); the re-exports keep every existing deep
// `import { x } from '../lib/validation.js'` working. New code should import
// from the domain file (or the barrel's namespace export) directly.
//
// Cycle note: the domain files must NOT import from this module — ESM hoists
// `export * from`, so they evaluate before this module's body runs and any
// value read back from here hits the TDZ. Shared zod primitives they need
// (e.g. `emptyToUndefined`) live in zodCompat.js.
export * from './peerSyncValidation.js';
export * from './creativeDirectorValidation.js';
export * from './storyBuilderValidation.js';
export * from './moodBoardValidation.js';
