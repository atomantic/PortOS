import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { partialWithoutDefaults, emptyToUndefined, emptyToNull } from './zodCompat.js';
import { WORK_TRACKERS } from './workTracker.js';
import { SPRITE_ID_PATTERN, SPRITE_RECORD_KINDS } from '../services/sprites/recordsLogic.js';
import { ANCHOR_DIRECTIONS, SPRITE_DIRECTIONS, TURNAROUND_ID } from '../services/sprites/prompts.js';
import { CHROMA_KEY_HEXES } from '../services/sprites/chromaKey.js';
import {
  WALK_TRACK, AUTHORED_TRACK_FIELDS, TRACK_BOUND_TRIPLES,
} from '../services/sprites/animationTracks.js';
// #3152 — the EFFECTIVE table (compiled `walk` + the user-defined store), so a
// user's track validates against its own bounds and occupies its own contract
// field with no schema edit. The store reads one small JSON config synchronously
// (see its header for why sync is the right answer here), which is what lets the
// schemas below stay module-load constants rather than becoming lazily-built.
import {
  effectiveTrack, getEffectiveAnimationTracks, getEffectiveAnimationTrackIds,
} from '../services/sprites/animationTrackStore.js';
import { QUEUEABLE_IMAGE_MODES } from '../services/imageGen/modes.js';
import { VIDEO_GEN_MODES } from '../services/videoGen/modes.js';
import { RENDER_TARGETS, RENDER_TARGET_BACKEND_AUTO, RECORD_RENDER_MODEL_MAX } from './renderTargets.js';
import { GROK_VIDEO_DURATIONS } from './grokVideoClip.js';
import { PR_COMPLETION_VALUES } from './prDisposition.js';
import { EFFORT_LEVELS } from './providerModels.js';

// Clip lengths grok's image_to_video delivers, as a Zod union built from the
// single shared list (see grokVideoClip.js). `z.literal` per value rather than
// `z.number().refine()` keeps the "expected 6 | 10" error message the
// hand-written union produced. Exported so routes/videoGen.js validates
// `grokDuration` against this same schema instead of rebuilding the union.
export const grokVideoDurationSchema = z.union(
  GROK_VIDEO_DURATIONS.map((d) => z.literal(d)),
);

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

// Layered Intelligence per-app config (the self-improvement loop). Off by
// default; the loop is a user-enabled scheduled automation. `lastRunAt` is
// server-managed run bookkeeping (cadence, not issue memory) but accepted here
// so a round-tripped config doesn't 400. See server/services/layeredIntelligence.js.
export const LAYERED_INTELLIGENCE_SCOPES = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];
export const layeredIntelligenceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(60_000).optional(),
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  sources: z.object({
    goals: z.boolean().optional(),
    // The app's own success/performance metrics doc (METRICS.md in the app repo).
    // Default on: the primary signal for judging a managed app against its goals.
    appMetrics: z.boolean().optional(),
    cosMetrics: z.boolean().optional(),
    healthReport: z.boolean().optional(),
    planMd: z.boolean().optional(),
    openIssues: z.boolean().optional(),
    // The committed backlog (#2698): `plan`-labeled tracker issues / the
    // prioritized Jira backlog / PLAN.md's unchecked items, fed in so the reasoner
    // can suppress a proposal that overlaps work already in scope. Default on.
    plannedWork: z.boolean().optional(),
    // Feedback loop (#2428): feed past LI proposals + their tracker outcomes back
    // into the reasoning prompt. Default on for PortOS, off for managed apps.
    outcomes: z.boolean().optional(),
    // Self-evaluation (#2700): fold LI's own merge rate, already-filed proposal
    // count, and agent-run health back into the prompt so the loop can judge its
    // proposal quality before filing. Default on for PortOS, off for managed apps.
    selfEval: z.boolean().optional(),
    // Custom Layer-1 sources. Discriminated on `type`: a repo-relative `file`,
    // an `http`(s) URL, or a shell `cmd`. All three carry an optional display
    // `label`. gatherSources also re-enforces the file confinement + the
    // http scheme + a cmd timeout at read time (defense in depth).
    custom: z.array(z.discriminatedUnion('type', [
      z.object({
        type: z.literal('file'),
        // A safe repo-relative path — reject absolute paths and `..` traversal so a
        // custom source can't read files outside the app repo into the LLM prompt.
        ref: z.string().min(1).max(500)
          .refine(r => !r.startsWith('/') && !r.split(/[/\\]/).includes('..'), {
            message: 'ref must be a repo-relative path (no leading / and no ".." segments)'
          }),
        label: z.string().max(120).optional()
      }),
      z.object({
        type: z.literal('http'),
        // Only http/https — gatherSources rejects any other scheme at read time too.
        url: z.string().url().max(2000)
          .refine(u => /^https?:\/\//i.test(u), { message: 'url must be http(s)' }),
        label: z.string().max(120).optional()
      }),
      z.object({
        type: z.literal('cmd'),
        cmd: z.string().min(1).max(2000),
        label: z.string().max(120).optional()
      })
    ])).optional()
  }).optional(),
  rules: z.string().max(8000).optional(),
  allowedScopes: z.array(z.enum(LAYERED_INTELLIGENCE_SCOPES)).optional(),
  // Engine-A hand-off: when enabled, a reasoner-marked trivial+safe proposal is
  // also enqueued as an approval-gated CoS coding-agent task. Off by default.
  handoff: z.object({
    enabled: z.boolean().optional()
  }).optional(),
  lastRunAt: z.string().nullable().optional()
});

// Install-level Layered Intelligence settings (data/settings.json, distinct from
// the per-app config above). `trustShellSources` unlocks full-shell custom `cmd`
// sources for the whole install — off by default; when false/absent, custom cmd
// sources are restricted to the allowlisted-binary + shell:false runner. See the
// threat-model comment on runShellCommand in server/services/layeredIntelligence.js
// (issue #2515).
export const layeredIntelligenceSettingsSchema = z.object({
  trustShellSources: z.boolean().optional()
});

