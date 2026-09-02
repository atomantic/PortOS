import { z } from 'zod';
import { ServerError } from './errorHandler.js';
import { partialWithoutDefaults, emptyToUndefined, emptyToNull, optionalBooleanMap } from './zodCompat.js';
import { WORK_TRACKERS } from './workTracker.js';
import { PROVIDER_FAMILY_IDS } from './providerFamilies.js';
import { APP_FEATURE_IDS, INSTANCE_FEATURE_IDS } from './instanceFeatureRegistry.js';
import { MAX_MONTHLY_COST } from './subscriptionSavings.js';
import { QUEUEABLE_IMAGE_MODES, VIDEO_GEN_MODES } from './generationModes.js';
import { RENDER_TARGETS, RENDER_TARGET_BACKEND_AUTO } from './renderTargets.js';
import {
  grokVideoDurationSchema, cloudModelIdString, recordRenderPinFields, isSafeSubdirFilter,
} from './sharedSchemas.js';
import { PR_COMPLETION_VALUES } from './prDisposition.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { MAX_TIMEOUT as AI_RUN_TIMEOUT_MAX_MS, MIN_TIMEOUT as AI_RUN_TIMEOUT_MIN_MS } from './aiToolkit/constants.js';
import {
  FEDERATED_MEDIA_ASSET_MAX_COUNT,
  FEDERATED_MEDIA_MAX_VIDEO_FRAMES,
  federatedMediaInputAssetRefSchema,
  isFederatedMediaAudioPrompt,
} from './federatedMediaWire.js';
import { isPlainObject } from './objects.js';
import { USER_ACTION_ACTORS, USER_ACTION_TYPES } from './userActionTypes.js';

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

// `optionalBooleanMap` now lives in zodCompat.js (so per-domain schema files can
// use it without a cycle through this module) — re-exported for deep imports.
export { optionalBooleanMap };

// Cross-domain Zod fragments now live in sharedSchemas.js for the same
// no-cycle reason (spriteValidation.js and this module both need them) —
// re-exported so every existing `import { … } from '../lib/validation.js'`
// keeps working unchanged.
export {
  grokVideoDurationSchema, cloudModelIdString, recordRenderPinFields, isSafeSubdirFilter,
};

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

// Per-managed-app feature participation. An absent key or null means inherit
// the install-wide Settings > Features value; true/false is an app override.
// The app-level list intentionally excludes POST, which has no managed-app tab.
export const appFeatureOverridesSchema = z.object(
  Object.fromEntries(APP_FEATURE_IDS.map((id) => [id, z.boolean().nullable().optional()]))
).strict();

// POST /api/datadog/instances. API keys may be empty when updating an
// existing instance because the route preserves the stored secret in that
// case.
export const datadogInstanceRequestSchema = z.object({
  // Preserve the exact key for updates. Older installs may have stored IDs
  // outside the current preferred length/whitespace convention, and changing
  // the lookup key here would make those instances impossible to edit.
  id: z.string().min(1),
  // Existing installs may have stored names longer than the current preferred
  // display length, and updates should not make those records uneditable.
  name: z.string().trim().min(1),
  site: z.string().trim().min(1).max(253),
  apiKey: z.string().max(512).optional(),
  appKey: z.string().max(512).optional(),
});

// POST /api/datadog/instances/:id/search-errors.
export const datadogSearchErrorsRequestSchema = z.object({
  serviceName: z.string().trim().min(1),
  environment: z.string().trim().optional(),
  fromTime: z.preprocess(emptyToUndefined, z.string().trim().refine(value => !Number.isNaN(Date.parse(value)), {
    message: 'fromTime must be a valid ISO 8601 date string',
  }).optional()),
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
    // PortOS-only product-success signals (POST engagement and creative
    // commission feedback). Managed apps use appMetrics/custom sources.
    productMetrics: z.boolean().optional(),
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
  companionRepoPaths: z.array(z.string().min(1)).max(8).optional(),
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
  // After a CoS agent completes against this app, audit the repo for the state the
  // task asked for (worktree removed, branch deleted, PR merged) and file a recovery
  // task when it diverges. See lib/repoStateExpectations.js. Unset = ON: an install
  // that never hears about a leaked branch just accumulates them.
  verifyRepoStateOnCompletion: z.boolean().optional(),
  featureOverrides: appFeatureOverridesSchema.optional(),
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

export const managedAppUpdateSchema = z.object({
  syncFork: z.boolean().optional(),
}).strict();

const standardizePlanFileSchema = z.string().trim().min(1).max(500)
  .refine((file) => {
    const segments = file.split(/[/\\]/);
    return !file.startsWith('/')
      && !file.startsWith('\\')
      && !/^[A-Za-z]:/.test(file)
      && !segments.includes('..');
  }, { message: 'file must be a repo-relative path without parent traversal' });

const standardizePlanProcessSchema = z.object({
  name: z.string().trim().min(1).max(120)
}).passthrough();

const standardizePlanStrayPortSchema = z.object({
  file: standardizePlanFileSchema,
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(120),
  value: z.number().int().min(1).max(65535),
  line: z.number().int().positive(),
  action: z.enum(['remove', 'keep'])
}).passthrough();

export const standardizePlanSchema = z.object({
  currentState: z.object({
    hasGit: z.boolean()
  }).passthrough(),
  proposedChanges: z.object({
    createEcosystem: z.boolean(),
    ecosystemContent: z.string().min(1).max(1_000_000),
    processes: z.array(standardizePlanProcessSchema).max(100),
    strayPorts: z.array(standardizePlanStrayPortSchema).max(500)
  }).passthrough()
}).passthrough();

export const standardizeApplySchema = z.object({
  repoPath: z.string().trim().min(1).max(4096).optional(),
  appId: z.string().trim().min(1).max(200).optional(),
  plan: standardizePlanSchema,
  overwriteEcosystem: z.boolean().optional().default(false)
});

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

// Repo-relative publish destination inside the managed app repository. The
// extension gate is per-lane (PNG artwork vs library audio); the traversal
// refinements are shared so the two lanes can't drift.
const gameDestinationSchema = (extensionPattern, extensionMessage) => z.string()
  .trim()
  .min(1)
  .max(500)
  .regex(extensionPattern, extensionMessage)
  .refine((value) => !value.startsWith('/') && !value.includes('\\'), 'must be a repo-relative path')
  .refine((value) => !value.split('/').includes('..'), 'must not traverse outside the app repository');
const gameMusicDestinationSchema = gameDestinationSchema(
  /\.(?:mp3|wav|m4a|ogg|flac)$/i,
  'must end in a supported audio extension',
);
const gamePublishOptionsSchema = z.object({
  acknowledgeOverwrite: z.boolean().optional(),
}).strict();

export const gameMusicBindingSchema = z.object({
  trackId: gameAssetIdSchema,
  destinationPath: gameMusicDestinationSchema.optional(),
}).strict();

export const gameMusicBindingUpdateSchema = z.object({
  destinationPath: gameMusicDestinationSchema,
}).strict();

export const gameMusicPublishSchema = gamePublishOptionsSchema;

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
const gameArtworkDestinationSchema = gameDestinationSchema(/\.png$/i, 'must end in .png');

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

export const gameArtworkPublishSchema = gamePublishOptionsSchema;

export const gameFeedbackSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  prompt: z.string().trim().min(1).max(4_000),
}).strict();

