/**
 * CoS Status, Config, and Lifecycle Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import { reinitialize as reinitializeEmbeddings } from '../services/memoryEmbeddings.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { z } from 'zod';

const router = Router();

export const cosConfigSchema = z.object({
  userTasksFile: z.string().optional(),
  cosTasksFile: z.string().optional(),
  goalsFile: z.string().optional(),
  evaluationIntervalMs: z.number().int().min(1000).optional(),
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
  avatarStyle: z.enum(['svg', 'ascii', 'cyber', 'sigil', 'esoteric', 'nexus']).optional(),
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
  rehabilitationGracePeriodDays: z.number().int().min(1).optional(),
  completedAgentRetentionMs: z.number().int().min(0).optional(),
  embeddingProviderId: z.string().optional(),
  embeddingModel: z.string().optional(),
  autoFixThresholds: z.object({
    maxLinesChanged: z.number().int().min(1).optional(),
    allowedCategories: z.array(z.string()).optional()
  }).optional()
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
  const { reason } = req.body;
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