export const nativeLaunchSchema = z.object({
  label: z.string().trim().min(1).max(40),
  command: z.string().trim().min(1).max(500),
  processName: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(120)
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
  // Optional native/GUI action shown alongside the standard browser Launch.
  // Its PM2 process exits normally when the user closes the app window.
  nativeLaunch: nativeLaunchSchema.nullable().optional(),
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
    interval: z.string().nullable().optional(),
    // Per-app scheduling fields for handler-backed tasks (e.g. layered-intelligence);
    // persisted by updateAppTaskTypeOverride. Nullable = "clear back to inherit/default".
    // Declared here so a generic PUT /api/apps/:id can't silently strip them (Zod drops
    // unknown keys and updateApp replaces taskTypeOverrides wholesale).
    intervalMs: z.number().positive().nullable().optional(),
    providerId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    taskMetadata: z.record(z.any()).nullable().optional()
  })).optional(), // Per-task overrides: { [taskType]: { enabled, interval, intervalMs, providerId, model, taskMetadata } }
  defaultUseWorktree: z.boolean().optional(),
  defaultOpenPR: z.boolean().optional(),
  defaultPrCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
  jira: jiraConfigSchema.optional().nullable(),
  datadog: datadogConfigSchema.optional().nullable(),
  // Where this app's autonomous work items live (single source per app).
  // 'auto' (default) resolves to a concrete tracker from the git origin host
  // — see server/lib/workTracker.js + the `claim-work` router in
  // cosTaskGenerator.js. WORK_TRACKERS is the single source of truth for the
  // value set.
  workTracker: z.enum(WORK_TRACKERS).optional(),
  // Layered Intelligence per-app config (the self-improvement loop). Full config
  // accepted on create/update; the dedicated updateAppLayeredIntelligence merge
  // (server/services/apps.js) preserves untouched fields on partial PATCHes.
  layeredIntelligence: layeredIntelligenceConfigSchema.optional()
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

// Game studio (#3177): managed-app binding, reusable asset bindings, bundle
// compile, and user-triggered AI feedback.
const gameNameSchema = z.string().trim().min(1).max(120);
const gameAppIdSchema = z.string().trim().min(1).max(128);
const gameAssetIdSchema = z.string().trim().min(1).max(128);

export const gameCreateSchema = z.object({
  appId: gameAppIdSchema,
  name: gameNameSchema,
}).strict();

export const gameUpdateSchema = z.object({
  appId: gameAppIdSchema.optional(),
  name: gameNameSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, {
  message: 'at least one field is required',
});

export const gameSpriteBindingSchema = z.object({
  spriteId: gameAssetIdSchema,
}).strict();

export const gameMusicBindingSchema = z.object({
  trackId: gameAssetIdSchema,
}).strict();

export const GAME_ARTWORK_ROLES = [
  'title-key-art',
  'game-logo',
  'biome-luminous-wilds',
  'biome-mineral-steppe',
  'biome-tide-meadow',
  'loading-screen',
  'other',
];

const gameArtworkFilenameSchema = z.string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i, 'must be a gallery PNG filename')
  .max(255);
const gameArtworkDestinationSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .regex(/\.png$/i, 'must end in .png')
  .refine((value) => !value.startsWith('/') && !value.includes('\\'), 'must be a repo-relative path')
  .refine((value) => !value.split('/').includes('..'), 'must not traverse outside the app repository');

export const gameArtworkBindingSchema = z.object({
  imageFilename: gameArtworkFilenameSchema,
  label: z.string().trim().min(1).max(120),
  role: z.enum(GAME_ARTWORK_ROLES),
  destinationPath: gameArtworkDestinationSchema,
}).strict();

export const gameArtworkBindingUpdateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  role: z.enum(GAME_ARTWORK_ROLES).optional(),
  destinationPath: gameArtworkDestinationSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, {
  message: 'at least one field is required',
});

export const gameArtworkPublishSchema = z.object({
  acknowledgeOverwrite: z.boolean().optional(),
}).strict();

export const gameFeedbackSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  prompt: z.string().trim().min(1).max(4_000),
}).strict();

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
  // Explicit opt-in to attach the API key to an arbitrary (non-local,
  // non-allowlisted) endpoint — mirrors the aiToolkit providerSchema. Guards
  // SSRF / key exfiltration (server/lib/aiToolkit/internal/endpointGuard.js).
  allowCustomEndpoint: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(10000).max(1800000).optional(),
  // Absolute wall-clock ceiling for long-running TUI agents (mirrors the
  // aiToolkit providerSchema; the idle reaper can't bound a busy-but-stuck agent
  // — see DEFAULT_TUI_MAX_RUNTIME_MS in tuiHandshake.js). Min 1min, max 12h.
  tuiMaxRuntimeMs: z.number().int().min(60000).max(43200000).optional()
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

// Goal effectiveness scorecard (#2157).
export const scorecardComputeSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export const scorecardSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  feedBrainDigest: z.boolean().optional(),
  weekStartsOn: z.number().int().min(1).max(7).optional()
});

// Per-goal mapping overrides: { [goalId]: { keywords?, personIds?, subcalendarIds?, enabled? } }.
const scorecardRuleOverrideSchema = z.object({
  keywords: z.array(z.string()).optional(),
  personIds: z.array(z.string()).optional(),
  subcalendarIds: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
});
export const scorecardRulesSchema = z.record(z.string(), scorecardRuleOverrideSchema);

// =============================================================================
// SEARCH SCHEMAS
// =============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2).max(200).trim()
});

// =============================================================================
// MEDIA SKETCH / ANNOTATION SCHEMAS (issue #2036, phase 1)
// =============================================================================

// Vector strokes drawn over a generated image. Points are stored in the
// image's natural-pixel space so they restore exactly regardless of the
// display size (see AnnotationCanvas.jsx). The service (mediaSketches.js)
// re-sanitizes + clamps beyond this schema; the Zod layer rejects the
// obviously-malformed shapes early with a 400.
const sketchPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
});

const sketchStrokeSchema = z.object({
  mode: z.enum(['draw', 'erase']).optional(),
  color: z.string().max(32).optional(),
  size: z.number().positive().max(512).optional(),
  points: z.array(sketchPointSchema).min(1).max(20000)
});

export const mediaSketchSaveSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  strokes: z.array(sketchStrokeSchema).max(5000),
  // Flattened raster (image + strokes) as a PNG data URL. Optional so a caller
  // can persist just the vector layer; the service decodes + stores the bytes.
  png: z.string().startsWith('data:image/png;base64,').optional()
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

