import { persistentMindMaintainerSchema } from '../lib/persistent/persistentMindMaintainer.js';
/**
 * CoS Status, Config, and Lifecycle Routes
 */

import { Router } from 'express';
import { getConfig } from '../services/cos/cosState.js';
import { RETIRED_CONFIG_KEYS } from '../lib/cos/cosRetiredConfigKeys.js';
import { getStatus, pause, resume, start, stop, updateConfig } from '../services/cos/cos.js';
import { getAllDomainUsageToday } from '../services/domainUsage.js';
import { reinitialize as reinitializeEmbeddings } from '../services/memoryEmbeddings.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { getProviderById } from '../services/provider/providers.js';
import { validateRequest } from '../lib/validateRequest.js';
import { z } from 'zod';
import { CREATIVE_DOMAIN_ID, DOMAIN_IDS, DOMAIN_MODES } from '../lib/domainAutonomy.js';
import { AVATAR_VARIANT_PATTERN, RIGGED_VARIANT_PREFIX } from '../lib/avatarVariants.js';
// Single source of truth for the avatar-style vocabulary (#6253); the client
// picker re-exports the same leaf.
import { AVATAR_STYLE_IDS } from '../lib/avatarStyles.js';
import { BUDGET_LIMIT_FIELDS } from '../lib/domainBudgets.js';
import { persistentMindCapabilitiesSchema } from '../lib/persistent/persistentMindCapabilities.js';
import { persistentMindProfileSchema, persistentMindToolFreeRefusal } from '../lib/persistent/persistentMindProfile.js';
import { persistentMindThinkingPresetsSchema } from '../lib/persistent/persistentMindThinkingPresets.js';
import { persistentMindPromptSchema } from '../lib/persistent/persistentMindPrompt.js';
import { persistentMindPlaybookSchema } from '../lib/persistent/persistentMindPlaybook.js';
import { OUTWARD_SAFETY_KINDS } from '../services/taskLearning/safetyKind.js';

const router = Router();

const pauseSchema = z.object({
  reason: z.string().optional(),
});

export const cosConfigSchema = z.object({
  healthCheckIntervalMs: z.number().int().min(1000).optional(),
  maxConcurrentAgents: z.number().int().min(1).optional(),
  maxConcurrentAgentsPerProject: z.number().int().min(1).optional(),
  maxTotalProcesses: z.number().int().min(1).optional(),
  autoStart: z.boolean().optional(),
  selfImprovementEnabled: z.boolean().optional(),
  appImprovementEnabled: z.boolean().optional(),
  improvementEnabled: z.boolean().optional(),
  // Built-in styles plus selectable rigged records (`rigged-<modelId>`, #5894).
  // The record half reuses the avatar variant charset (no slashes, no dots —
  // the same traversal guard `server/routes/avatar.js` enforces), so unknown
  // spellings still 400 here instead of persisting a style nothing can render.
  avatarStyle: z.union([
    z.enum(AVATAR_STYLE_IDS),
    z.string().startsWith(RIGGED_VARIANT_PREFIX).refine(
      (value) => AVATAR_VARIANT_PATTERN.test(value.slice(RIGGED_VARIANT_PREFIX.length)),
    ),
  ]).optional(),
  dynamicAvatar: z.boolean().optional(),
  alwaysOn: z.boolean().optional(),
  appReviewCooldownMs: z.number().int().min(0).optional(),
  idleReviewEnabled: z.boolean().optional(),
  idleReviewPriority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  // Accept retired fields from cached/older clients, then discard them in the
  // transform below so they cannot be re-persisted.
  comprehensiveAppImprovement: z.boolean().optional(),
  immediateExecution: z.boolean().optional(),
  proactiveMode: z.boolean().optional(),
  // Config keys nothing reads any more (see RETIRED_CONFIG_KEYS): cached clients
  // may still echo them back, so accept any value and discard it below.
  ...Object.fromEntries(RETIRED_CONFIG_KEYS.map((key) => [key, z.unknown().optional()])),
  autonomousJobsEnabled: z.boolean().optional(),
  autonomyLevel: z.enum(['standby', 'assistant', 'manager', 'yolo']).optional(),
  autoApproveInvestigations: z.boolean().optional(),
  // A durable reasoning route for the persistent mind. It is separate from
  // `alwaysOn`: saving or enabling this profile never starts background work.
  persistentMindMaintainer: persistentMindMaintainerSchema.optional(),
  persistentMindProfile: persistentMindProfileSchema.optional(),
  // Saved alternates one message may borrow for a single turn. Storing them
  // changes nothing about the route the mind wakes on by default.
  persistentMindThinkingPresets: persistentMindThinkingPresetsSchema.optional(),
  persistentMindPrompt: persistentMindPromptSchema.optional(),
  persistentMindPlaybook: persistentMindPlaybookSchema.optional(),
  // Separate opt-in action grant: an enabled reasoning profile does not imply
  // authority to create and execute agent tasks.
  persistentMindCapabilities: persistentMindCapabilitiesSchema.optional(),
  // Per-domain autonomy guardrails (#711): partial map of domainId → mode.
  // Partial is fine — updateConfig() merges it over the stored map.
  // `creative` (#2183, #18144) also accepts `null` to clear an explicit override
  // and return to mirroring `cos`.
  domainAutonomy: z.object({
    ...Object.fromEntries(DOMAIN_IDS.map((id) => [id, z.enum(DOMAIN_MODES).optional()])),
    [CREATIVE_DOMAIN_ID]: z.enum(DOMAIN_MODES).nullable().optional(),
  }).strict().optional(),
  // Per-domain daily budgets (#711): partial map of domainId → { cap → value }.
  // Each cap is a non-negative integer or null (clear). Partial is fine —
  // updateConfig() field-merges it over the stored map. 0/null = unlimited.
  domainBudgets: z.object(
    Object.fromEntries(DOMAIN_IDS.map((id) => [
      id,
      z.object(
        Object.fromEntries(BUDGET_LIMIT_FIELDS.map((f) => [f, z.number().int().min(0).nullable().optional()]))
      ).strict().optional()
    ]))
  ).strict().optional(),
  completedAgentRetentionMs: z.number().int().min(0).optional(),
  embeddingProviderId: z.string().optional(),
  embeddingModel: z.string().optional(),
  // Confidence auto-approval is read on every improvement task. Partial
  // objects are field-merged in updateConfig(); when both thresholds are in
  // this patch, low must not exceed high (the merge also checks stored siblings).
  confidenceAutoApproval: z.object({
    enabled: z.boolean().optional(),
    highThreshold: z.number().int().min(0).max(100).optional(),
    lowThreshold: z.number().int().min(0).max(100).optional(),
    minSamples: z.number().int().min(1).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.lowThreshold != null && value.highThreshold != null && value.lowThreshold > value.highThreshold) {
      ctx.addIssue({
        code: 'custom',
        path: ['lowThreshold'],
        message: 'lowThreshold must be less than or equal to highThreshold',
      });
    }
  }).optional(),
  // Safety-kind override (#2440): which outward-facing/irreversible kinds always
  // require human approval, orthogonal to confidence. updateConfig() field-merges
  // the object; alwaysApproveKinds, when present, replaces the list.
  safetyKindApproval: z.object({
    enabled: z.boolean().optional(),
    alwaysApproveKinds: z.array(z.enum(OUTWARD_SAFETY_KINDS)).optional()
  }).strict().optional()
}).strict().transform((config) => {
  const supportedConfig = { ...config };
  delete supportedConfig.autonomyLevel;
  delete supportedConfig.comprehensiveAppImprovement;
  delete supportedConfig.immediateExecution;
  delete supportedConfig.proactiveMode;
  for (const key of RETIRED_CONFIG_KEYS) delete supportedConfig[key];
  return supportedConfig;
});