// Provider schema
const providerHardwareRequirementsSchema = z.object({
  platforms: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  architectures: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  requiresAppleSilicon: z.boolean().optional(),
  requiresNvidiaGpu: z.boolean().optional(),
  minMemoryGb: z.number().positive().max(4096).optional(),
  minVramGb: z.number().positive().max(4096).optional(),
  minCudaComputeCapability: z.number().positive().max(20).optional(),
}).strict();

export const providerSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['cli', 'api', 'tui']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  endpoint: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  hardwareRequirements: providerHardwareRequirementsSchema.optional(),
  modelHardwareRequirements: z.record(providerHardwareRequirementsSchema).optional(),
  defaultModel: z.string().nullable().optional(),
  timeout: z.number().int().min(AI_RUN_TIMEOUT_MIN_MS).max(AI_RUN_TIMEOUT_MAX_MS).optional(),
  enabled: z.boolean().optional(),
  // Kept in schema parity with aiToolkit's provider schema. Marks OpenCode
  // wrappers for a separately started local MTPLX native-MTP server.
  mtplxBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local llama.cpp
  // server (e.g. DFlash 2 speculative decoding).
  llamaBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local vLLM
  // container (the Qwen3.8-27B DFlash 2 stack on an RTX 3090).
  vllmBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local SGLang
  // container (Qwen3.8-27B on a Hopper/Blackwell card).
  sglangBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a hosted OpenAI-compatible gateway
  // ('orcarouter', 'openrouter' — see server/lib/providerGateways.js). The
  // sibling API record whose id equals this value owns the key.
  gatewayBacked: z.string().optional(),
  // Legacy per-gateway marker, superseded by `gatewayBacked`. Still accepted and
  // still READ (providerGateways.js resolves it), because records written before
  // the registry existed are never rewritten — installs upgrade on their own
  // schedule.
  orcarouterBacked: z.boolean().optional(),
  // Explicit opt-in to attach the API key to an arbitrary (non-local,
  // non-allowlisted) endpoint — mirrors the aiToolkit providerSchema. Guards
  // SSRF / key exfiltration (server/lib/aiToolkit/internal/endpointGuard.js).
  allowCustomEndpoint: z.boolean().optional(),
  envVars: z.record(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(1000).max(86400000).optional()
});

// POST /api/providers/:id/test-vision.
export const providerVisionTestSchema = z.object({
  imagePath: z.string().trim().min(1).max(255),
  prompt: z.string().max(8_000).optional(),
  expectedContent: z.preprocess(emptyToUndefined, z.union([
    z.string().trim().min(1).max(128),
    z.array(z.string().trim().min(1).max(128)).max(50),
  ]).optional()),
  model: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(256).optional()),
});

// POST /api/providers/codex/account/login/cancel. The id is minted by the Codex
// app-server and only ever echoed back, so this bounds the shape and nothing
// more — the service still refuses an id that isn't the pending login's.
export const codexLoginCancelSchema = z.object({
  loginId: z.string().trim().min(1).max(200),
});

// POST /api/providers/codex/account/login. `deviceCode` picks the device-code
// flow (a URL plus a short code) over opening a browser URL directly.
export const codexLoginStartSchema = z.object({
  deviceCode: z.boolean().optional().default(false),
});

// POST /api/providers/:id/vision-suite.
export const providerVisionSuiteSchema = z.object({
  model: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(256).optional()),
});

// POST /api/uploads and POST /api/attachments. The shared upload helper
// enforces decoded-byte limits and extension allowlists; this schema bounds
// the JSON shape before the helper receives it.
export const base64FileUploadSchema = z.object({
  data: z.string().trim().min(1, 'data is required (base64)').max(64 * 1024 * 1024),
  // The upload helper prefixes the sanitized name with a 9-byte UUID marker.
  filename: z.string().min(1, 'filename is required').max(246),
});