// Scheduled Series Autopilot (#2174). Machine-local per-series cron schedules
// that fire `startSeriesAutopilot` unattended — the AI Provider Usage Policy's
// sanctioned "scheduled automation" exception. Stored under the top-level
// `seriesAutopilot` settings key (NOT on the federated series record — a
// schedule that synced to a peer would double-run the same series). Each entry
// is OFF by default (`enabled` defaults false); the run itself still passes
// through the cos-domain autonomy gate + daily budget inside startSeriesAutopilot.
// provider/model are OPTIONAL overrides — when absent the run uses the series'
// own `series.llm` (or the active provider); the scheduler maps them to the
// pipeline's providerOverride/modelOverride. A blank provider/model (UI sentinel
// for "use the series default") is coerced to undefined so it doesn't pin an
// empty string. Other autopilot run options are intentionally NOT accepted here:
// there's no UI producing them, so a scheduled run uses the series' persisted
// defaults for those (add a field only when a control exists to set it).
// Structural cron validator, self-contained so validation.js stays a leaf lib
// (importing the scheduler's isValidCron would pull the eventScheduler graph into
// every suite that mocks validation's deps). Rejects a 5-token-but-out-of-range
// cron like `99 99 * * *` at the PUT boundary (a 400 the UI surfaces) instead of
// letting it be saved+enabled and then silently dropped by activeSchedules —
// which would leave the user with an "enabled" schedule that never fires (#2174).
// Deliberately no less permissive than the scheduler's parser (`*`, ranges,
// lists, steps) so a cron it accepts is never rejected here.
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const isCronPartValid = (part, min, max) => {
  const [range, step] = part.split('/');
  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) return false;
  if (range === '*') return true;
  const [a, b] = range.split('-');
  if (!/^\d+$/.test(a)) return false;
  const av = Number(a);
  if (av < min || av > max) return false;
  if (b !== undefined) {
    if (!/^\d+$/.test(b)) return false;
    const bv = Number(b);
    if (bv < min || bv > max || bv < av) return false;
  }
  return true;
};
export const isValidCronExpression = (expr) => {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) =>
    field.split(',').every((part) => isCronPartValid(part, CRON_FIELD_BOUNDS[i][0], CRON_FIELD_BOUNDS[i][1])));
};

export const seriesAutopilotScheduleSchema = z.object({
  seriesId: z.string().min(1).max(64),
  enabled: z.boolean().optional().default(false),
  cron: z.string().min(1).max(120).refine(isValidCronExpression, 'invalid cron expression'),
  timezone: z.string().min(1).max(64).optional(),
  provider: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(120).optional()),
  model: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(200).optional()),
}).strict();

export const seriesAutopilotSettingsSchema = z.object({
  schedules: z.array(seriesAutopilotScheduleSchema).optional().default([]),
}).strict();

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

// subdirFilter is interpolated into an rsync `--include=${subdirFilter}/***` arg
// (rsync runs shell:false, so this is not shell injection — but `*` would expand
// to `--include=*/***` and defeat the filter chain, and `../foo` would traverse
// out of the snapshot subdir). Restrict to a relative path of safe characters
// with no wildcard, traversal, or absolute segments. Exported as a predicate so
// the restoreSnapshot service guard reuses the exact same rule (mirrors
// isSafeRecordId above) — see issue #1822.
export const isSafeSubdirFilter = (v) =>
  typeof v === 'string'
  && /^[a-z0-9._/-]+$/i.test(v)
  && !v.split('/').includes('..')
  && !v.startsWith('/');

export const subdirFilterSchema = z.string()
  .refine(isSafeSubdirFilter, 'subdirFilter must be a relative path with no wildcard, ".." , or leading "/" segments');

export const restoreRequestSchema = z.object({
  snapshotId: z.string().min(1),
  subdirFilter: subdirFilterSchema.optional().nullable(),
  dryRun: z.boolean().optional().default(true)
});

export const restoreDbRequestSchema = z.object({
  snapshotId: z.string().min(1),
  dryRun: z.boolean().optional().default(true)
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

// Autofixer settings extend the shared provider assignment with its isolation
// controls. `autoPromote` (default off) is the explicit promotion gate: when
// false the autonomous repair only STAGES a validated patch for review; when
// true a validated (and, if set, verified) diff is applied to the live checkout
// and the process restarted. `verifyCommand` runs in the isolated worktree
// before any change reaches live. See autofixer/sandbox.js.
export const autofixerSettingsSchema = featureProviderConfigSchema.extend({
  autoPromote: z.boolean().optional(),
  verifyCommand: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
});

// Music settings slice (#2911). `chiptune` remembers the Track editor's last
// chiptune generation provider/model pin plus the publish preferences (target
// managed app + subdir inside its repo). Reuses the shared feature-provider
// shape so an empty-string picker value normalizes to unset.
export const musicSettingsSchema = z.object({
  chiptune: featureProviderConfigSchema.extend({
    publishAppId: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
    publishSubdir: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  }).partial().optional(),
});

// Creative Director settings slice. Each LLM-backed stage can pin its own
// provider/model instead of inheriting the system default. `evaluation` is a
// direct vision API call (blank = auto-pick a local vision model, else fall
// back to the coding agent); treatment and plan run as CoS agent tasks.
// Reuses the shared feature-provider shape so an empty-string picker value
// normalizes to unset.
export const creativeDirectorSettingsSchema = z.object({
  treatment: featureProviderConfigSchema.partial().optional(),
  plan: featureProviderConfigSchema.partial().optional(),
  evaluation: featureProviderConfigSchema.partial().optional(),
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
// SCAFFOLD (app generator)
// =============================================================================

// Known scaffold templates — the single source of truth for the enum the
// scaffold route accepts. An unknown template MUST be rejected before any
// filesystem write or subprocess spawn (issue #2390), so the route can no
// longer create a target directory for a template it can't actually build.
export const SCAFFOLD_TEMPLATES = [
  'portos-stack',
  'vite-express',
  'vite-react',
  'express-api',
  'ios-native',
  'xcode-multiplatform'
];

// Ports may arrive absent (auto-allocated by the route) or as an explicit
// number. Tolerate the UI '' sentinel as "not provided"; anything else must be
// a valid TCP port so an out-of-range value is rejected deterministically.
const scaffoldPortSchema = z.preprocess(
  emptyToUndefined,
  z.number().int().min(1).max(65535).nullable().optional()
);

// Full request schema for POST /api/scaffold. Validated before the route
// touches the filesystem — template enum, port range, and a name that yields a
// usable directory slug are all enforced up front.
export const scaffoldSchema = z.object({
  name: z.string().trim().min(1).max(100)
    // The route sanitizes name → [a-z0-9-]; a name with no alphanumerics
    // slugifies to an all-dash/empty dirName. Reject it here rather than
    // creating a garbage directory.
    .refine(v => /[a-z0-9]/i.test(v), {
      message: 'name must contain at least one letter or number'
    }),
  template: z.enum(SCAFFOLD_TEMPLATES),
  parentDir: z.string().trim().min(1),
  uiPort: scaffoldPortSchema,
  apiPort: scaffoldPortSchema,
  createGitHubRepo: z.boolean().optional().default(false),
  githubOrg: z.preprocess(emptyToNull, z.string().min(1).nullable().optional())
});

// =============================================================================
// USAGE (devtools usage reports)
// =============================================================================

// Shape AND calendar validity — the regex alone accepts impossible dates like
// 2026-02-30, which would silently return an empty report instead of a 400.
const isoDay = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, { message: 'Not a valid calendar date' });

/**
 * Query params for GET /api/usage — either a preset period or an explicit
 * from/to date range (inclusive, YYYY-MM-DD). Explicit dates win over period.
 */
export const usageQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional()
}).refine((q) => !(q.from && q.to) || q.from <= q.to, { message: 'from must be on or before to' });

/** Body for POST /api/usage/messages — token counts persist forever, so
 * reject non-integer/negative garbage instead of coercing it into counters. */
export const usageMessagesSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().nullish(),
  messageCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative().optional().default(0),
  inputTokenCount: z.number().int().nonnegative().optional().default(0)
});


