/**
 * CoS Agent Management Routes
 */

import { Router } from 'express';
import { z } from 'zod';
import * as cos from '../services/cos.js';
// Lifecycle transitions go through the facade (#3450), not the `cos.js` barrel.
import * as agentOrchestrator from '../services/agentOrchestrator.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { toAgentListItems } from '../lib/cosAgentListProjection.js';
import { validateRequest, resumeCosAgentSchema, relaunchCosAgentSchema } from '../lib/validation.js';

const router = Router();

// `reason` is persisted into task metadata + interpolated into logs; guard the
// shape so a non-string body can't store `[object Object]`.
const pauseBodySchema = z.object({ reason: z.string().max(500).optional() });

// GET /agents/:id?lines=N — how many TAIL transcript lines to hydrate. The
// service defaults to `AGENT_OUTPUT_TAIL_LINES` and the ceiling here keeps a
// hand-written query from re-opening the unbounded read this cap closed (#3498).
const agentQuerySchema = z.object({
  lines: z.coerce.number().int().positive().max(10000).optional()
});

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
// Output arrays and over-long task descriptions are stripped from every listing
// here — both are loaded on demand via GET /agents/:id. See cosAgentListProjection.js.
router.get('/agents', asyncHandler(async (req, res) => {
  // Zombie cleanup probes the standalone runner and can wait up to its
  // transport timeout when that optional process is restarting or offline.
  // The state listing is still useful while that repair runs, so keep cleanup
  // off the response critical path and let it complete independently; the next
  // normal refresh will see any repaired records.
  void cos.cleanupZombieAgents().catch((err) => {
    console.error(`🧹 Background zombie cleanup failed: ${err.message}`);
  });
  const agents = await cos.getAgents();
  res.json(toAgentListItems(agents));
}));

// GET /api/cos/agents/history - Get available date buckets with counts
//
// `?hydrate=1` also returns the newest bucket's agents. The Agents tab always
// wants them, but it cannot ask for them until this response names the date —
// so without this the tab pays two SERIAL round trips before a single archived
// card appears, which is the whole visible delay on a high-latency link.
// It stays opt-in because hydrating reads a whole date bucket off disk, which a
// caller that only wants the counts should not pay for.
const historyQuerySchema = z.object({ hydrate: z.literal('1').optional() });

router.get('/agents/history', asyncHandler(async (req, res) => {
  const { hydrate } = validateRequest(historyQuerySchema, req.query);
  const dates = await cos.getAgentDates();
  if (!hydrate) return res.json({ dates });
  // `latest: null` is the answer for an install with no archived runs at all —
  // distinct from a bucket that read back empty, which the client must not
  // mistake for "not hydrated" and re-request.
  const latestDate = dates[0]?.date;
  const latest = latestDate
    ? { date: latestDate, agents: toAgentListItems(await cos.getAgentsByDate(latestDate)) }
    : null;
  res.json({ dates, latest });
}));

// GET /api/cos/agents/history/:date - Get completed agents for a date
router.get('/agents/history/:date', asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ServerError('Invalid date format (expected YYYY-MM-DD)', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const agents = await cos.getAgentsByDate(date);
  res.json(toAgentListItems(agents));
}));

// GET /api/cos/agents/feedback/pending - Reconciled durable feedback actions.
// The queue owns the action mutation; this endpoint feeds the Agents tab with
// the same live/archive predicate and count without loading every date bucket.
router.get('/agents/feedback/pending', asyncHandler(async (req, res) => {
  const pending = await cos.getPendingAgentFeedback({ includeUnavailable: true });
  res.json({
    count: pending.count,
    agents: toAgentListItems(pending.agents),
    unavailable: pending.unavailable,
  });
}));

// GET /api/cos/agents/:id - Get agent by ID (transcript hydrated as a capped tail)
router.get('/agents/:id', asyncHandler(async (req, res) => {
  const { lines } = validateRequest(agentQuerySchema, req.query);
  const agent = await cos.getAgent(req.params.id, lines ? { limit: lines } : {});
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(agent);
}));