export const uploadRequestSchema = base64FileUploadSchema;
export const attachmentUploadRequestSchema = base64FileUploadSchema;

// Run command schema
export const runSchema = z.object({
  type: z.enum(['ai', 'command']),
  providerId: z.string().optional(),
  model: z.string().optional(),
  workspaceId: z.string(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  timeout: z.number().int().min(AI_RUN_TIMEOUT_MIN_MS).max(AI_RUN_TIMEOUT_MAX_MS).optional()
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
  // Optional per-schedule reasoning effort (#3641), mapped to the run's
  // `effortOverride`. Validated against the union of accepted levels across
  // effort-capable CLIs; the runner clamps a level the chosen provider doesn't
  // offer and drops it for a provider with no effort control.
  effort: z.preprocess((v) => (v === '' ? undefined : v), z.enum(EFFORT_LEVELS).optional()),
  // Run every stage on the provider/model above, ignoring the per-stage pins
  // from the Prompts page. Absent falls through to the persisted
  // pipelineEditorialChecks setting, then off.
  overrideStagePins: z.boolean().optional(),
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

// Install-local feature participation flags. `instanceFeatureRegistry.js` owns
// the available feature ids and both schemas derive from it, so registering a
// feature there needs no edit here; the schemas keep generic settings saves from
// persisting an unknown or malformed feature state.
export const instanceFeatureSettingsSchema = z.object(
  Object.fromEntries(INSTANCE_FEATURE_IDS.map((id) => [
    id,
    z.object({ enabled: z.boolean().optional() }).strict().optional(),
  ]))
).strict();

export const instanceFeatureIdSchema = z.enum([...INSTANCE_FEATURE_IDS]);

export const instanceFeatureUpdateSchema = z.object({
  enabled: z.boolean(),
}).strict();

// =============================================================================
// EIDOVERSE WORLD PROJECTION
// =============================================================================

// Eidoverse identities are currently name-based when no archipelago session is
// present. Keep the PortOS-side contract deliberately conservative: names and
// ids are durable world keys, while display metadata stays in the private
// world log and never becomes a federation payload.
const eidoverseWorldNameSchema = z.string().trim().min(1).max(64).regex(
  /^[a-z0-9_-]+$/i,
  'must contain only letters, numbers, hyphens, and underscores',
);
const eidoverseIdentitySchema = z.string().trim().min(1).max(64).regex(
  /^[^\u0000-\u001f\u007f]+$/,
  'must not contain control characters',
);
const eidoverseVector3Schema = z.array(z.number().finite()).length(3);
const eidoverseAssetPathSchema = z.string().trim().min(1).max(512).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  return !normalized.startsWith('/')
    && !normalized.includes('..')
    && (/^eidoverse\//i.test(normalized) || /^store\//i.test(normalized));
}, 'must be a relative Eidoverse library or store asset path');
const eidoverseModelAssetOverrideSchema = eidoverseAssetPathSchema.refine((value) => (
  (value.startsWith('eidoverse/assets/models/') && value.toLowerCase().endsWith('.glb'))
  || /^store\/[A-Za-z0-9._/-]+$/.test(value)
), 'must be a model-library GLB or an explicit local store asset');

// These are the resource lanes that the deterministic PortOS projection may
// materialize. Keep the list explicit: a recipe must opt into known data
// families rather than accepting an arbitrary source key that the service
// would not know how to sanitize.
export const EIDOVERSE_PROJECTION_SOURCE_KEYS = Object.freeze([
  'apps',
  'agents',
  'tasks',
  'features',
  'peers',
  'health',
  'productivity',
  'activity',
  'goals',
  'memory',
  'storage',
  'jira',
  'operations',
]);

const eidoverseProjectionIncludesSchema = z.object({
  apps: z.boolean(),
  agents: z.boolean(),
  tasks: z.boolean(),
  features: z.boolean(),
  peers: z.boolean(),
  health: z.boolean(),
  productivity: z.boolean(),
  activity: z.boolean(),
  goals: z.boolean(),
  memory: z.boolean(),
  storage: z.boolean(),
  jira: z.boolean(),
  operations: z.boolean(),
}).strict();

const eidoverseProjectionAssetsSchema = z.object({
  app: eidoverseAssetPathSchema,
  agent: eidoverseAssetPathSchema,
  task: eidoverseAssetPathSchema,
  feature: eidoverseAssetPathSchema,
  peer: eidoverseAssetPathSchema,
  health: eidoverseAssetPathSchema,
  productivity: eidoverseAssetPathSchema,
  activity: eidoverseAssetPathSchema,
  goal: eidoverseAssetPathSchema,
  memory: eidoverseAssetPathSchema,
  storage: eidoverseAssetPathSchema,
  jira: eidoverseAssetPathSchema,
  operations: eidoverseAssetPathSchema,
}).strict();

const eidoverseProjectionTerrainLayerSchema = z.object({
  color: z.string().trim().min(1).max(32),
  repeat: z.number().finite().positive().max(128),
}).strict();

const eidoverseProjectionTerrainSchema = z.object({
  seed: z.string().trim().min(1).max(64),
  size: z.number().finite().positive().max(512),
  segments: z.number().int().min(2).max(512),
  amplitude: z.number().finite().min(0).max(100),
  flatRadius: z.number().finite().min(0).max(256),
  layers: z.array(eidoverseProjectionTerrainLayerSchema).max(8),
}).strict();

const eidoverseProjectionRecipeV1Schema = z.object({
  version: z.literal(1),
  includes: eidoverseProjectionIncludesSchema,
  limits: z.object({
    apps: z.number().int().min(0).max(100),
    agents: z.number().int().min(0).max(100),
    tasks: z.number().int().min(0).max(100),
    features: z.number().int().min(0).max(100),
    peers: z.number().int().min(0).max(100),
    health: z.number().int().min(0).max(100),
    productivity: z.number().int().min(0).max(100),
    activity: z.number().int().min(0).max(100),
    goals: z.number().int().min(0).max(100),
    memory: z.number().int().min(0).max(100),
    storage: z.number().int().min(0).max(100),
    jira: z.number().int().min(0).max(100),
    operations: z.number().int().min(0).max(100),
  }).strict(),
  layout: z.object({
    origin: eidoverseVector3Schema,
    spacing: z.number().finite().min(2).max(100),
    laneGap: z.number().finite().min(2).max(100),
    columns: z.number().int().min(1).max(32),
  }).strict(),
  scale: z.object({
    app: z.number().finite().positive().max(20),
    agent: z.number().finite().positive().max(20),
    task: z.number().finite().positive().max(20),
    feature: z.number().finite().positive().max(20),
    peer: z.number().finite().positive().max(20),
    health: z.number().finite().positive().max(20),
    productivity: z.number().finite().positive().max(20),
    activity: z.number().finite().positive().max(20),
    goal: z.number().finite().positive().max(20),
    memory: z.number().finite().positive().max(20),
    storage: z.number().finite().positive().max(20),
    jira: z.number().finite().positive().max(20),
    operations: z.number().finite().positive().max(20),
  }).strict(),
  assets: eidoverseProjectionAssetsSchema,
  terrain: eidoverseProjectionTerrainSchema,
}).strict();

const eidoverseProjectionLimitsSchema = z.object(Object.fromEntries(
  EIDOVERSE_PROJECTION_SOURCE_KEYS.map((key) => [key, z.number().int().min(0).max(100)]),
)).strict();

const eidoverseProjectionScaleSchema = z.object({
  app: z.number().finite().positive().max(20),
  agent: z.number().finite().positive().max(20),
  task: z.number().finite().positive().max(20),
  feature: z.number().finite().positive().max(20),
  peer: z.number().finite().positive().max(20),
  health: z.number().finite().positive().max(20),
  productivity: z.number().finite().positive().max(20),
  activity: z.number().finite().positive().max(20),
  goal: z.number().finite().positive().max(20),
  memory: z.number().finite().positive().max(20),
  storage: z.number().finite().positive().max(20),
  jira: z.number().finite().positive().max(20),
  operations: z.number().finite().positive().max(20),
}).strict();

const eidoverseDistrictIdSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

const eidoverseAssetSlotSchema = z.object({
  preferredPaths: z.array(eidoverseAssetPathSchema).max(8),
  fallbackQueries: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  requiredTokens: z.array(z.string().trim().min(1).max(40)).max(12),
  excludedTokens: z.array(z.string().trim().min(1).max(40)).max(12),
  maxBytes: z.number().int().positive().max(250_000_000),
  format: z.literal('glb'),
  animation: z.enum(['none', 'optional', 'required']),
  sourcePolicy: z.literal('library-only'),
  fallback: eidoverseAssetPathSchema,
}).strict();

const eidoverseAssetSlotsSchema = z.object({
  nexus: eidoverseAssetSlotSchema,
  app: eidoverseAssetSlotSchema,
  agent: eidoverseAssetSlotSchema,
  task: eidoverseAssetSlotSchema,
  goal: eidoverseAssetSlotSchema,
  memory: eidoverseAssetSlotSchema,
  storage: eidoverseAssetSlotSchema,
  peer: eidoverseAssetSlotSchema,
  activity: eidoverseAssetSlotSchema,
  district: eidoverseAssetSlotSchema,
}).strict();

const eidoverseResolvedAssetsSchema = z.record(z.string().trim().min(1).max(40), eidoverseAssetPathSchema)
  .refine((assets) => Object.keys(assets).length <= 32, 'at most 32 asset slots may be configured');

const eidoverseProjectionEnvironmentSchema = z.object({
  terrain: eidoverseProjectionTerrainSchema,
  sky: z.object({
    system: z.literal('skymesh'),
    hours: z.number().finite().min(0).max(24),
    azimuth: z.number().finite().min(0).max(360),
    sun: z.number().finite().min(0).max(2.5),
    ambient: z.number().finite().min(0).max(2.5),
    fill: z.number().finite().min(0).max(2.5),
    exposure: z.number().finite().min(0.3).max(1.8),
    fog: z.number().finite().min(0).max(3),
    clouds: z.enum(['clear', 'cirrus', 'cumulus', 'stratus']),
    weather: z.string().trim().min(1).max(40),
  }).strict(),
  grass: z.object({
    species: z.string().trim().min(1).max(40),
    width: z.number().finite().positive().max(256),
    depth: z.number().finite().positive().max(256),
    center: z.tuple([z.number().finite(), z.number().finite()]),
    height: z.number().finite().positive().max(4),
    color: z.string().trim().min(1).max(40),
    density: z.number().finite().positive().max(2),
  }).strict(),
  lights: z.array(z.object({
    id: z.string().regex(/^portos-design-v2-[A-Za-z0-9_-]{1,47}$/),
    pos: eidoverseVector3Schema,
    color: z.number().int().min(0).max(0xffffff),
    intensity: z.number().finite().positive().max(100),
    range: z.number().finite().positive().max(256),
    keep: z.boolean(),
    day: z.boolean(),
  }).strict()).max(4),
}).strict();

const eidoverseProjectionRecipeV2Schema = z.object({
  version: z.literal(2),
  name: z.string().trim().min(1).max(80),
  maxEntities: z.number().int().min(1).max(48),
  includes: eidoverseProjectionIncludesSchema,
  limits: eidoverseProjectionLimitsSchema,
  scale: eidoverseProjectionScaleSchema,
  districts: z.array(z.object({
    id: eidoverseDistrictIdSchema,
    label: z.string().trim().min(1).max(80),
    direction: z.string().trim().min(1).max(40),
    landmark: z.string().trim().min(1).max(80),
    anchor: eidoverseVector3Schema,
    sources: z.array(z.enum(EIDOVERSE_PROJECTION_SOURCE_KEYS)).min(1).max(8),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  }).strict()).min(1).max(12),
  paths: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
    label: z.string().trim().min(1).max(100),
    toDistrictId: eidoverseDistrictIdSchema,
    nodes: z.array(eidoverseVector3Schema).min(1).max(8),
  }).strict()).max(16),
  environment: eidoverseProjectionEnvironmentSchema,
  assetRecipe: z.object({ version: z.literal(2), slots: eidoverseAssetSlotsSchema }).strict(),
  assets: eidoverseResolvedAssetsSchema,
}).strict();

