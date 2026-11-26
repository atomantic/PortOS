/**
 * CoS Agent Management Routes
 */

import { Router } from 'express';
import { deleteAgent, getAgent, getAgentPrompt, getAgentRecord, getAgents, sendBtwToAgent } from '../services/cos/cosAgentLifecycle.js';
import { requireCosOrphanRecoveryHandlers } from '../services/bootHookRegistry.js';
import { getTaskView } from '../services/cos/cosTaskStore.js';
import { clearCompletedAgents } from '../services/cos/cosAgentArchive.js';
import { getCompletedAgentPage } from '../services/cos/cosAgentIndex.js';
import { getFeedbackStats, getPendingAgentFeedback, getPendingAgentFeedbackCount, getPendingAgentFeedbackPage, submitAgentFeedback } from '../services/cos/cosAgentFeedback.js';
import { getHealthStatus, runHealthCheck } from '../services/cos/cosHealthMonitor.js';
// Lifecycle transitions go through the facade (#3450).
import * as agentOrchestrator from '../services/agent/agentOrchestrator.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { toAgentListItems } from '../lib/cos/cosAgentListProjection.js';
import { isDeliveryCleanupHeld, retryHoldOwnerId } from '../lib/taskRetryHold.js';
import { getDeliveryActivity } from '../services/agent/agentDeliveryActivity.js';
import { securityScanRequestSchema } from '../lib/securityScanEvidence.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  resumeCosAgentSchema,
  relaunchCosAgentSchema,
  cosAgentFeedbackBodySchema,
  cosAgentBtwBodySchema,
  claimOwnershipSchema,
  cosAgentCleanupRecheckSchema,
  cosAgentClaimSelectionSchema,
  cosAgentListQuerySchema,
  cosAgentPendingFeedbackQuerySchema,
  cosAgentMergeHandoffSchema,
  cosAgentPauseBodySchema,
  cosAgentQuerySchema,
  cosAgentCompletedQuerySchema,
} from '../lib/cos/cosValidation.js';

import { releasePublicationRequestSchema, releaseCandidateRequestSchema } from '../lib/releasePublication.js';
import { updateReleaseSynchronizationOwnership, updateReleaseCandidateOwnership, updateClaimOwnership, checkReconcileOwnership } from '../services/cos/cosClaimOwnership.js';
const router = Router();

router.post('/agents/:id/recheck-cleanup', asyncHandler(async (req, res) => {
  const { taskId } = validateRequest(cosAgentCleanupRecheckSchema, req.body ?? {});
  const { recheckAgentCleanup } = await import('../services/agent/agentRepoStateVerification.js');
  const result = await recheckAgentCleanup(req.params.id, taskId);
  if (!result.ok) throw new ServerError(result.reason === 'cleanup-already-running'
    ? 'Cleanup is already running' : 'The cleanup owner changed; refresh this task before retrying',
  { status: 409, code: 'CLEANUP_RECHECK_REFUSED', context: { reason: result.reason } });
  res.json(result);
}));

router.post('/agents/:id/security-scan', asyncHandler(async (req, res) => {
  const input = validateRequest(securityScanRequestSchema, req.body ?? {});
  const { runAgentSecurityScan } = await import('../services/agent/agentSecurityScan.js');
  res.json(await runAgentSecurityScan(req.params.id, input));
}));

router.post('/agents/:id/release-publication', asyncHandler(async (req, res) => {
  const input = validateRequest(releasePublicationRequestSchema, req.body ?? {});
  const { verifyAgentReleasePublication } = await import('../services/releasePublication.js');
  res.json(await verifyAgentReleasePublication(req.params.id, input));
}));

// The server chooses and reserves the branch before its checkout exists; the
// capture step discovers that checkout from Git, never from a supplied path.
router.post('/agents/:id/release-candidate', asyncHandler(async (req, res) => {
  const input = validateRequest(releaseCandidateRequestSchema, req.body ?? {});
  if (input.action === 'sync-reserve' || input.action === 'sync-capture') {
    return res.json(await updateReleaseSynchronizationOwnership(req.params.id, input.action));
  }
  res.json(await updateReleaseCandidateOwnership(req.params.id, input.action, { version: input.version }));
}));

// A registered run hands its published, reviewed head to the server's
// pending-merge coordinator instead of waiting for CI itself (#12247). The
// repository, branch, checkout and policy come from the run's registration.
router.post('/merge-handoff', asyncHandler(async (req, res) => {
  const input = validateRequest(cosAgentMergeHandoffSchema, req.body ?? {});
  const { handoffPendingMerge } = await import('../services/cos/cosMergeHandoff.js');
  res.json(await handoffPendingMerge(input));
}));