// =============================================================================
// PORTS
// =============================================================================

// POST /api/ports/check — probe a set of ports for availability.
export const portsCheckSchema = z.object({
  ports: z.array(z.number().int().min(1).max(65535)).min(1)
});

// POST /api/ports/allocate — reserve N free ports. `count` accepts a number or
// a numeric string (the UI may send either) and defaults to 1 when absent,
// matching the prior `parseInt(count) || 1` behavior — but non-numeric garbage
// now 400s instead of silently collapsing to 1. The preprocess only forwards
// number|string so `z.coerce` can't quietly turn a boolean (`true → 1`) or an
// array (`[5] → 5`) into a valid count.
export const portsAllocateSchema = z.object({
  count: z.preprocess(
    (v) => {
      if (v === undefined) return 1;
      return (typeof v === 'number' || typeof v === 'string') ? v : NaN;
    },
    z.coerce.number().int().min(1).max(10)
  )
});

// =============================================================================
// DATA MANAGER
// =============================================================================

// DELETE /api/data/:category — purge a category, or one entry inside it.
// `subPath` names a single top-level entry of the category directory; omitting
// it asks for the whole-directory wipe, which `purgeCategory` only honors for
// `purgeScope: 'category'` entries (#3327). Traversal is still rejected in the
// service by a path.relative containment check — this schema just refuses the
// obviously-wrong shapes (non-string, empty, absurdly long) before that.
export const dataPurgeSchema = z.object({
  subPath: z.string().min(1).max(1024).optional()
});

// =============================================================================
// DATABASE
// =============================================================================

const DB_BACKENDS = ['docker', 'native'];

// POST /api/database/switch — switch active backend, optionally migrating data.
export const databaseSwitchSchema = z.object({
  target: z.enum(DB_BACKENDS),
  migrate: z.boolean().optional()
});

// POST /api/database/{start,stop,destroy} — operate on a named backend.
export const databaseBackendSchema = z.object({
  backend: z.enum(DB_BACKENDS)
});

// POST /api/database/export — export from a specific backend, or (when omitted)
// the active backend.
export const databaseExportSchema = z.object({
  backend: z.enum(DB_BACKENDS).optional()
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
// SHELL
// =============================================================================

// POST /api/shell/sessions/:sessionId/image — hand a photo to whatever is running
// in a shell session. `data` is base64 image bytes; the real ceiling is enforced
// by `saveImageUpload` (MAX_SCREENSHOT_BYTES) against the DECODED buffer, so the
// cap here only refuses a payload too large to be worth decoding. The message cap
// matches the BTW route's — both end up bracket-pasted into the same TUI prompt.
export const shellImageDropSchema = z.object({
  data: z.string().min(1, 'data is required (base64)').max(64 * 1024 * 1024),
  filename: z.string().min(1, 'filename is required').max(255),
  message: z.string().max(5000).optional()
});

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

/**
 * Did the caller explicitly ask for pagination? True when either `limit` or
 * `offset` is present in the query string. Lets a list endpoint stay
 * backward-compatible (return the full array when neither is set) while opting
 * into a bounded `{ items, total, limit, offset }` envelope the moment a client
 * passes a pagination param.
 * @param {object} query - req.query object
 * @returns {boolean}
 */
export function isPaginationRequested(query) {
  return query?.limit !== undefined || query?.offset !== undefined;
}

/**
 * Slice an array into a bounded page using the same limit/offset parsing as
 * `parsePagination`. Returns the page plus the metadata needed to render the
 * envelope every paginated PortOS list endpoint shares.
 * @param {Array} items - the full list (already filtered/sorted by the caller)
 * @param {object} query - req.query object
 * @param {object} options - { defaultLimit, maxLimit }
 * @returns {{ items: Array, total: number, limit: number, offset: number }}
 */
export function paginateArray(items, query, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const { limit, offset } = parsePagination(query, options);
  return { items: list.slice(offset, offset + limit), total: list.length, limit, offset };
}

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

// Grok Imagegen settings slice (`imageGen.grok`) — the Grok Build CLI backend
// (#2859). No model/effort knobs: grok's image tools run on xAI's fixed image
// backend, so only the enable gate, binary path, default aspect ratio, and
// per-mode cleaner flags are stored. `''` sentinels from the UI preprocess to
// undefined (same convention as other CLI provider slices); aspectRatio is
// constrained to the `N:M` shape the grok tool accepts so a hand-edited
// settings.json can't inject arbitrary prompt text.
export const imageGenGrokSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  grokPath: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(500).optional()),
  aspectRatio: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().regex(/^\d{1,2}:\d{1,2}$/, 'aspect ratio must look like 16:9').optional()),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
});

// Shared "valid model id" base — one definition of the shape a cloud-CLI
// model id may take (bounds + charset), derived per consumer below so a
// future tweak (e.g. allowing `@`) lands everywhere at once. Exported for
// route schemas that carry a one-off model override (universe renderSchema).
export const cloudModelIdString = (message) => z.string().trim().max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, message);

const agyImageModelSchema = z.preprocess(
  (v) => (v === '' ? undefined : v),
  cloudModelIdString('model must be a valid Agy model id').optional(),
);

// Per-surface render defaults (`settings.renderDefaults`, #3231 Phase 2) —
// one optional entry per render target, each pinning a backend and/or a cloud
// model for that surface. `'auto'`, `''`, and null all mean "no pin — fall
// through to the install default" (renderTargetDefaults normalizes them).
// Deliberately TOLERANT of unknown keys at both levels (no `.strict()`): the
// Settings UI round-trips the WHOLE stored object on every save, so after a
// version rollback (or a newer client against an older server) a target/field
// this build doesn't know would otherwise 400 every Image Gen save until the
// user hand-edits settings.json — the same forward-compat call the settings
// route makes for catalogUserTypes. The route persists the raw body, so a
// newer build's pins survive the round-trip intact rather than being dropped.
// Known fields keep full enum/charset enforcement (that's what stops a bad
// model id reaching a CLI argv); the client mirror's parity test guards the
// known-key alphabet.
const renderTargetModelSchema = z.preprocess(
  (v) => (v === '' ? null : v),
  cloudModelIdString('model must be a valid model id').nullable().optional(),
);
// Shared by the per-target entries and `videoGenSettingsSchema.mode` below —
// one copy of the video-backend pin alphabet.
const videoModePinSchema = z.enum([RENDER_TARGET_BACKEND_AUTO, ...VIDEO_GEN_MODES]).nullable().optional();
const renderTargetEntrySchema = z.object({
  imageMode: z.enum([RENDER_TARGET_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES]).nullable().optional(),
  imageModel: renderTargetModelSchema,
  videoMode: videoModePinSchema,
  videoModel: renderTargetModelSchema,
});
export const renderDefaultsSettingsSchema = z.object(
  Object.fromEntries(RENDER_TARGETS.map((t) => [t, renderTargetEntrySchema.optional()])),
);