export const eidoverseProjectionRecipeSchema = z.union([
  eidoverseProjectionRecipeV1Schema,
  eidoverseProjectionRecipeV2Schema,
]);

// This is intentionally an opaque, bounded argument bag at the HTTP boundary.
// The PortOS service applies the narrower verb-specific checks immediately
// before sending it to Eidoverse, which keeps this public schema forward-
// compatible with the external world's evolving component vocabulary without
// accepting unbounded payloads.
const eidoverseAugmentArgsSchema = z.record(z.string().max(80), z.unknown()).superRefine((value, ctx) => {
  if (JSON.stringify(value).length > 8192) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'arguments must be at most 8KB' });
  }
});

export const EIDOVERSE_AUGMENT_VERBS = ['spawn', 'place', 'remove', 'comp', 'light', 'terrain', 'grass', 'sky', 'grant'];

export const eidoverseWorldAugmentSchema = z.object({
  operations: z.array(z.object({
    verb: z.enum(EIDOVERSE_AUGMENT_VERBS),
    args: eidoverseAugmentArgsSchema,
  }).strict()).min(1).max(100),
}).strict();

export const eidoverseWorldSaySchema = z.object({
  text: z.string().trim().min(1).max(2000),
}).strict();

export const eidoverseWorldConfigPatchSchema = z.object({
  world: eidoverseWorldNameSchema.optional(),
  humanName: eidoverseIdentitySchema.nullable().optional(),
  humanAvatar: eidoverseAssetPathSchema.nullable().optional(),
  cosId: eidoverseIdentitySchema.optional(),
  cosAvatar: eidoverseAssetPathSchema.nullable().optional(),
  cosEnabled: z.boolean().optional(),
  recipe: eidoverseProjectionRecipeSchema.optional(),
  assetOverrides: z.partialRecord(
    z.enum([
      'nexus', 'app', 'agent', 'task', 'goal', 'memory', 'storage', 'peer', 'activity', 'district',
      // V1 used resource-kind keys. Keep accepting them so an upgraded install
      // can round-trip its preserved custom paths while the V2 semantic slots
      // become the preferred editing surface.
      'feature', 'health', 'productivity', 'jira', 'operations',
    ]),
    eidoverseModelAssetOverrideSchema,
  ).optional(),
  refreshAssets: z.boolean().optional(),
  reset: z.object({
    scope: z.enum(['all', 'assets', 'district']),
    districtId: eidoverseDistrictIdSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.scope === 'district' && !value.districtId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['districtId'], message: 'districtId is required for a district reset' });
    }
  }).optional(),
}).strict();

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
// managed app + subdir inside its repo). `designer` (#4305) is the Generate
// tab's stepped music designer: its provider/model/effort pin plus optional
// meta-prompt overrides for the describe + lyrics steps (a blank override falls
// back to the shipped default server-side, in services/musicDesigner.js).
// Reuses the shared feature-provider shape so an empty-string picker value
// normalizes to unset. Every key stays optional so an older client PUTting only
// `{ chiptune }` — or only `{ designer }` — still validates.
export const musicSettingsSchema = z.object({
  chiptune: featureProviderConfigSchema.extend({
    publishAppId: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
    publishSubdir: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  }).partial().optional(),
  designer: featureProviderConfigSchema.extend({
    effort: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
    describeTemplate: z.preprocess(emptyToUndefined, z.string().max(8000).optional()),
    lyricsTemplate: z.preprocess(emptyToUndefined, z.string().max(8000).optional()),
  }).partial().optional(),
});

