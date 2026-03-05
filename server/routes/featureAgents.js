/**
 * Feature Agents API Routes
 */

import { Router } from 'express';
import * as featureAgents from '../services/featureAgents.js';
import { validateRequest, featureAgentSchema, featureAgentUpdateSchema } from '../lib/validation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET / - List all feature agents
router.get('/', asyncHandler(async (req, res) => {
  const agents = await featureAgents.getAllFeatureAgents();
  res.json(agents);
}));

// GET /:id - Get single feature agent with recent runs
router.get('/:id', asyncHandler(async (req, res) => {
  const agent = await featureAgents.getFeatureAgent(req.params.id);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  const runs = await featureAgents.getFeatureAgentRuns(req.params.id, 5);
  res.json({ ...agent, recentRuns: runs });
}));

// POST / - Create feature agent
router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(featureAgentSchema, req.body);
  const agent = await featureAgents.createFeatureAgent(data);
  res.status(201).json(agent);
}));

// PUT /:id - Update feature agent
router.put('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(featureAgentUpdateSchema, req.body);
  const agent = await featureAgents.updateFeatureAgent(req.params.id, data);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.json(agent);
}));

// DELETE /:id - Delete feature agent
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await featureAgents.deleteFeatureAgent(req.params.id);
  if (!deleted) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.status(204).end();
}));

// POST /:id/start - Activate (creates worktree on first start)
router.post('/:id/start', asyncHandler(async (req, res) => {
  const agent = await featureAgents.activateFeatureAgent(req.params.id);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.json(agent);
}));

// POST /:id/pause - Pause scheduling
router.post('/:id/pause', asyncHandler(async (req, res) => {
  const agent = await featureAgents.pauseFeatureAgent(req.params.id);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.json(agent);
}));

// POST /:id/resume - Resume scheduling
router.post('/:id/resume', asyncHandler(async (req, res) => {
  const agent = await featureAgents.resumeFeatureAgent(req.params.id);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.json(agent);
}));

// POST /:id/trigger - Force immediate run
router.post('/:id/trigger', asyncHandler(async (req, res) => {
  const agent = await featureAgents.triggerFeatureAgent(req.params.id);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ triggered: true, agent });
}));

// POST /:id/stop - Deactivate fully
router.post('/:id/stop', asyncHandler(async (req, res) => {
  const agent = await featureAgents.stopFeatureAgent(req.params.id);
  if (!agent) throw new ServerError('Feature agent not found', { status: 404, code: 'NOT_FOUND' });
  res.json(agent);
}));

// GET /:id/runs - Run history
router.get('/:id/runs', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const runs = await featureAgents.getFeatureAgentRuns(req.params.id, limit);
  res.json(runs);
}));

// GET /:id/output - Live output
router.get('/:id/output', asyncHandler(async (req, res) => {
  const output = await featureAgents.getFeatureAgentOutput(req.params.id);
  if (!output) {
    res.json({ agentId: null, output: '' });
    return;
  }
  res.json(output);
}));

export default router;
