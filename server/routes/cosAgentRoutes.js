/**
 * CoS Agent Management Routes
 */

import { Router } from 'express';
import * as cos from '../services/cos.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/cos/health - Get health status
router.get('/health', asyncHandler(async (req, res) => {
  const health = await cos.getHealthStatus();
  res.json(health);
}));

// POST /api/cos/health/check - Force health check
router.post('/health/check', asyncHandler(async (req, res) => {
  const result = await cos.runHealthCheck();
  res.json(result);
}));

// GET /api/cos/agents - Get state-resident agents (running + recently completed, auto-cleans zombies)
// Strips output arrays from listing — output is loaded on demand via GET /agents/:id
router.get('/agents', asyncHandler(async (req, res) => {
  await cos.cleanupZombieAgents();
  const agents = await cos.getAgents();
  res.json(agents.map(({ output, ...rest }) => rest));
}));

// GET /api/cos/agents/history - Get available date buckets with counts
router.get('/agents/history', asyncHandler(async (req, res) => {
  const dates = await cos.getAgentDates();
  res.json({ dates });
}));

// GET /api/cos/agents/history/:date - Get completed agents for a date
router.get('/agents/history/:date', asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ServerError('Invalid date format (expected YYYY-MM-DD)', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const agents = await cos.getAgentsByDate(date);
  res.json(agents);
}));

// GET /api/cos/agents/:id - Get agent by ID
router.get('/agents/:id', asyncHandler(async (req, res) => {
  const agent = await cos.getAgent(req.params.id);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(agent);
}));

// POST /api/cos/agents/:id/terminate - Terminate agent (graceful SIGTERM, then SIGKILL)
router.post('/agents/:id/terminate', asyncHandler(async (req, res) => {
  const result = await cos.terminateAgent(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/kill - Force kill agent (immediate SIGKILL)
router.post('/agents/:id/kill', asyncHandler(async (req, res) => {
  const result = await cos.killAgent(req.params.id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// GET /api/cos/agents/:id/stats - Get process stats for agent (CPU, memory)
router.get('/agents/:id/stats', asyncHandler(async (req, res) => {
  const stats = await cos.getAgentProcessStats(req.params.id);
  // Return success with active:false instead of 404 - this is expected when process isn't running
  res.json(stats || { active: false, pid: null });
}));

// DELETE /api/cos/agents/completed - Clear completed agents (must be before :id route)
router.delete('/agents/completed', asyncHandler(async (req, res) => {
  const result = await cos.clearCompletedAgents();
  res.json(result);
}));

// DELETE /api/cos/agents/:id - Delete a single agent
router.delete('/agents/:id', asyncHandler(async (req, res) => {
  const result = await cos.deleteAgent(req.params.id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// POST /api/cos/agents/:id/feedback - Submit feedback for completed agent
router.post('/agents/:id/feedback', asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;

  if (rating === undefined || !['positive', 'negative', 'neutral'].includes(rating)) {
    throw new ServerError('rating must be positive, negative, or neutral', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await cos.submitAgentFeedback(req.params.id, { rating, comment });
  if (result?.error) {
    const isNotFound = result.error === 'Agent not found';
    throw new ServerError(result.error, {
      status: isNotFound ? 404 : 400,
      code: isNotFound ? 'NOT_FOUND' : 'INVALID_STATE'
    });
  }
  res.json(result);
}));

// POST /api/cos/agents/:id/btw - Send additional context to a running agent
router.post('/agents/:id/btw', asyncHandler(async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new ServerError('message is required and must be a non-empty string', { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (message.length > 5000) {
    throw new ServerError('message must be 5000 characters or less', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await cos.sendBtwToAgent(req.params.id, message.trim());
  if (result?.error) {
    const isNotFound = result.error === 'Agent not found';
    throw new ServerError(result.error, {
      status: isNotFound ? 404 : 400,
      code: isNotFound ? 'NOT_FOUND' : 'INVALID_STATE'
    });
  }
  res.json(result);
}));

// GET /api/cos/feedback/stats - Get feedback statistics
router.get('/feedback/stats', asyncHandler(async (req, res) => {
  const stats = await cos.getFeedbackStats();
  res.json(stats);
}));

export default router;