// Federated media is an opt-in provider surface. The outer objects remain
// passthrough for mixed-version peers/settings UIs: a rolled-back install must
// preserve fields introduced by a newer build while still validating every
// field this build understands.
export const federatedMediaModelSchema = z.object({
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
}).passthrough();

const federatedMediaModelListSchema = z.array(federatedMediaModelSchema).max(100).refine(
  (models) => new Set(models.map((model) => `${model.engine}\u0000${model.modelId}`)).size === models.length,
  { message: 'models must not contain duplicate engine/model pairs' },
);

// Image/video federation shares this same model-pair shape (`{ engine,
// modelId }`) as audio for wire uniformity, but only `engine: 'local'`
// resolves to a live capability today — the provider only has readiness
// signals for this install's own local generator, not the cloud-CLI image/
// video backends (codex/grok/agy/external), which spend a *provider's own*
// account quota rather than sharing this machine's GPU. A peer that
// configures a non-local engine simply reports 'unknown-engine' and never
// admits a job, so this schema doesn't need to special-case it.
export const federatedMediaProviderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  maxQueuedJobs: z.number().int().min(1).max(20).optional(),
  audioModels: federatedMediaModelListSchema.optional(),
  imageModels: federatedMediaModelListSchema.optional(),
  videoModels: federatedMediaModelListSchema.optional(),
}).passthrough();