// A claim run binds (or hands off) the concrete branch it checks out; a
// branch-reconcile worker rechecks live ownership right before mutating (#10089).
router.post('/claim-ownership', asyncHandler(async (req, res) => {
  const input = validateRequest(claimOwnershipSchema, req.body ?? {});
  res.json(input.action === 'check' ? await checkReconcileOwnership(input) : await updateClaimOwnership(input));
}));

router.post('/claim-selection', asyncHandler(async (req, res) => {
  const input = validateRequest(cosAgentClaimSelectionSchema, req.body ?? {});
  const { recordClaimSelection } = await import('../services/cos/cosClaimSelection.js');
  res.json(await recordClaimSelection(input));
}));

// GET /api/cos/health - Get health status
router.get('/health', asyncHandler(async (req, res) => {
  const health = await getHealthStatus();
  res.json(health);
}));

// POST /api/cos/health/check - Force health check
router.post('/health/check', asyncHandler(async (req, res) => {
  const result = await runHealthCheck();
  res.json(result);
}));

// How often an agent list read may start the dead-agent sweep. The page reads
// the list on every load and socket-driven refresh; the sweep probes the
// runner, reads the host-shutdown marker and reconciles reservations, which is
// worth doing a few times a minute, not once per read.
const DEAD_AGENT_SWEEP_INTERVAL_MS = 15_000;
let lastDeadAgentSweepAt = Number.NEGATIVE_INFINITY;

/**
 * Start the dead-agent sweep without waiting for it. It probes the standalone
 * runner (up to its transport timeout while that process restarts) and awaits
 * forge and git work for each record it retires, and the listing is useful
 * before any of that lands: `completeAgent` pushes `cos:agent:completed` for
 * each retired record, so the page updates without another read.
 *
 * Reached through the boot hook registry, so the route keeps no static edge
 * into the agent orchestration graph. The sweep is single-flight, so a read
 * that arrives while one is running joins it.
 */
function sweepDeadAgentsInBackground() {
  const now = Date.now();
  if (now - lastDeadAgentSweepAt < DEAD_AGENT_SWEEP_INTERVAL_MS) return;
  lastDeadAgentSweepAt = now;
  // The promise chain owns an unregistered slot too: that is a wiring defect
  // to log, not a reason to fail the listing.
  void Promise.resolve()
    .then(() => requireCosOrphanRecoveryHandlers().cleanupOrphanedAgents())
    .catch((err) => {
      console.error(`🧹 Background dead-agent sweep failed: ${err.message}`);
    });
}

// GET /api/cos/agents - Get state-resident agents (running + recently completed)
// Output arrays and over-long task descriptions are stripped from every listing
// here — both are loaded on demand via GET /agents/:id. See cosAgentListProjection.js.
router.get('/agents', asyncHandler(async (req, res) => {
  sweepDeadAgentsInBackground();
  const { active } = validateRequest(cosAgentListQuerySchema, req.query);
  const [agents, taskView] = await Promise.all([
    getAgents(),
    active ? getTaskView({ kind: 'queue' }) : null,
  ]);
  const { getProjectedAgentList } = await import('../services/releaseSynchronizationProjection.js');
  if (!active) return res.json(toAgentListItems(await getProjectedAgentList(agents)));

  const resident = new Map(agents.map(agent => [agent.id, agent]));
  const visible = new Map(agents.filter(agent => agent.status !== 'completed').map(agent => [agent.id, agent]));
  const runningTasks = new Set(agents.filter(agent => agent.status === 'running').map(agent => agent.taskId));
  const tasks = [...(taskView.user?.tasks || []), ...(taskView.cos?.tasks || [])];
  // Execution can finish before delivery does. Follow only the task's exact
  // cleanup owner, including archived records, without loading transcripts or
  // changing the run's terminal status (and therefore scheduler capacity).
  const owners = tasks.filter(task => task.status === 'in_progress' && !runningTasks.has(task.id)).flatMap(task => {
    const ids = [isDeliveryCleanupHeld(task.metadata) && task.metadata.deliveryRecoveryAgentId, retryHoldOwnerId(task.metadata)].filter(Boolean);
    return [...new Set(ids)].map(id => ({ task, id }));
  });
  await Promise.all(owners.map(async ({ task, id }) => {
    if (visible.has(id)) return;
    const agent = resident.get(id) || await getAgentRecord(id);
    if (agent?.status === 'completed' && agent.taskId === task.id) {
      const deliveryActivity = getDeliveryActivity(id);
      visible.set(id, { ...agent, deliveryPending: true, ...(deliveryActivity && { deliveryActivity }) });
    }
  }));
  res.json(toAgentListItems(await getProjectedAgentList([...visible.values()])));
}));

