/**
 * Agent Activity Routes
 *
 * Get activity logs for agents and their platform actions.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  validateRequest,
  agentActivityQuerySchema,
  agentActivityTimelineQuerySchema,
  agentActivityAgentParamsSchema,
  agentActivityAgentQuerySchema,
  agentActivityStatsQuerySchema,
  agentActivityCleanupSchema,
} from '../lib/validation.js';
import { runEventsQuerySchema, runEventProjectionsQuerySchema, runEventProjectionIdSchema, runEventReconcileSchema } from '../lib/cosValidation.js';
import * as agentActivity from '../services/agentActivity.js';
import * as runEventLog from '../services/agentRunEventLog.js';
import * as runReconciler from '../services/agentRunReconciler.js';

const router = Router();

// GET / - Get recent activity across all agents
router.get('/', asyncHandler(async (req, res) => {
  const { limit, agentIds, action } = validateRequest(agentActivityQuerySchema, req.query);

  res.json(await agentActivity.getRecentActivities({
    limit,
    agentIds: agentIds ?? null,
    action: action ?? null
  }));
}));

// GET /timeline - Get activity timeline (for infinite scroll)
router.get('/timeline', asyncHandler(async (req, res) => {
  const { limit, agentIds, before } = validateRequest(agentActivityTimelineQuerySchema, req.query);

  res.json(await agentActivity.getActivityTimeline({
    limit,
    agentIds: agentIds ?? null,
    beforeTimestamp: before ?? null
  }));
}));

// GET /agent/:agentId - Get activities for specific agent
router.get('/agent/:agentId', asyncHandler(async (req, res) => {
  const { agentId } = validateRequest(agentActivityAgentParamsSchema, req.params);
  const { date, limit, offset, action } = validateRequest(agentActivityAgentQuerySchema, req.query);

  res.json(await agentActivity.getActivities(agentId, {
    // A `YYYY-MM-DD` string, which getActivityFilePath consumes as-is.
    date: date ?? null,
    limit,
    offset,
    action: action ?? null
  }));
}));

// GET /agent/:agentId/stats - Get activity stats for agent
router.get('/agent/:agentId/stats', asyncHandler(async (req, res) => {
  const { agentId } = validateRequest(agentActivityAgentParamsSchema, req.params);
  const { days } = validateRequest(agentActivityStatsQuerySchema, req.query);

  res.json(await agentActivity.getAgentStats(agentId, days));
}));

// POST /cleanup - Clean up old activity files. Destructive: it unlinks every
// day file older than the window, so the schema's 1-day floor is what stands
// between a mistyped client call and the whole archive.
router.post('/cleanup', asyncHandler(async (req, res) => {
  const { daysToKeep } = validateRequest(agentActivityCleanupSchema, req.body ?? {});

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

// GET /run-events/reconcile - Where the ledger and the run records disagree.
// Read-only: it reports drift, it never resolves it. The POST below is the only
// thing that writes, and it is a POST precisely because closing a run record is
// a mutation a user has to ask for.
router.get('/run-events/reconcile', asyncHandler(async (req, res) => {
  const query = validateRequest(runEventReconcileSchema, req.query);
  res.json(await runReconciler.getRunReconciliation(query));
}));

// POST /run-events/reconcile - Close the run records the ledger proves are done
router.post('/run-events/reconcile', asyncHandler(async (req, res) => {
  const body = validateRequest(runEventReconcileSchema, req.body ?? {});
  res.json(await runReconciler.repairRunRecords(body));
}));

// GET /run-events/run/:id - One run's projection plus the events behind it
router.get('/run-events/run/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(runEventProjectionIdSchema, req.params);
  res.json(await runEventLog.getRunDiagnostic(id));
}));

export default router;