// Install-wide video render pin (`settings.videoGen`, #3231 Phase 4) — the
// third rung in resolveVideoMode's ladder (request → target pin → THIS →
// local). `'auto'`/`''`/null all mean "no pin — local". Tolerant of unknown
// keys for the same rollback/forward-compat reason as renderDefaults above.
// `defaultModelId` predates this schema (pipeline storyboards/episodeVideo
// read it as the local-model default) — typed here so a Settings save can't
// write junk to it.
export const videoGenSettingsSchema = z.object({
  mode: videoModePinSchema,
  defaultModelId: z.preprocess(emptyToNull, z.string().trim().max(64).nullable().optional()),
});

// Per-RECORD render pin (#3231 Phase 3) — the flat `imageMode`/`imageModelId`
// field pair persisted on universe / series / sprite records, following the
// creative-commission shape. Spread into a record's create + patch schemas.
// Absent preserves; `'auto'`/`''`/null clears (the sanitizers collapse all
// three to "no pin"). The model id keeps the shared cloud-model charset so a
// pinned id can safely reach a CLI argv.
export const recordRenderPinFields = {
  imageMode: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum([RENDER_TARGET_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES]).nullable().optional(),
  ),
  imageModelId: z.preprocess(
    (v) => (v === '' ? null : v),
    cloudModelIdString('model must be a valid model id').max(RECORD_RENDER_MODEL_MAX).nullable().optional(),
  ),
};

export const imageGenAgySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  agyPath: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(500).optional()),
  model: agyImageModelSchema,
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
});

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

// Video downloader (#1946) — paste a YouTube/x.com URL, download the full
// video. The host allowlist is enforced in the service (assertSupportedVideoUrl)
// so the error names the supported hosts; the schema just guards the shape.
export const videoDownloadSchema = z.object({
  url: z.string().url().max(2048)
});

// Animation-track-aware bounds (#3015). Frame-count / fps ranges are per track,
// not global, so the factories below take a track id and build the range from
// that track's registry row. An absent id is the default (walk) track, which is
// what keeps every pre-#3015 schema identical; an unrecognized one throws out of
// `getAnimationTrack` at schema-CONSTRUCTION time, so a mis-keyed track is a
// boot failure naming the known tracks rather than a range that silently
// validates a scanner action against walk's 6–16.
//
// There is deliberately no exported `track` field schema yet: no request shape
// carries a track id until the first second track lands, and an exported-but-
// unwired validator is false confidence.
export function spriteTrackFrameCountSchema(track) {
  const row = effectiveTrack(track);
  return z.number().int().min(row.minFrameCount).max(row.maxFrameCount);
}

export function spriteTrackFpsSchema(track) {
  const row = effectiveTrack(track);
  return z.number().int().min(row.minFps).max(row.maxFps);
}

// Sprite Manager (issue #2895, phase 1). Import runs against a local
// filesystem path the user supplies (the source pipeline checkout); the
// importer validates the tree shape server-side. The id pattern is owned by
// recordsLogic.js (ids double as data/sprites/ directory names) — a pure,
// dependency-free module, so importing it here can't disturb mocked suites.
export const spriteImportRequestSchema = z.object({
  sourceRoot: z.string().min(1).max(1024),
  characters: z.array(z.string().regex(SPRITE_ID_PATTERN)).optional(),
  includeProps: z.boolean().optional(),
});

// Delete one on-disk asset by its record-relative `path` (the same value the
// listing and static route use). Shape gate only — confinement, the live-atlas
// refusal, and the per-record write tail are the service's job (assets.js).
export const spriteAssetDeleteSchema = z.object({
  path: z.string().min(1).max(1024),
});

export const spriteRecordUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // Reclassify an existing record between the noun kinds (#2932). `props` is
  // accepted so an imported family round-trips without a 400, but the UI never
  // creates one. Schema-parity with spriteCreateSchema below.
  kind: z.enum(SPRITE_RECORD_KINDS).optional(),
  notes: z.string().max(10000).nullable().optional(),
  // Fixed three-key set (#2895 decision) — manual override is limited to the
  // same keys the auto-selection picks from. Imported legacy records keep
  // whatever hex they carried (the importer writes via upsert, not this
  // schema); null clears back to auto-select-on-lock.
  chromaKey: z.enum(CHROMA_KEY_HEXES).nullable().optional(),
  // Per-record render pin (#3231 Phase 3) — this sprite's default image
  // backend + cloud model for reference renders.
  ...recordRenderPinFields,
});

// Phase 4 (issue #2898): publish binding — the shape check only; app
// existence and repo path anchoring are the publish service's job (they need
// filesystem + apps access). Repo-relative paths, no traversal, no absolutes.
const spriteRepoRelativePath = z.string().min(1).max(1024)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'), {
    message: 'must be a repo-relative path with no traversal',
  });

// The grid the consuming app was built against (#2982). Optional: an absent
// contract publishes unchecked, exactly as bindings did before it existed.
// A directional consumer names `walkFrameCount`; an ambient-only consumer names
// `ambientFrameCount`. Playback speed is deliberately absent: consumers own
// timing, so PortOS's fps is preview-only and never part of the contract.
//
// The per-track frame-count keys are BUILT from the registry (#3136) rather than
// named one by one: each row already declares the `contractFrameCountField` it
// occupies, and `assertAnimationTrackRows` refuses two rows claiming the same
// one, so deriving the schema from those declarations is what lets a
// user-defined track's contract field validate against ITS bounds with no schema
// edit. Before this, adding a track meant remembering to add a fourth literal
// here — and forgetting meant the field was silently stripped by Zod and the
// app rung of the target-precedence chain went dead for that track.
const spriteTrackContractFields = Object.fromEntries(
  Object.values(getEffectiveAnimationTracks())
    .map((row) => [row.contractFrameCountField, spriteTrackFrameCountSchema(row.id).optional()]),
);

// The tracks whose frame count is enough ON ITS OWN to make a contract
// meaningful — a record can't be published without one of these authored, so a
// contract that pins none of them describes no atlas that could ever exist. The
// registry DECLARES this per row (`standaloneContract`), which reproduces the
// historical "walkFrameCount or ambientFrameCount" rule and stays correct for a
// user-defined track. It is the same field `atlas.js` dispatches its compile
// evidence chain on, so publish validation and compile can't disagree.
const SPRITE_STANDALONE_CONTRACT_FIELDS = Object.values(getEffectiveAnimationTracks())
  .filter((row) => row.standaloneContract)
  .map((row) => row.contractFrameCountField);