router.get('/agents/completed', asyncHandler(async (req, res) => {
  const query = validateRequest(cosAgentCompletedQuerySchema, req.query);
  const page = await getCompletedAgentPage({ ...query, liveAgents: await getAgents() });
  const { getProjectedAgentList } = await import('../services/releaseSynchronizationProjection.js');
  res.json({ ...page, items: toAgentListItems(await getProjectedAgentList(page.items)) });
}));

// GET /api/cos/agents/feedback/pending - Reconciled durable feedback actions.
// The queue owns the action mutation; this endpoint feeds the Agents tab with
// the same live/archive predicate and count without loading every date bucket.
//
// The scalar badge and the paged list answer from the completion-order
// eligibility projection and hydrate only the rows they return; the unpaged
// form is the one that also reconciles the durable references and reports the
// archives it could not read.
router.get('/agents/feedback/pending', asyncHandler(async (req, res) => {
  const { limit, cursor, countOnly } = validateRequest(cosAgentPendingFeedbackQuerySchema, req.query);
  if (countOnly) return res.json({ count: await getPendingAgentFeedbackCount() });
  if (limit) {
    const page = await getPendingAgentFeedbackPage({ limit, cursor });
    return res.json({ ...page, items: toAgentListItems(page.items) });
  }
  const pending = await getPendingAgentFeedback({ includeUnavailable: true });
  res.json({
    count: pending.count,
    agents: toAgentListItems(pending.agents),
    unavailable: pending.unavailable,
  });
}));

// GET /api/cos/agents/:id - Get agent by ID (transcript hydrated as a capped tail)
router.get('/agents/:id', asyncHandler(async (req, res) => {
  const { lines } = validateRequest(cosAgentQuerySchema, req.query);
  const agent = await getAgent(req.params.id, lines ? { limit: lines } : {});
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }
  const { getProjectedAgent } = await import('../services/releaseSynchronizationProjection.js');
  res.json(await getProjectedAgent(agent));
}));

// GET /api/cos/agents/:id/prompt - Read the prompt.txt saved at spawn time
// The service throws a ServerError (404) when the agent or prompt file is
// missing — asyncHandler renders the standard envelope.
router.get('/agents/:id/prompt', asyncHandler(async (req, res) => {
  const result = await getAgentPrompt(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/pause - Stop process, preserve task/worktree for later resume
// pauseAgent throws a ServerError — 404 when the agent is missing, 500 when the
// runner/persist step fails — so no result-shape string-matching here.
router.post('/agents/:id/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(cosAgentPauseBodySchema, req.body ?? {});
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
  const result = await clearCompletedAgents();
  res.json(result);
}));

// DELETE /api/cos/agents/:id - Delete a single agent
// The service throws a ServerError (404) when the agent doesn't exist.
router.delete('/agents/:id', asyncHandler(async (req, res) => {
  const result = await deleteAgent(req.params.id);
  res.json(result);
}));

// POST /api/cos/agents/:id/feedback - Submit feedback for completed agent
router.post('/agents/:id/feedback', asyncHandler(async (req, res) => {
  const { rating, comment } = validateRequest(cosAgentFeedbackBodySchema, req.body);

  // The service throws a ServerError — 404 when the agent is missing, 400
  // (INVALID_STATE) when it isn't completed — so no result-shape mapping here.
  const result = await submitAgentFeedback(req.params.id, { rating, comment });
  res.json(result);
}));

// POST /api/cos/agents/:id/btw - Send additional context to a running agent
router.post('/agents/:id/btw', asyncHandler(async (req, res) => {
  const { message } = validateRequest(cosAgentBtwBodySchema, req.body);

  // The service throws a ServerError — 404 when the agent is missing, 400
  // (INVALID_STATE) for the not-running / not-a-Claude-TUI refusals — so no
  // result-shape string-matching here.
  const result = await sendBtwToAgent(req.params.id, message);
  res.json(result);
}));

// GET /api/cos/feedback/stats - Get feedback statistics
router.get('/feedback/stats', asyncHandler(async (req, res) => {
  const stats = await getFeedbackStats();
  res.json(stats);
}));

export default router;
