import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { partialWithoutDefaults, emptyToUndefined, emptyToNull } from './zodCompat.js';
import { WORK_TRACKERS } from './workTracker.js';
import { SPRITE_ID_PATTERN } from '../services/sprites/recordsLogic.js';
import { ANCHOR_DIRECTIONS, SPRITE_DIRECTIONS } from '../services/sprites/prompts.js';
import { CHROMA_KEY_HEXES } from '../services/sprites/chromaKey.js';
import { QUEUEABLE_IMAGE_MODES } from '../services/imageGen/modes.js';

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

export const spriteRecordUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  notes: z.string().max(10000).nullable().optional(),
  // Fixed three-key set (#2895 decision) — manual override is limited to the
  // same keys the auto-selection picks from. Imported legacy records keep
  // whatever hex they carried (the importer writes via upsert, not this
  // schema); null clears back to auto-select-on-lock.
  chromaKey: z.enum(CHROMA_KEY_HEXES).nullable().optional(),
});

// Phase 2 (issue #2896): reference workflow. prompts.js / chromaKey.js are
// pure sprite modules (like recordsLogic.js) so importing their constants
// here can't disturb mocked suites; modes.js is the dependency-free image-gen
// enum module.
export const spriteCreateSchema = z.object({
  id: z.string().regex(SPRITE_ID_PATTERN).optional(),
  name: z.string().trim().min(1).max(200),
  spec: z.record(z.string(), z.unknown()).nullable().optional(),
});

const spriteReferenceTargetSchema = z.enum(['main', ...ANCHOR_DIRECTIONS]);

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
  initImageStrength: optionalUnitNumber,
});

export const spriteReferenceLockSchema = z.object({
  target: spriteReferenceTargetSchema,
  candidate: z.string().min(1).max(500),
  // Confirm-through for a clip-risk main lock (409 CHROMA_CLIP_RISK otherwise).
  acceptClipRisk: z.boolean().optional(),
});

// Phase 3 (issue #2897): walk-animation workflow. All 8 directions are
// animatable (south's anchor is the frozen main itself).
const spriteWalkDirectionSchema = z.enum(SPRITE_DIRECTIONS);

const spriteWalkRunIdSchema = z.string().regex(/^walk-[a-z-]+-[0-9a-f]{8}$/);

export const spriteWalkGenerateSchema = z.object({
  direction: spriteWalkDirectionSchema,
  // Grok image_to_video accepts exactly these lengths; the service defaults
  // to the shorter clip when omitted.
  duration: z.union([z.literal(6), z.literal(10)]).optional(),
});

export const spriteWalkApproveSchema = z.object({
  direction: spriteWalkDirectionSchema,
  runId: spriteWalkRunIdSchema,
});

export const spriteWalkPostprocessSchema = z.object({
  runId: spriteWalkRunIdSchema,
});

const trimColumnsSchema = z.array(z.number().int().min(0).max(255)).min(2).max(256)
  .refine((cols) => new Set(cols).size === cols.length, { message: 'columns must be unique' });

export const spriteWalkTrimSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  atlasPath: z.string().min(1).max(500),
  row: z.number().int().min(0).max(63),
  cellWidth: z.number().int().min(1).max(4096),
  cellHeight: z.number().int().min(1).max(4096),
  fps: z.number().int().min(1).max(60),
  allColumns: trimColumnsSchema,
  enabledColumns: trimColumnsSchema,
  sourceFrameIndices: z.array(z.number().int().min(0)).max(256).optional(),
  sourceFrameLabels: z.array(z.string().max(200)).max(256).optional(),
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