// GET /api/cos/agents/:id/prompt - Read the prompt.txt saved at spawn time
// The service throws a ServerError (404) when the agent or prompt file is
// missing — asyncHandler renders the standard envelope.
router.get('/agents/:id/prompt', asyncHandler(async (req, res) => {
  const result = await cos.getAgentPrompt(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/terminate - Request termination (graceful SIGTERM, then SIGKILL)
// This only emits `agent:terminate` and returns immediately; the spawner's
// handler runs the actual SIGTERM/SIGKILL sequence.
router.post('/agents/:id/terminate', asyncHandler(async (req, res) => {
  const result = await agentOrchestrator.requestAgentTermination(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/pause - Stop process, preserve task/worktree for later resume
// pauseAgent throws a ServerError — 404 when the agent is missing, 500 when the
// runner/persist step fails — so no result-shape string-matching here.
router.post('/agents/:id/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(pauseBodySchema, req.body ?? {});
  const result = await agentOrchestrator.pauseAgent(req.params.id, reason || null);
  res.json(result);
}));

// POST /api/cos/agents/:id/resume - Requeue a paused agent's own task on the
// branch/worktree its run left behind, and retire the paused record.
// resumeAgent throws a ServerError — 404 when the agent is missing, 409 when it
// isn't paused, 500 when the requeue write fails.
router.post('/agents/:id/resume', asyncHandler(async (req, res) => {
  const overrides = validateRequest(resumeCosAgentSchema, req.body ?? {});
  const result = await agentOrchestrator.resumeAgent(req.params.id, overrides);
  res.json(result);
}));

// POST /api/cos/agents/:id/relaunch - Stop a RUNNING agent and requeue its own
// task on a different provider/model/effort (see relaunchAgent for why).
// relaunchAgent throws a ServerError — 404 when the agent is missing, 409 when
// it isn't running, 500 when the pause or requeue write fails.
router.post('/agents/:id/relaunch', asyncHandler(async (req, res) => {
  const overrides = validateRequest(relaunchCosAgentSchema, req.body ?? {});
  const result = await agentOrchestrator.relaunchAgent(req.params.id, overrides);
  res.json(result);
}));

// POST /api/cos/agents/:id/kill - Force kill agent (immediate SIGKILL)
// killAgent throws a ServerError — 404 when the agent is missing, 500 when the
// runner termination fails — so no result-shape string-matching here.
router.post('/agents/:id/kill', asyncHandler(async (req, res) => {
  const result = await agentOrchestrator.killAgent(req.params.id);
  res.json(result);
}));

// GET /api/cos/agents/:id/stats - Get process stats for agent (CPU, memory)
router.get('/agents/:id/stats', asyncHandler(async (req, res) => {
  const stats = await agentOrchestrator.getAgentProcessStats(req.params.id);
  // Return success with active:false instead of 404 - this is expected when process isn't running
  res.json(stats || { active: false, pid: null });
}));

// DELETE /api/cos/agents/completed - Clear completed agents (must be before :id route)
router.delete('/agents/completed', asyncHandler(async (req, res) => {
  const result = await cos.clearCompletedAgents();
  res.json(result);
}));

// DELETE /api/cos/agents/:id - Delete a single agent
// The service throws a ServerError (404) when the agent doesn't exist.
router.delete('/agents/:id', asyncHandler(async (req, res) => {
  const result = await cos.deleteAgent(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/feedback - Submit feedback for completed agent
router.post('/agents/:id/feedback', asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;

  if (rating === undefined || !['positive', 'negative', 'neutral'].includes(rating)) {
    throw new ServerError('rating must be positive, negative, or neutral', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // The service throws a ServerError — 404 when the agent is missing, 400
  // (INVALID_STATE) when it isn't completed — so no result-shape mapping here.
  const result = await cos.submitAgentFeedback(req.params.id, { rating, comment });
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

  // The service throws a ServerError — 404 when the agent is missing, 400
  // (INVALID_STATE) for the not-running / not-a-Claude-TUI refusals — so no
  // result-shape string-matching here.
  const result = await cos.sendBtwToAgent(req.params.id, message.trim());
  res.json(result);
}));

// GET /api/cos/feedback/stats - Get feedback statistics
router.get('/feedback/stats', asyncHandler(async (req, res) => {
  const stats = await cos.getFeedbackStats();
  res.json(stats);
}));

export default router;
