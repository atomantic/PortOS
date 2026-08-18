/**
 * Agent Activity Routes
 *
 * Get activity logs for agents and their platform actions.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { runEventsQuerySchema, runEventProjectionsQuerySchema, runEventProjectionIdSchema } from '../lib/cosValidation.js';
import * as agentActivity from '../services/agentActivity.js';
import * as runEventLog from '../services/agentRunEventLog.js';

const router = Router();

// GET / - Get recent activity across all agents
router.get('/', asyncHandler(async (req, res) => {
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

  const stats = await agentActivity.getAgentStats(agentId, parseInt(days, 10));
  res.json(stats);
}));

// POST /cleanup - Clean up old activity files
router.post('/cleanup', asyncHandler(async (req, res) => {
  const { daysToKeep = 30 } = req.body;

  const deletedCount = await agentActivity.cleanupOldActivity(daysToKeep);
  res.json({ success: true, deletedCount });
}));

// ---------------------------------------------------------------------------
// Run event ledger — read-only diagnostics (#4540)
//
// A literal `/run-events` prefix, disjoint from every path above it — the only
// parameterized route here is `/agent/:agentId`, so registration order is not
// load-bearing and these can stay at the bottom of the file.
// Every handler is a pure read: the ledger is append-only and is written from
// the agent lifecycle, never from HTTP. Payloads were redacted at append time
// (see `lib/agentRunEvents.js`), so nothing here re-redacts — a route that had
// to redact on read would mean unredacted bytes were already on disk.
// ---------------------------------------------------------------------------

// GET /run-events - Raw lifecycle events in append order (newest-N window)
router.get('/run-events', asyncHandler(async (req, res) => {
  const query = validateRequest(runEventsQuerySchema, req.query);
  res.json(await runEventLog.readRunEvents(query));
}));

// GET /run-events/stats - Ledger size + the retention bound it is held to
router.get('/run-events/stats', asyncHandler(async (req, res) => {
  res.json(await runEventLog.getRunEventLedgerStats());
}));

// GET /run-events/projections - Current run status DERIVED from the stream
router.get('/run-events/projections', asyncHandler(async (req, res) => {
  const query = validateRequest(runEventProjectionsQuerySchema, req.query);
  res.json(await runEventLog.getRunProjections(query));
}));

// GET /run-events/run/:id - One run's projection plus the events behind it
router.get('/run-events/run/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(runEventProjectionIdSchema, req.params);
  res.json(await runEventLog.getRunDiagnostic(id));
}));

export default router;