export const spriteRuntimeContractSchema = z.object({
  // Ranges come from each track's registry row (#3015/#3136). `walkFrameCount`
  // and its siblings are spread in from `spriteTrackContractFields` above —
  // `grep walkFrameCount` finds the row in animationTracks.js that names it.
  ...spriteTrackContractFields,
  cellSize: z.number().int().min(16).max(1024).nullable().optional(),
  columnCount: z.number().int().min(1).max(256).nullable().optional(),
}).superRefine((value, ctx) => {
  // An empty set means no registered track is a publishable baseline. The boot
  // guard in `assertAnimationTrackRows` makes that unreachable today (it
  // requires exactly one per record kind), but this schema must not silently
  // become "any contract passes" if that ever changes — with `[0]` undefined,
  // `path: [undefined]` and an empty message would report a rejection nothing
  // could act on. Refuse the whole contract with a message naming the cause.
  if (!SPRITE_STANDALONE_CONTRACT_FIELDS.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'No animation track declares itself a publishable baseline (standaloneContract) — a runtime contract cannot be validated',
    });
    return;
  }
  if (SPRITE_STANDALONE_CONTRACT_FIELDS.every((field) => value[field] === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [SPRITE_STANDALONE_CONTRACT_FIELDS[0]],
      message: `${SPRITE_STANDALONE_CONTRACT_FIELDS.join(' or ')} is required for a runtime contract`,
    });
  }
});

export const spritePublishBindingSchema = z.object({
  appId: z.string().min(1).max(200),
  atlasDestPath: spriteRepoRelativePath.refine((p) => p.toLowerCase().endsWith('.png'), {
    message: 'atlasDestPath must point at a .png atlas file',
  }),
  portraitDestPath: spriteRepoRelativePath.refine((p) => p.toLowerCase().endsWith('.png'), {
    message: 'portraitDestPath must point at a .png image file',
  }).nullable().optional(),
  presentationIdleDestPath: spriteRepoRelativePath.refine((p) => p.toLowerCase().endsWith('.png'), {
    message: 'presentationIdleDestPath must point at a .png sprite strip',
  }).nullable().optional(),
  codeBinding: z.object({
    path: spriteRepoRelativePath,
    resourcePath: z.string().min(1).max(1024),
    requiredOccurrenceCount: z.number().int().min(1).max(1000).optional(),
  }).nullable().optional(),
  // Absent (key omitted) inherits the stored contract; explicit null clears it
  // — see setPublishBinding. Keep the two distinguishable: `.optional()` must
  // stay separate from `.nullable()` here.
  runtimeContract: spriteRuntimeContractSchema.nullable().optional(),
}).nullable();

// acknowledgeOverwrite: explicit consent to replace a destination atlas
// PortOS never published (409 PUBLISH_DEST_OCCUPIED otherwise).
export const spriteAtlasPublishSchema = z.object({
  acknowledgeOverwrite: z.boolean().optional(),
});

// Optional per-compile geometry overrides (player default: 96px cells,
// pivot (48,88), 86×74 content bounds). Columns/rows are the fixed contract.
export const spriteAtlasCompileSchema = z.object({
  geometry: z.object({
    cellSize: z.number().int().min(16).max(1024).optional(),
    pivot: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    targetMaxHeight: z.number().int().min(8).max(1024).optional(),
    targetMaxWidth: z.number().int().min(8).max(1024).optional(),
  }).optional(),
});

// Phase 2 (issue #2896): reference workflow. prompts.js / chromaKey.js are
// pure sprite modules (like recordsLogic.js) so importing their constants
// here can't disturb mocked suites; modes.js is the dependency-free image-gen
// enum module.
export const spriteCreateSchema = z.object({
  id: z.string().regex(SPRITE_ID_PATTERN).optional(),
  name: z.string().trim().min(1).max(200),
  // Noun taxonomy (#2932): the UI's New Sprite panel picks character/place/
  // object. `props` is accepted for parity with the enum but stays import-only
  // in practice. Absent → the service defaults to 'character'.
  kind: z.enum(SPRITE_RECORD_KINDS).optional(),
  spec: z.record(z.string(), z.unknown()).nullable().optional(),
  // Per-record render pin (#3231 Phase 3) — seedable at create time (fork).
  ...recordRenderPinFields,
});

// 'turnaround' is the identity root of the turnaround-first workflow (#2979) —
// generated and locked before the main, which the anchors then descend from.
const spriteReferenceTargetSchema = z.enum([TURNAROUND_ID, 'main', ...ANCHOR_DIRECTIONS]);

// Multipart callers send numbers as form-field strings — coerce before range
// checks ('' → undefined so an empty field doesn't become 0).
const optionalUnitNumber = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : Number(v)),
  z.number().min(0).max(1).optional(),
);

export const spriteReferenceGenerateSchema = z.object({
  target: spriteReferenceTargetSchema,
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  model: z.string().trim().max(64).optional(),
  effort: z.string().trim().max(32).optional(),
  designPrompt: z.string().max(4000).optional(),
  // Extra free-text guidance appended to a turnaround or anchor re-roll (e.g.
  // "no pocket on the right sleeve") so regenerating diverges from the
  // previous render instead of reproducing the same mistake.
  correctionPrompt: z.string().max(4000).optional(),
  // Re-process one existing turnaround candidate with a correction note. The
  // service validates that this is a real turnaround candidate owned by the
  // record before using it as the i2i seed.
  initImageCandidate: z.string().trim().max(500).optional(),
  initImageStrength: optionalUnitNumber,
  // Alternative i2i seed sources for the main target — resolved server-side and
  // mutually exclusive with an uploaded `referenceImage` file (which the route
  // handles separately). `initImageGalleryFile` is a render-history gallery
  // basename; `initImageSpriteId` is another sprite whose locked main reference
  // seeds this one (the "fork"/derive-from case). Ignored for anchor targets.
  initImageGalleryFile: z.string().trim().max(300).optional(),
  initImageSpriteId: z.string().trim().max(200).optional(),
});

// Fork a new character from an existing sprite's locked main reference: create
// the record, then image+text→image its main from the source reference. The
// design prompt is REQUIRED here (unlike a from-scratch generate) — a fork with
// no instructions is just a duplicate.
export const spriteForkSchema = z.object({
  name: z.string().trim().min(1).max(200),
  id: z.string().trim().max(200).optional(),
  designPrompt: z.string().trim().min(1).max(4000),
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  model: cloudModelIdString('model must be a valid model id').max(RECORD_RENDER_MODEL_MAX).optional(),
  effort: z.string().trim().max(32).optional(),
  initImageStrength: optionalUnitNumber,
});