// Consumer-side peer selection is independent from the provider's local queue
// limit. Unknown fields stay round-trip-safe across mixed-version Instances
// clients while known model pairs remain unique and bounded.
export const federatedMediaPeerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  audioModels: federatedMediaModelListSchema.optional(),
  imageModels: federatedMediaModelListSchema.optional(),
  videoModels: federatedMediaModelListSchema.optional(),
}).passthrough();

// Where UNATTENDED jobs (Creative Director / Creative Commission) of a given
// kind render. One peer + one model per kind, chosen by the local operator and
// stored server-side, so an LLM planner never names a peer. Nullable because
// clearing a kind is how routing is turned back off — an absent key means
// "unchanged", an explicit null means "render locally again".
export const federatedMediaRouteSchema = z.object({
  peerId: z.string().trim().min(1).max(200),
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
}).strict();

export const federatedMediaRoutingSchema = z.object({
  image: federatedMediaRouteSchema.nullable().optional(),
  video: federatedMediaRouteSchema.nullable().optional(),
}).passthrough();

export const federationSettingsSchema = z.object({
  strictPullAuthorization: z.boolean().optional(),
  mediaProvider: federatedMediaProviderSettingsSchema.optional(),
  mediaRouting: federatedMediaRoutingSchema.optional(),
}).passthrough();

export const federatedMediaJobRoutingSchema = z.object({
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
  durationSec: z.number().finite().min(1).max(3600).optional(),
  durationMode: z.enum(['auto', 'manual']).optional(),
}).strict();

// Provider submissions accept model selection, the canonical fixed-vocabulary
// instrumental prompt, and — since ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 2 — free-form
// lyrics. The asymmetry between the two text fields is deliberate rather than
// inconsistent: a style/mood/instrument profile renders `prompt` with no
// expressive loss, so the privacy-safe canonical form is required there; lyrics
// ARE the words, so no alphabet encodes them without discarding them, and they
// cross verbatim under the same submission-body rule image/video prompts do.
// The provider still refuses them for a model whose capability reports
// `lyrics: false`. URLs, paths, commands, provider credentials, and unknown
// fields are excluded by the strict object as before.
const federatedMediaAudioJobSubmissionSchema = federatedMediaJobRoutingSchema.extend({
  kind: z.literal('audio'),
  prompt: z.string().trim().min(1).max(8000),
  lyrics: z.string().max(50_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!isFederatedMediaAudioPrompt(value.prompt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['prompt'],
      message: 'prompt must be rendered from a privacy-safe federated audio profile',
    });
  }
});

// Image/video prompts cross as submitted, with no fixed-vocabulary rendering
// like audio's: there is no closed taxonomy for arbitrary visual/motion content
// the way audio has a finite style/mood/instrument alphabet. Why that does not
// breach the "no PII on federation" rule — a submitted job body is not a status
// payload, and status/capability payloads stay absolutely prompt-free — is
// ADR docs/decisions/2026-08-20-federated-visual-prompts.md.
//
// Conditioning IMAGES ride the same rule (ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 1), by id
// rather than by value: the bytes went up through the authenticated,
// digest-verified asset endpoint first. What is still refused here — and refused
// by the routes, since neither has a field to name it — is a MODEL (LoRA
// weights, rule 3) and multi-step CHAIN STATE (a video to extend, chained
// chunks, IC-LoRA references, rule 4).
// Exported UN-REFINED as well, and the split is load-bearing rather than
// cosmetic. The cross-field rule below pairs `initImageStrength` with
// `initImage` — but a conditioning image reaches the body as an asset id
// resolved immediately BEFORE submission, so the persisted marker legitimately
// carries the strength with no image beside it yet. The marker and the request
// builder validate against the base; the provider route, which sees the fully
// assembled body, validates against the refined schema.
export const federatedMediaImageJobSubmissionBaseSchema = federatedMediaJobRoutingSchema.omit({
  durationSec: true, durationMode: true,
}).extend({
  kind: z.literal('image'),
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(4000).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  guidance: z.number().finite().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  initImage: federatedMediaInputAssetRefSchema.optional(),
  initImageStrength: z.number().finite().min(0).max(1).optional(),
  referenceImages: z.array(federatedMediaInputAssetRefSchema)
    .max(FEDERATED_MEDIA_ASSET_MAX_COUNT).optional(),
}).strict()
  .refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

export const federatedMediaImageJobSubmissionSchema = federatedMediaImageJobSubmissionBaseSchema
  // A strength with nothing to apply it to is a caller bug, not a default to
  // guess at: silently ignoring it renders at full denoise, which is the
  // opposite of what a low strength asked for.
  .refine((value) => value.initImageStrength === undefined || value.initImage !== undefined, {
    message: 'initImageStrength requires an initImage',
    path: ['initImageStrength'],
  });

