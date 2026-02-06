/**
 * Agent Activity Routes
 *
 * Get activity logs for agents and their platform actions.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import * as agentActivity from '../services/agentActivity.js';

const router = Router();

// GET / - Get recent activity across all agents
router.get('/', asyncHandler(async (req, res) => {
  console.log('📊 GET /api/agents/activity');
  const { limit = 50, agentIds, action } = req.query;

  const activities = await agentActivity.getRecentActivities({
    limit: parseInt(limit, 10),
    agentIds: agentIds ? agentIds.split(',') : null,
    action: action || null
  });

  res.json(activities);
}));

// GET /timeline - Get activity timeline (for infinite scroll)
router.get('/timeline', asyncHandler(async (req, res) => {
  console.log('📊 GET /api/agents/activity/timeline');
  const { limit = 50, agentIds, before } = req.query;

  const activities = await agentActivity.getActivityTimeline({
    limit: parseInt(limit, 10),
    agentIds: agentIds ? agentIds.split(',') : null,
    beforeTimestamp: before || null
  });

  res.json(activities);
}));

// GET /agent/:agentId - Get activities for specific agent
router.get('/agent/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { date, limit = 100, offset = 0, action } = req.query;
  console.log(`📊 GET /api/agents/activity/agent/${agentId}`);

  const activities = await agentActivity.getActivities(agentId, {
    date: date ? new Date(date) : new Date(),
    limit: parseInt(limit, 10),
    offset: parseInt(offset, 10),
    action: action || null
  });

  res.json(activities);
}));

// GET /agent/:agentId/stats - Get activity stats for agent
router.get('/agent/:agentId/stats', asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const { days = 7 } = req.query;
  console.log(`📊 GET /api/agents/activity/agent/${agentId}/stats`);

  const stats = await agentActivity.getAgentStats(agentId, parseInt(days, 10));
  res.json(stats);
}));

// POST /cleanup - Clean up old activity files
router.post('/cleanup', asyncHandler(async (req, res) => {
  const { daysToKeep = 30 } = req.body;
  console.log(`📊 POST /api/agents/activity/cleanup (keep ${daysToKeep} days)`);

  const deletedCount = await agentActivity.cleanupOldActivity(daysToKeep);
  res.json({ success: true, deletedCount });
}));

export default router;