export const spriteReferenceLockSchema = z.object({
  target: spriteReferenceTargetSchema,
  candidate: z.string().min(1).max(500),
  // Confirm-through for a clip-risk main lock (409 CHROMA_CLIP_RISK otherwise).
  acceptClipRisk: z.boolean().optional(),
});

// Only the seven turnaround-derived anchors can be revised in place. The
// turnaround and main remain frozen identity evidence, and south is the main.
export const spriteReferenceUnlockSchema = z.object({
  direction: z.enum(ANCHOR_DIRECTIONS),
});

// Phase 3 (issue #2897): walk-animation workflow. All 8 directions are
// animatable (south's anchor is the frozen main itself).
const spriteWalkDirectionSchema = z.enum(SPRITE_DIRECTIONS);

// Any run the walk state can resolve — which is every run id PortOS actually
// hands the client, not just the native `walk-<dir>-<hex>` shape: an imported
// run's id is its source-named directory slug (`run-3`), and a redraw run's id
// is a record-relative manifest path. Every service behind this resolves the id
// against server-owned walk state and dereferences only paths that state itself
// recorded (through resolveSpriteAssetPath), so the schema bounds shape and
// length only — the shared `isSafeSubdirFilter` predicate (safe charset, no `..`
// segment, no leading `/`), so a hardening tweak there reaches these routes too.
const spriteResolvableRunIdSchema = z.string().min(1).max(1024)
  .refine(isSafeSubdirFilter, { message: 'invalid run id' });

// Walk-cycle authoring bounds — built from the walk row of the sharp-free
// animation-track registry so the request schema and the server-side clamp
// share ONE range definition (a bounds change can't silently diverge).
// animationTracks pulls in no deps at all, native or otherwise.
const spriteWalkFrameCountSchema = spriteTrackFrameCountSchema(WALK_TRACK);
const spriteWalkFpsSchema = spriteTrackFpsSchema(WALK_TRACK);

export const spriteWalkGenerateSchema = z.object({
  direction: spriteWalkDirectionSchema,
  // Clip length in seconds; the service defaults to 6s when omitted. Only
  // affects how much source footage the packer can choose from — the cycle's
  // look is set by frameCount/fps below.
  duration: grokVideoDurationSchema.optional(),
  // Deterministic-postprocess knobs (not grok's): how many frames the packed
  // cycle holds and how fast it plays back. Omitted → the set's pinned cycle
  // target; a value that DISAGREES with that target is refused with 409
  // WALK_TARGET_MISMATCH (#2985), since every direction in one atlas must share
  // the geometry.
  frameCount: spriteWalkFrameCountSchema.optional(),
  fps: spriteWalkFpsSchema.optional(),
  // Free-text guidance appended to a re-roll's motion prompt (#3134) — the same
  // additive correction the reference/anchor renders take. Absent or blank
  // leaves the prompt byte-identical to a blind regenerate.
  correctionPrompt: z.string().max(4000).optional(),
});

// Non-walk animation tracks share ONE generate/approve request shape, built per
// track from its registry row (#3136) — `scanner` gets 2–8 frames / 2–12fps and
// `ambient` gets 2–6 / 2–12 from the same factory, so a user-defined track needs
// no schema edit at all. Two facts make one shape work for both:
//
//   - `direction` is OPTIONAL here even for a directional track, because the
//     route builds the schema for the track it resolved and a non-directional
//     one derives row 0 server-side. The route requires it (below) exactly when
//     the resolved row is directional, so a directional generate can't slip
//     through without a facing — that check reads the same registry the bounds
//     came from, rather than being restated as a second enum.
//   - the remaining knobs are already registry-derived.
const buildSpriteTrackGenerateSchema = (track) => z.object({
  direction: spriteWalkDirectionSchema.optional(),
  duration: grokVideoDurationSchema.optional(),
  frameCount: spriteTrackFrameCountSchema(track).optional(),
  fps: spriteTrackFpsSchema(track).optional(),
  correctionPrompt: z.string().max(4000).optional(),
});

// One schema per registered track, built at module load — the same
// derive-from-the-registry idiom `spriteTrackContractFields` uses, rather than
// re-allocating six Zod objects on every generate request.
const SPRITE_TRACK_GENERATE_SCHEMAS = Object.fromEntries(
  getEffectiveAnimationTrackIds().map((id) => [id, buildSpriteTrackGenerateSchema(id)]),
);

/**
 * The generate schema for one track. Unregistered ids build on demand so the
 * unknown-track error still comes from `getAnimationTrack` (naming the known
 * tracks) rather than reading as "no schema" — though the route validates
 * `trackId` against the registry first, so that path is defense in depth.
 */
export function spriteTrackGenerateSchema(track) {
  return SPRITE_TRACK_GENERATE_SCHEMAS[track] || buildSpriteTrackGenerateSchema(track);
}

export const spriteTrackApproveSchema = z.object({
  direction: spriteWalkDirectionSchema.optional(),
  runId: spriteResolvableRunIdSchema,
});

export const spriteTrackReopenSchema = z.object({
  direction: spriteWalkDirectionSchema.optional(),
});

// The `:trackId` path param. Shape gate only — whether the id names a REGISTERED
// track (and whether this record's kind may carry it) is the service's job, so
// the 404/400 names the known tracks instead of a regex failure. The charset
// matches the registry's slug ids and, load-bearingly, can never contain a `/`
// or `.` that would let the id widen the route's path.
export const spriteTrackParamsSchema = z.object({
  trackId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'invalid animation track id'),
});

// Authoring a user-defined animation type (#3153) — the user-facing subset of a
// registry row, and NOTHING else. The five on-disk/contract discriminators
// (`contractFrameCountField`, `selectionKind`, `setKind`, `finalErrorCode`,
// `contractFpsField`) plus `standaloneContract` and `builtin` are DERIVED by
// `animationTrackCrud.js` and deliberately absent here: they name files on disk and
// publish-contract keys that `assertAnimationTrackRows` requires to be globally
// unique, so accepting them from a request would let a typo hand one track another's
// evidence chain. `.strict()` is what makes that a 400 the user can see rather than a
// silently-stripped field they think they set.
//
// The frame/fps bounds are NOT registry-derived (unlike every other sprite schema
// here) because this request is what DEFINES a track's bounds — there is no row to
// read them from yet. The outer envelope is the widest the pipeline can pack; the
// `min <= default <= max` ordering is the registry's own cross-field rule and is
// asserted by `assertAnimationTrackRows` at save time, restated here only so the
// form gets a per-field 400 instead of a whole-table 409.
const spriteTrackBoundSchema = z.number().int().min(1).max(64);
const spriteTrackFpsBoundSchema = z.number().int().min(1).max(60);

