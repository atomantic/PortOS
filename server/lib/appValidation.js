/**
 * Zod schemas for managed-app records, app integrations (Jira, DataDog), layered intelligence, app task-type overrides and app icons.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { APP_FEATURE_IDS } from './instanceFeatureRegistry.js';
import { emptyToUndefined, providerRefSchema, presetProviderIdSchema, partialWithoutDefaults } from './zodCompat.js';
import { LAYERED_INTELLIGENCE_SOURCE_KEYS } from './layeredIntelligenceSourceKeys.js';
import { isCronShaped, isValidCronExpression } from './cronValidation.js';
import { MERGE_METHODS, PR_COMPLETION_VALUES } from './prDisposition.js';
import { WORK_TRACKERS } from './workTracker.js';
import { nullishString } from './sharedSchemas.js';
import { XCODE_SCRIPT_NAMES } from './xcodeScriptNames.js';
import {
  FEATURE_PRIORITY_MAX_ENTRIES, FEATURE_PRIORITY_MAX_LABEL, FEATURE_PRIORITY_MAX_NOTE, FEATURE_PRIORITY_MAX_PATH, FEATURE_PRIORITY_MAX_PATHS,
  auditPathConflict, hasUnsafePromptChar,
} from './appFeaturePriorityRules.js';

// These strings are written into audit prompts, so they must be prompt-safe (see appFeaturePriorityRules.js).
const promptSafeText = (max) => z.string().trim().min(1).max(max)
  .refine((value) => !hasUnsafePromptChar(value), { message: 'must not contain control characters, quotes or backticks' });

// Hand-written path priority for one slice of a managed app. P1 is the default for every path no entry names.
export const appFeaturePrioritySchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: promptSafeText(FEATURE_PRIORITY_MAX_LABEL),
  paths: z.array(promptSafeText(FEATURE_PRIORITY_MAX_PATH)).min(1).max(FEATURE_PRIORITY_MAX_PATHS),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  note: z.string().trim().max(FEATURE_PRIORITY_MAX_NOTE).optional(),
});

export const appFeaturePrioritiesSchema = z.array(appFeaturePrioritySchema).max(FEATURE_PRIORITY_MAX_ENTRIES)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, { message: 'Feature priority ids must be unique' })
  .superRefine((entries, ctx) => {
    const message = auditPathConflict(entries);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

export const processSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  // `ports` is an open-ended label→port map so app-specific keys derived from
  // *_PORT env vars (coinbaseIpc, geminiIpc, etc.) survive validation alongside
  // the well-known labels (api, ui, devUi, cdp, health).
  ports: z.record(z.number().int().min(1).max(65535)).optional(),
  description: z.string().optional()
});

// JIRA integration config for apps
const jiraConfigSchema = z.object({
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
const datadogConfigSchema = z.object({
  enabled: z.boolean().default(false),
  instanceId: z.string().optional(),
  serviceName: z.string().optional(),
  environment: z.string().optional()
});

// Per-managed-app feature participation. An absent key or null means inherit
// the install-wide Settings > Features value; true/false is an app override.
// The app-level list intentionally excludes POST, which has no managed-app tab.
const appFeatureOverridesSchema = z.object(
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
const LAYERED_INTELLIGENCE_SCOPES = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];
export const layeredIntelligenceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(60_000).optional(),
  providerId: providerRefSchema.nullable().optional(),
  model: z.string().nullable().optional(),
  sources: z.object({
    // One optional toggle per built-in Layer-1 source; the ordered key list (and
    // what each source means) lives in layeredIntelligenceSourceKeys.js.
    ...Object.fromEntries(LAYERED_INTELLIGENCE_SOURCE_KEYS.map(key => [key, z.boolean().optional()])),
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

const nativeLaunchSchema = z.object({
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
  // Explicit lifecycle hook for managed-app updates. PortOS runs its own
  // update.sh/update.ps1; other apps must opt in instead of inheriting that
  // lifecycle from their package.json. Empty clears it.
  updateCommand: z.string().trim().max(500).optional(),
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
    // A cron-SHAPED override must also be in range, or this generic PUT would
    // persist an enabled schedule the walker can never match (#6634). A
    // non-cron-shaped string is a named/legacy cadence the route decodes, and
    // null clears the override back to inherit — both pass through untouched.
    interval: z.string().refine(
      (v) => !isCronShaped(v) || isValidCronExpression(v),
      'interval must be a valid 5-field cron expression'
    ).nullable().optional(),
    // Per-app scheduling fields for handler-backed tasks (e.g. layered-intelligence);
    // persisted by updateAppTaskTypeOverride. Nullable = "clear back to inherit/default".
    // Declared here so a generic PUT /api/apps/:id can't silently strip them (Zod drops
    // unknown keys and updateApp replaces taskTypeOverrides wholesale).
    intervalMs: z.number().positive().nullable().optional(),
    // PRESET-ONLY: an app pin is read straight off `providers.json` by the task
    // walker, so a composite (`harness.method@service`) would name a record
    // that never exists there (#7564).
    providerId: presetProviderIdSchema.nullable().optional(),
    model: z.string().nullable().optional(),
    taskMetadata: z.record(z.any()).nullable().optional()
  })).optional(), // Per-task overrides: { [taskType]: { enabled, interval, intervalMs, providerId, model, taskMetadata } }
  defaultUseWorktree: z.boolean().optional(),
  defaultOpenPR: z.boolean().optional(),
  // Omitted inherits reviewed PortOS auto-merge for new tasks; PATCH must not
  // inject a default over an existing explicit draft/leave-open preference.
  defaultPrCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
  // After a CoS agent completes against this app, audit the repo for the state the
  // task asked for (worktree removed, branch deleted, PR merged) and file a recovery
  // task when it diverges. See lib/repoStateExpectations.js. Unset = ON: an install
  // that never hears about a leaked branch just accumulates them.
  verifyRepoStateOnCompletion: z.boolean().optional(),
  mergeHandoffMinQueuedRuns: z.number().int().min(1).max(10000).nullable().optional(),
  // Agents enable GitHub native auto-merge once reviews pass. Unset = on for PortOS itself, off elsewhere (resolveUseAutoMerge).
  useAutoMerge: z.boolean().optional(),
  // Code-owner-blocked PRs (resolveAutoApprovePR / resolveAdminMerge). Unset = off everywhere, PortOS included.
  autoApprovePR: z.boolean().optional(),
  adminMerge: z.boolean().optional(),
  // Unset/false = off (default); true = land a `.quality.json` quality snapshot through an immediately-merged PR after each audit.
  publishQualitySnapshot: z.boolean().optional(),
  // Free-text deployment assumptions (who uses it, what runs beside the user)
  // every quality audit weighs reachability against. Empty clears it.
  deploymentModel: z.string().trim().max(2000).optional(),
  // Hand-written path priorities that scope this app's quality audits (see
  // resolveAuditPriorityScope). Optional local metadata: absent or [] means no scope.
  featurePriorities: appFeaturePrioritiesSchema.optional(),
  // Opt-in to the Skill Registry's `project` tier (#17387): the repo's
  // `.agents/skills/` and `.claude/skills/` are discovered, security-scanned
  // and offered to agents. Unset/false = never read (default off).
  skillDiscovery: z.boolean().optional(),
  featureOverrides: appFeatureOverridesSchema.optional(),
  jira: jiraConfigSchema.optional().nullable(),
  datadog: datadogConfigSchema.optional().nullable(),
  // Where this app's autonomous work items live (single source per app).
  // 'auto' (default) resolves to a concrete tracker from the git origin host
  // — see server/lib/workTracker.js + the `claim-work` router in
  // cosTaskGenerator.js. WORK_TRACKERS is the single source of truth for the
  // value set.
  workTracker: z.enum(WORK_TRACKERS).optional(),
  // The `gh` account login PortOS authenticates AND commits as for this app's
  // repo — how one install drives repos belonging to several GitHub accounts.
  // Unset (the default) keeps the owner-match inference in services/forgeAuth.js
  // and leaves commit authorship to the machine's ambient git config; setting it
  // pins both the token and the GIT_AUTHOR/GIT_COMMITTER identity to that
  // account. Empty string clears the pin.
  forgeAccount: z.string().trim().max(120).optional(),
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

// Partial schema for updates. referenceRepos is intentionally absent
// from appSchema (see comment there) so it can't sneak in via PUT
// either — all ref CRUD goes through /api/apps/:appId/reference-repos.
export const appUpdateSchema = partialWithoutDefaults(appSchema);

export const appIconQuerySchema = z.object({
  size: z.enum(['64', '128', '256']).default('128').transform(Number),
});

// Jira issue key (ABC-123) or numeric id — the value is interpolated into upstream REST paths.
export const jiraTicketKeySchema = z.string().max(64).regex(/^([A-Za-z][A-Za-z0-9_]*-\d+|\d+)$/, 'Invalid Jira ticket id');

// Per-app task-type overrides (routes/apps/taskTypes.js)
export const appTaskTypeToggleBodySchema = z.object({ enabled: z.boolean() });
export const appTaskTypeOverrideBodySchema = z.object({
  enabled: z.boolean().optional(),
  interval: nullishString,
  intervalMs: z.number().positive().finite().nullish(),
  providerId: nullishString,
  model: nullishString,
  taskMetadata: z.record(z.string(), z.unknown()).nullish(),
}).refine((body) => Object.values(body).some((value) => value !== undefined), {
  message: 'enabled (boolean), interval (string|null), intervalMs (number|null), providerId (string|null), model (string|null), or taskMetadata (object|null) required',
});

export const forgeAuthRefreshBodySchema = z.object({
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9:_.-]*$/i)).min(1).max(8),
});

export const forgeAuthJobParamsSchema = z.object({ id: z.string().min(1), jobId: z.string().uuid() });

export const pullRequestParamsSchema = z.object({
  number: z.coerce.number().int().positive(),
});

// The direct merge's only inputs; the tab always sends both. A caller that omits
// `deleteBranch` gets the conservative answer — the flag is irreversible on the
// forge, and the merge service refuses it outright for a long-lived head.
export const pullRequestMergeSchema = z.object({
  method: z.enum(MERGE_METHODS).optional(),
  deleteBranch: z.boolean().optional(),
});

export const upgradeTlsSchema = z.object({
  tlsPort: z.number().int().min(1).max(65535),
  force: z.boolean().optional()
});

export const fixViteHostsSchema = z.object({
  mode: z.enum(['allow-all', 'ai']).default('allow-all'),
  host: z.string().trim().optional()
});

export const xcodeInstallScriptsSchema = z.object({
  scripts: z.array(z.enum(XCODE_SCRIPT_NAMES)).min(1).max(XCODE_SCRIPT_NAMES.length)
});