// GET /api/cos - Get CoS status
router.get('/', asyncHandler(async (req, res) => {
  const status = await getStatus();
  res.json(status);
}));

// POST /api/cos/start - Start CoS daemon
router.post('/start', asyncHandler(async (req, res) => {
  const result = await start();
  res.json(result);
}));

// POST /api/cos/stop - Stop CoS daemon
router.post('/stop', asyncHandler(async (req, res) => {
  const result = await stop();
  res.json(result);
}));

// POST /api/cos/pause - Pause CoS daemon (stays running but skips evaluations)
router.post('/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(pauseSchema, req.body);
  const result = await pause(reason);
  res.json(result);
}));

// POST /api/cos/resume - Resume CoS daemon from pause
router.post('/resume', asyncHandler(async (req, res) => {
  const result = await resume();
  res.json(result);
}));

// GET /api/cos/config - Get configuration
router.get('/config', asyncHandler(async (req, res) => {
  const config = await getConfig();
  res.json(config);
}));

// GET /api/cos/budget-usage - Today's per-domain autonomy usage (for the
// Domain Budgets panel). Reflects the rolling daily ledger that budgets gate on.
router.get('/budget-usage', asyncHandler(async (req, res) => {
  const usage = await getAllDomainUsageToday();
  res.json(usage);
}));

// The mind wakes unattended over third-party text, so a home or thinking-preset
// provider that cannot run tool-free is refused at save time. A stored route
// that predates this check is refused when it resolves (services/persistent/persistentMindProfile.js).
async function assertMindRoutesToolFree(config) {
  const providerIds = new Set([
    config.persistentMindProfile?.providerId,
    ...(config.persistentMindThinkingPresets?.presets ?? []).map((preset) => preset.providerId),
  ].filter(Boolean));
  for (const providerId of providerIds) {
    const provider = await getProviderById(providerId);
    const refusal = provider ? persistentMindToolFreeRefusal(provider) : null;
    if (refusal) throw new ServerError(refusal, { status: 400, code: 'PROVIDER_NOT_TOOL_FREE' });
  }
}

// PUT /api/cos/config - Update configuration
router.put('/config', asyncHandler(async (req, res) => {
  const validated = validateRequest(cosConfigSchema, req.body);
  await assertMindRoutesToolFree(validated);
  const config = await updateConfig(validated);
  if (validated.embeddingProviderId !== undefined || validated.embeddingModel !== undefined) {
    reinitializeEmbeddings();
  }
  res.json(config);
}));

export default router;