// Keyed off AUTHORED_TRACK_FIELDS so this shape and the service's whitelist cannot
// drift — a field in one and not the other fails silently in one direction (Zod
// strips it) and as an unrecognized key in the other. The unusual `Object.fromEntries`
// spelling is what makes that coupling mechanical: adding a key to the constant
// without a validator here is an immediate boot failure naming the field, instead of
// a value that reaches the store unvalidated.
const SPRITE_ANIMATION_TRACK_FIELD_SCHEMAS = {
  label: z.string().min(1).max(120),
  directional: z.boolean(),
  kinds: z.array(z.enum(SPRITE_RECORD_KINDS)).min(1),
  minFrameCount: spriteTrackBoundSchema,
  maxFrameCount: spriteTrackBoundSchema,
  defaultFrameCount: spriteTrackBoundSchema,
  minFps: spriteTrackFpsBoundSchema,
  maxFps: spriteTrackFpsBoundSchema,
  defaultFps: spriteTrackFpsBoundSchema,
  // The i2v instruction. A stored row MUST carry one (a user-defined track has no
  // compiled prompt builder to fall back to), so this is required on create and
  // non-empty on update — an empty template would throw out of
  // `buildTrackVideoPrompt` after the user clicked Generate.
  promptTemplate: z.string().min(1).max(4000),
};

const spriteAnimationTrackFields = Object.fromEntries(AUTHORED_TRACK_FIELDS.map((key) => {
  const schema = SPRITE_ANIMATION_TRACK_FIELD_SCHEMAS[key];
  if (!schema) throw new Error(`validation: no schema for authored animation-track field '${key}'`);
  return [key, schema];
}));

// `min <= default <= max` on both knobs (the registry's own `TRACK_BOUND_TRIPLES`,
// so the front-run check can't disagree with the assert it front-runs), reported on
// the offending field so the form can point at it.
//
// Applied to each schema rather than once to a shared base because zod 4 refuses
// `.partial()` on an object that already carries a refinement — so the shape has to
// be finished first, then refined. The partial (update) case is why each triple is
// skipped unless all three values are present: a patch that supplies only `maxFps`
// is validated against the merged row by the service, not here.
const refineTrackBounds = (schema) => schema.superRefine((value, ctx) => {
  for (const [min, def, max] of TRACK_BOUND_TRIPLES) {
    if ([value[min], value[def], value[max]].some((v) => v === undefined)) continue;
    if (value[min] <= value[def] && value[def] <= value[max]) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [def],
      message: `${min} <= ${def} <= ${max} is required`,
    });
  }
});

export const spriteAnimationTrackCreateSchema = refineTrackBounds(z.object({
  // The id names the on-disk `<trackId>/` directory and every run's `track` field,
  // so it reuses the same slug charset the `:trackId` param enforces.
  id: spriteTrackParamsSchema.shape.trackId,
  ...spriteAnimationTrackFields,
}).strict());

// `id` is absent from the patch on purpose — renaming would have to migrate the
// on-disk directories, every run record and every manifest, so it is a
// delete-plus-create the user makes explicitly. `.strict()` turns an attempted
// rename into a 400 naming `id` rather than a silent no-op.
export const spriteAnimationTrackUpdateSchema = refineTrackBounds(
  z.object(spriteAnimationTrackFields).strict().partial(),
).refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' });

// Pin the walk track's cycle target at the SET level (#2985). Both knobs are
// required: the target is one atomic set-level decision, and a partial write
// would leave "which value did I actually pin?" ambiguous on a record every
// later render is gated against.
export const spriteWalkTargetSchema = z.object({
  frameCount: spriteWalkFrameCountSchema,
  fps: spriteWalkFpsSchema,
});

export const spriteWalkApproveSchema = z.object({
  direction: spriteWalkDirectionSchema,
  // Also the resolvable shape (#2980): approve has been layout-aware since
  // #2993 — "a re-derived import stays in the run directory it was imported
  // into, and its approval must record THAT path" — so the native-only regex
  // dead-ended the reopen → re-derive → re-approve flow at its last click for
  // exactly the imported runs that work was for. What makes an approval safe is
  // approveWalkDirectionImpl's candidate/manifest/strip/frame tamper checks, not
  // a charset that encodes an obsolete provenance assumption.
  runId: spriteResolvableRunIdSchema,
});

// The optional acknowledgement is shared by both ways to re-open imported walk
// work. Defaulted rather than `.optional()` so the service's own default and the
// wire shape agree, and an older client's body still means "do not override".
const spriteWalkAcknowledgeNoClipsSchema = z.boolean().default(false);

export const spriteWalkReopenSchema = z.object({
  direction: spriteWalkDirectionSchema,
  acknowledgeNoClips: spriteWalkAcknowledgeNoClipsSchema,
});

export const spriteWalkUnlockSchema = z.object({
  acknowledgeNoClips: spriteWalkAcknowledgeNoClipsSchema,
});

export const spriteWalkPostprocessSchema = z.object({
  // Resolvable, not native-only (#2980): since #2993 the reprocess is
  // layout-aware and re-derives an IMPORTED run in the directory it was imported
  // into — which the strict shape rejected at the door, leaving the one path
  // back onto the set's target unreachable for exactly the population that
  // needs it.
  runId: spriteResolvableRunIdSchema,
  // Reprocess the on-disk clip without regenerating. Omitted fields adopt the
  // set's pinned cycle target (#2985) — NOT the run's stored values, since a
  // reprocess is how a drifted direction is brought back onto the target. A
  // supplied value that disagrees with the target is refused with 409
  // WALK_TARGET_MISMATCH.
  frameCount: spriteWalkFrameCountSchema.optional(),
  fps: spriteWalkFpsSchema.optional(),
});

// The raw ffmpeg frames behind one run (#2980) — a read-only enumeration of the
// directory `listSpriteAssets` deliberately skips. Path params, so the run id
// arrives as a URL segment; the trimmer can select an imported or redraw run, so
// it takes the resolvable shape rather than the native one.
export const spriteWalkSourceFramesParamsSchema = z.object({
  runId: spriteResolvableRunIdSchema,
});

// Trim geometry (strip path, cell size, frame labels) derives server-side
// from the run's packaged manifest — the client only names the run and
// which frames stay enabled.
export const spriteWalkTrimSchema = z.object({
  runId: spriteResolvableRunIdSchema,
  enabledColumns: z.array(z.number().int().min(0).max(63)).min(2).max(64)
    .refine((cols) => new Set(cols).size === cols.length, { message: 'columns must be unique' }),
  fps: z.number().int().min(1).max(60).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional(),
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
export * from './creativeCommissionValidation.js';
export * from './musicVideoValidation.js';
export * from './storyBuilderValidation.js';
export * from './moodBoardValidation.js';
export * from './privacyValidation.js';
export * from './agentValidation.js';
export * from './cosValidation.js';
export * from './mediaValidation.js';
export * from './pipelineValidation.js';