// Same boundary as the image schema above — see the ADRs named there.
//
// Exported UN-REFINED as well: `negotiateVideoConstraints` re-validates a
// partially-negotiated body against `.partial()`, and Zod refuses `.partial()`
// on a schema carrying refinements. Splitting the object from its cross-field
// rule keeps both callers honest instead of dropping the rule to keep the
// partial working.
export const federatedMediaVideoJobSubmissionBaseSchema = federatedMediaJobRoutingSchema.omit({
  durationSec: true, durationMode: true,
}).extend({
  kind: z.literal('video'),
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(4000).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  numFrames: z.number().int().min(1).max(FEDERATED_MEDIA_MAX_VIDEO_FRAMES).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  guidance: z.number().finite().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  sourceImage: federatedMediaInputAssetRefSchema.optional(),
  lastImage: federatedMediaInputAssetRefSchema.optional(),
}).strict();

export const federatedMediaVideoJobSubmissionSchema = federatedMediaVideoJobSubmissionBaseSchema
  // First-last-frame needs both ends. A lone end frame would render a plain
  // text-to-video clip and quietly discard the frame the caller supplied.
  .refine((value) => value.lastImage === undefined || value.sourceImage !== undefined, {
    message: 'lastImage requires a sourceImage (first-last-frame needs both ends)',
    path: ['lastImage'],
  });

// An already-shipped consumer's request body never carries `kind` — it only
// knows the pre-existing audio-only shape. Defaulting the missing field to
// 'audio' before the discriminated union runs keeps that body validating
// exactly as before; a new consumer names its kind explicitly.
export const federatedMediaJobSubmissionSchema = z.preprocess(
  (value) => (isPlainObject(value) && value.kind === undefined ? { ...value, kind: 'audio' } : value),
  z.discriminatedUnion('kind', [
    federatedMediaAudioJobSubmissionSchema,
    federatedMediaImageJobSubmissionSchema,
    federatedMediaVideoJobSubmissionSchema,
  ]),
);

export const federatedMediaIdempotencyKeySchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contains unsupported characters');

export const federatedMediaJobParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const federatedMediaStatusQuerySchema = z.object({
  kinds: z.string().trim().max(40).regex(/^[a-z]+(,[a-z]+)*$/).optional(),
}).passthrough();

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

/** Query for GET /api/usage/providers. `family` narrows the read to a single
 * quota card (the per-card Refresh on the usage page) so one slow TUI scrape
 * isn't paid for every provider at once. */
export const providerUsageQuerySchema = z.object({
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
  family: z.string().regex(/^[a-z0-9-]{1,32}$/, 'family must be a provider family id').optional()
});

/** Body for POST /api/usage/messages — token counts persist forever, so
 * reject non-integer/negative garbage instead of coercing it into counters. */
export const usageMessagesSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().nullish(),
  messageCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative().optional().default(0),
  inputTokenCount: z.number().int().nonnegative().optional().default(0)
});

/**
 * What the user pays monthly for each provider family's quota plan, keyed by
 * family id. Used by BOTH write paths — `PUT /api/usage/subscriptions` (wrapped
 * below) and the `subscriptionCosts` slice of `PUT /api/settings` — so a price
 * can't be written past validation through the generic settings endpoint.
 *
 * Keys are the real family ids, not a loose id pattern: this gates a PERSISTED
 * write, and an arbitrary key would accumulate in settings.json with no editor
 * row that could ever clear it. `null` is accepted and meaningful — it CLEARS a
 * plan's price (the user cancelled it), which an omitted key must not do, since
 * the editor submits only the rows it knows about. Prices are plain USD dollars
 * (cents allowed), capped at `MAX_MONTHLY_COST` so a mistyped extra digit can't
 * swamp every savings figure on the page.
 */
// `partialRecord`, not `record`: with an enum key schema Zod 4's `record` is
// EXHAUSTIVE — it would demand a price for every family on every save, which is
// the opposite of the patch semantics the editor relies on.
export const subscriptionCostsMapSchema = z.partialRecord(
  z.enum(PROVIDER_FAMILY_IDS),
  z.number().min(0).max(MAX_MONTHLY_COST).nullable()
);

