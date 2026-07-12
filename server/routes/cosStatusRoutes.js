/**
 * CoS Status, Config, and Lifecycle Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import { getAllDomainUsageToday } from '../services/domainUsage.js';
import * as taskWatcher from '../services/taskWatcher.js';
import { reinitialize as reinitializeEmbeddings } from '../services/memoryEmbeddings.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { z } from 'zod';
import { DOMAIN_IDS, DOMAIN_MODES } from '../lib/domainAutonomy.js';
import { BUDGET_LIMIT_FIELDS } from '../lib/domainBudgets.js';

const router = Router();

const pauseSchema = z.object({
  reason: z.string().optional(),
});

export const cosConfigSchema = z.object({
  userTasksFile: z.string().optional(),
  cosTasksFile: z.string().optional(),
  goalsFile: z.string().optional(),
  healthCheckIntervalMs: z.number().int().min(1000).optional(),
  maxConcurrentAgents: z.number().int().min(1).optional(),
  maxConcurrentAgentsPerProject: z.number().int().min(1).optional(),
  maxProcessMemoryMb: z.number().int().min(128).optional(),
  maxTotalProcesses: z.number().int().min(1).optional(),
  mcpServers: z.array(z.object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional()
  })).optional(),
  autoStart: z.boolean().optional(),
  selfImprovementEnabled: z.boolean().optional(),
  appImprovementEnabled: z.boolean().optional(),
  improvementEnabled: z.boolean().optional(),
  avatarStyle: z.enum(['svg', 'ascii', 'cyber', 'sigil', 'esoteric', 'nexus', 'muse', 'miniMaleC', 'miniFemaleD']).optional(),
  dynamicAvatar: z.boolean().optional(),
  alwaysOn: z.boolean().optional(),
  appReviewCooldownMs: z.number().int().min(0).optional(),
  idleReviewEnabled: z.boolean().optional(),
  idleReviewPriority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  comprehensiveAppImprovement: z.boolean().optional(),
  immediateExecution: z.boolean().optional(),
  proactiveMode: z.boolean().optional(),
  autonomousJobsEnabled: z.boolean().optional(),
  autonomyLevel: z.enum(['standby', 'assistant', 'manager', 'yolo']).optional(),
  // Per-domain autonomy guardrails (#711): partial map of domainId → mode.
  // Partial is fine — updateConfig() merges it over the stored map.
  domainAutonomy: z.object(
    Object.fromEntries(DOMAIN_IDS.map((id) => [id, z.enum(DOMAIN_MODES).optional()]))
  ).strict().optional(),
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
  rehabilitationGracePeriodDays: z.number().int().min(1).optional(),
  completedAgentRetentionMs: z.number().int().min(0).optional(),
  embeddingProviderId: z.string().optional(),
  embeddingModel: z.string().optional(),
  autoFixThresholds: z.object({
    maxLinesChanged: z.number().int().min(1).optional(),
    allowedCategories: z.array(z.string()).optional()
  }).optional(),
  // Safety-kind override (#2440): which outward-facing/irreversible kinds always
  // require human approval, orthogonal to confidence. updateConfig() replaces the
  // whole object, so the client sends the full slice.
  safetyKindApproval: z.object({
    enabled: z.boolean().optional(),
    alwaysApproveKinds: z.array(z.string()).optional()
  }).strict().optional()
}).strict();

// GET /api/cos - Get CoS status
router.get('/', asyncHandler(async (req, res) => {
  const status = await cos.getStatus();
  res.json(status);
}));

// POST /api/cos/start - Start CoS daemon
router.post('/start', asyncHandler(async (req, res) => {
  const result = await cos.start();
  await taskWatcher.startWatching();
  res.json(result);
}));

// POST /api/cos/stop - Stop CoS daemon
router.post('/stop', asyncHandler(async (req, res) => {
  const result = await cos.stop();
  await taskWatcher.stopWatching();
  res.json(result);
}));

// POST /api/cos/pause - Pause CoS daemon (stays running but skips evaluations)
router.post('/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(pauseSchema, req.body);
  const result = await cos.pause(reason);
  res.json(result);
}));

// POST /api/cos/resume - Resume CoS daemon from pause
router.post('/resume', asyncHandler(async (req, res) => {
  const result = await cos.resume();
  res.json(result);
}));

// GET /api/cos/config - Get configuration
router.get('/config', asyncHandler(async (req, res) => {
  const config = await cos.getConfig();
  res.json(config);
}));

// GET /api/cos/budget-usage - Today's per-domain autonomy usage (for the
// Domain Budgets panel). Reflects the rolling daily ledger that budgets gate on.
router.get('/budget-usage', asyncHandler(async (req, res) => {
  const usage = await getAllDomainUsageToday();
  res.json(usage);
}));

// PUT /api/cos/config - Update configuration
router.put('/config', asyncHandler(async (req, res) => {
  const validated = validateRequest(cosConfigSchema, req.body);
  const config = await cos.updateConfig(validated);
  if (validated.embeddingProviderId !== undefined || validated.embeddingModel !== undefined) {
    reinitializeEmbeddings();
  }
  res.json(config);
}));

export default router;
