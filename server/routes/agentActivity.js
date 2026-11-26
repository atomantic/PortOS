/**
 * Agent Activity Routes
 *
 * Get activity logs for agents and their platform actions.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { runEventProjectionsQuerySchema, runEventProjectionIdSchema, runEventReconcileSchema } from '../lib/cos/cosValidation.js';
import * as agentActivity from '../services/agent/agentActivity.js';
import * as runEventLog from '../services/agent/agentRunEventLog.js';
import * as runReconciler from '../services/agent/agentRunReconciler.js';
import {
  agentActivityTimelineQuerySchema, agentActivityAgentParamsSchema,
  agentActivityStatsQuerySchema
} from '../lib/agentActivityValidation.js';

const router = Router();

// GET /timeline - Get activity timeline (for infinite scroll)
router.get('/timeline', asyncHandler(async (req, res) => {
  const { limit, agentIds, action, before } = validateRequest(agentActivityTimelineQuerySchema, req.query);

  res.json(await agentActivity.getActivityTimeline({ limit, agentIds, actions: action, beforeTimestamp: before }));
}));

// GET /agent/:agentId/stats - Get activity stats for agent
router.get('/agent/:agentId/stats', asyncHandler(async (req, res) => {
  const { agentId } = validateRequest(agentActivityAgentParamsSchema, req.params);
  const { days } = validateRequest(agentActivityStatsQuerySchema, req.query);

  res.json(await agentActivity.getAgentStats(agentId, days));
}));

// ---------------------------------------------------------------------------
// Run event ledger — read-only diagnostics (#4540)
//
// A literal `/run-events` prefix, disjoint from every path above it — the only
// parameterized route here is `/agent/:agentId`, so registration order is not
// load-bearing and these can stay at the bottom of the file.
// Every handler is a pure read: the ledger is append-only and is written from
// the agent lifecycle, never from HTTP. Payloads were redacted at append time
// (see `lib/agent/agentRunEvents.js`), so nothing here re-redacts — a route that had
// to redact on read would mean unredacted bytes were already on disk.
// ---------------------------------------------------------------------------

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