/** Body for PUT /api/usage/subscriptions. */
export const subscriptionCostsSchema = z.object({ costs: subscriptionCostsMapSchema });


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
// `purgeScope: 'category'` entries (#3327). `isTopLevelEntryName` in
// `fileUtils.js` is the authoritative gate — it runs in `purgeCategory`, which
// is the boundary a non-HTTP caller crosses too. The separator check is spelled
// out here rather than imported so this module keeps its narrow import surface
// (a partial mock of fileUtils in an unrelated suite would break schema
// construction at module load).
export const dataPurgeSchema = z.object({
  subPath: z.string().min(1).max(255)
    .refine(
      (v) => !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..',
      'subPath must name a single entry in the category'
    )
    .optional()
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

export const rapidReaderLibraryParamsSchema = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) });
export const rapidReaderLibraryCreateSchema = z.object({ title: z.string().trim().min(1).max(200), author: z.string().trim().max(200).optional(), text: z.string().trim().min(1).max(2 * 1024 * 1024) });
export const rapidReaderLibraryFetchSchema = z.object({ url: z.string().trim().url().max(2000).refine((value) => /^https?:\/\//i.test(value), 'url must be http(s)'), title: z.string().trim().min(1).max(200).optional() });

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
// USER ACTION LEDGER
// =============================================================================

// GET /api/user-actions — read the machine-local operator-action ledger (#5594).
// Every value arrives as a query string, so numbers are coerced and `success` is
// the string form of the boolean. Range checking is deliberately loose here and
// the CLAMP lives in `userActions.normalizeListOptions`: a caller asking for 5000
// rows wants "as many as you will give me", not a 400.
const isParseableDate = (value) => !Number.isNaN(new Date(value).getTime());
const userActionDateFilter = z.string().trim().min(1).max(64)
  .refine(isParseableDate, 'must be a parseable date');
const userActionType = z.enum([...USER_ACTION_TYPES]);

export const userActionsListQuerySchema = z.object({
  type: userActionType.optional(),
  // Repeated `?types=a&types=b` arrives as an array; a single one as a string.
  types: z.union([userActionType, z.array(userActionType)]).optional(),
  actor: z.enum([...USER_ACTION_ACTORS]).optional(),
  target: z.string().trim().min(1).max(200).optional(),
  success: z.enum(['true', 'false']).optional(),
  from: userActionDateFilter.optional(),
  to: userActionDateFilter.optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
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
 * Parse a zero-based array index from an Express route parameter.
 * @param {unknown} raw - Route parameter value
 * @returns {number}
 */
export function parseIndexParam(raw) {
  const index = Number(raw);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(index)) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  return index;
}

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
  // Default-on macOS GPU-watchdog mitigation for sustained MLX video renders.
  // Set false for a headless display workflow that manages display power itself.
  displaySleep: z.boolean().optional(),
  // Install-wide acknowledgement of restricted-model license gates, stored as
  // the exact reviewed-license ids (`termsGate.id`). Written through
  // POST /api/video-gen/model-terms; typed here so a Settings save can't put
  // junk where the render gate reads authorization from.
  acceptedModelTerms: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
});

// POST /api/video-gen/model-terms — record (or withdraw) the acknowledgement of
// one restricted model's reviewed license. `termsId` is the exact versioned
// gate id; the route rejects ids no shipped model declares.
export const videoModelTermsSchema = z.object({
  termsId: z.string().trim().min(1).max(128),
  accepted: z.boolean(),
});

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

// Local backend availability is machine-local configuration. Disabled means
// the user intentionally does not run that backend; it does not remove any
// installed models or prevent an explicit model-management action.
export const localLlmSettingsSchema = z.object({
  ollama: z.object({ disabled: z.boolean().optional() }).strict().optional(),
  lmstudio: z.object({ disabled: z.boolean().optional() }).strict().optional(),
  // Idle windows for the two PM2-managed model servers, in minutes. `0` = never
  // release the model, which is what every install did before this setting
  // existed and stays the default. Capped at a day: a longer window is
  // indistinguishable from "never" and is far likelier a units mix-up.
  llama: z.object({ idleMinutes: z.number().int().min(0).max(1440).optional() }).strict().optional(),
  mtplx: z.object({
    idleMinutes: z.number().int().min(0).max(1440).optional(),
    // The launch line a lazy start replays. MTPLX has no Start button any more —
    // the first request that needs it brings it up — so the checkpoint and port
    // the user chose have to outlive the process, or an on-demand start would
    // fall back to "first verified checkpoint in the cache" and quietly serve
    // something they didn't pick.
    launch: z.object({
      model: z.string().trim().max(300).nullable().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

// =============================================================================
// LM STUDIO (server/routes/lmstudio.js)
// =============================================================================

// PUT /api/lmstudio/config — persisted straight into module-level state
// (lmStudioManager's `config`) that every other LM Studio call site reads via
// getBaseUrl(). A malformed baseUrl must be rejected up front rather than
// degrading local-LLM connectivity until the process restarts.
export const lmStudioConfigSchema = z.object({
  baseUrl: z.string().trim().url().optional(),
  timeout: z.number().int().positive().optional(),
  defaultThinkingModel: z.string().trim().min(1).optional(),
});

// Shared by /download, /load, /unload — each acts on a single model id.
export const lmStudioModelIdSchema = z.object({
  modelId: z.string().trim().min(1),
});

// POST /api/lmstudio/completion
export const lmStudioCompletionSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().trim().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  systemPrompt: z.string().optional(),
});

// POST /api/lmstudio/analyze-task
export const lmStudioAnalyzeTaskSchema = z.object({
  description: z.string().min(1),
  id: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

// POST /api/lmstudio/classify-memory
export const lmStudioClassifyMemorySchema = z.object({
  content: z.string().min(1),
});

// POST /api/lmstudio/embeddings
export const lmStudioEmbeddingsSchema = z.object({
  text: z.string().min(1),
  model: z.string().trim().min(1).optional(),
});

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
 * Body schema for PUT /api/apps/:id/documents/*docPath and
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

// Git submodules. `repoPath` is the repo ROOT (omitted = the PortOS checkout,
// and it is separately checked against the workspace allowlist); `path` is the
// repo-relative submodule path, matching `git submodule status` output.
const optionalRepoPath = z.string().trim().min(1).max(4096).nullish();

export const submoduleStatusQuerySchema = z.object({
  repoPath: optionalRepoPath
});

export const submoduleUpdateSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  repoPath: optionalRepoPath,
  commit: z.boolean().optional().default(false)
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
export * from './quotaBurnValidation.js';
export * from './spriteValidation.js';
export * from './agentContextValidation.js';
