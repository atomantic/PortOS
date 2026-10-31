/**
 * CoS Agent Management Routes
 */

import { Router } from 'express';
import { z } from 'zod';
import { cleanupZombieAgents, deleteAgent, getAgent, getAgentPrompt, getAgentRecord, getAgents, sendBtwToAgent } from '../services/cosAgentLifecycle.js';
import { getTaskView } from '../services/cosTaskStore.js';
import { clearCompletedAgents } from '../services/cosAgentArchive.js';
import { getAgentDates, getAgentsByDate, getCompletedAgentPage } from '../services/cosAgentIndex.js';
import { getFeedbackStats, getPendingAgentFeedback, getPendingAgentFeedbackCount, getPendingAgentFeedbackPage, submitAgentFeedback } from '../services/cosAgentFeedback.js';
import { getHealthStatus, runHealthCheck } from '../services/cosHealthMonitor.js';
// Lifecycle transitions go through the facade (#3450).
import * as agentOrchestrator from '../services/agentOrchestrator.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { toAgentListItems } from '../lib/cosAgentListProjection.js';
import { isDeliveryCleanupHeld, retryHoldOwnerId } from '../lib/taskRetryHold.js';
import { getDeliveryActivity } from '../services/agentDeliveryActivity.js';
import { securityScanRequestSchema } from '../lib/securityScanEvidence.js';
import { validateRequest, resumeCosAgentSchema, relaunchCosAgentSchema, cosAgentFeedbackBodySchema, cosAgentBtwBodySchema } from '../lib/validation.js';

const router = Router();

router.post('/agents/:id/recheck-cleanup', asyncHandler(async (req, res) => {
  const { taskId } = validateRequest(z.object({ taskId: z.string().min(1).max(512) }).strict(), req.body ?? {});
  const { recheckAgentCleanup } = await import('../services/agentRepoStateVerification.js');
  const result = await recheckAgentCleanup(req.params.id, taskId);
  if (!result.ok) throw new ServerError(result.reason === 'cleanup-already-running'
    ? 'Cleanup is already running' : 'The cleanup owner changed; refresh this task before retrying',
  { status: 409, code: 'CLEANUP_RECHECK_REFUSED', context: { reason: result.reason } });
  res.json(result);
}));

router.post('/agents/:id/security-scan', asyncHandler(async (req, res) => {
  const input = validateRequest(securityScanRequestSchema, req.body ?? {});
  const { runAgentSecurityScan } = await import('../services/agentSecurityScan.js');
  res.json(await runAgentSecurityScan(req.params.id, input));
}));

router.post('/agents/:id/release-publication', asyncHandler(async (req, res) => {
  const { releasePublicationRequestSchema } = await import('../lib/releasePublication.js');
  const input = validateRequest(releasePublicationRequestSchema, req.body ?? {});
  const { verifyAgentReleasePublication } = await import('../services/releasePublication.js');
  res.json(await verifyAgentReleasePublication(req.params.id, input));
}));

// The server chooses and reserves the branch before its checkout exists; the
// capture step discovers that checkout from Git, never from a supplied path.
router.post('/agents/:id/release-candidate', asyncHandler(async (req, res) => {
  const { releaseCandidateRequestSchema } = await import('../lib/releasePublication.js');
  const input = validateRequest(releaseCandidateRequestSchema, req.body ?? {});
  if (input.action === 'recover') {
    const { recoverReleaseCandidate } = await import('../services/releaseCandidateRecovery.js');
    return res.json(await recoverReleaseCandidate(req.params.id, input.predecessorAgentId));
  }
  const { updateReleaseCandidateOwnership } = await import('../services/cosClaimOwnership.js');
  res.json(await updateReleaseCandidateOwnership(req.params.id, input.action));
}));

// Outside operators have no CoS agent record. A per-run secret separates
// sessions sharing the agent-key credential; only its principal-bound hash is
// persisted. Neither an agentId nor a PR's prose can select another owner.
const externalMergeAdmissionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.enum(['prepare', 'acquire']), appId: z.string().min(1).max(200),
    worktreePath: z.string().min(1).max(4096), prUrl: z.string().url().max(2048),
    baseBranch: z.string().min(1).max(255),
    headSha: z.string().regex(/^[a-f0-9]{40}$/), baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict(),
  z.object({ action: z.literal('yield'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('check'), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal('release'), token: z.string().uuid(),
    outcome: z.enum(['merged', 'leave-open', 'resync']) }).strict(),
]);
router.post('/merge-admission/external', asyncHandler(async (req, res) => {
  const input = validateRequest(externalMergeAdmissionSchema, req.body ?? {});
  const { externalAdmissionOwner } = await import('../services/externalAdmissionAuth.js');
  const { externalMergeAdmission } = await import('../services/cosMergeAdmission.js');
  res.json(await externalMergeAdmission(input, () => externalAdmissionOwner(req)));
}));

// A registered run hands its published, reviewed head to the server's
// pending-merge coordinator instead of waiting for CI itself (#12247). The
// repository, branch, checkout and policy come from the run's registration.
const mergeHandoffSchema = z.object({
  agentId: z.string().min(1).max(200),
  prUrl: z.string().url().max(2048),
  headSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
  worktreePath: z.string().min(1).max(4096).optional(),
});
router.post('/merge-handoff', asyncHandler(async (req, res) => {
  const input = validateRequest(mergeHandoffSchema, req.body ?? {});
  const { handoffPendingMerge } = await import('../services/cosMergeHandoff.js');
  res.json(await handoffPendingMerge(input));
}));

// A claim run binds (or hands off) the concrete branch it checks out; a
// branch-reconcile worker rechecks live ownership right before mutating (#10089).
const claimBranchSchema = z.string().min(1).max(200);
const claimOwnershipSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bind'), agentId: z.string().min(1).max(200), branch: claimBranchSchema }),
  z.object({ action: z.literal('release'), agentId: z.string().min(1).max(200), branch: claimBranchSchema }),
  z.object({
    action: z.literal('check'),
    appId: z.string().min(1).max(200),
    branch: claimBranchSchema,
    worktreePath: z.string().min(1).max(4096).optional(),
    agentId: z.string().min(1).max(200).optional(),
  }),
]);
router.post('/claim-ownership', asyncHandler(async (req, res) => {
  const input = validateRequest(claimOwnershipSchema, req.body ?? {});
  const { updateClaimOwnership, checkReconcileOwnership } = await import('../services/cosClaimOwnership.js');
  res.json(input.action === 'check' ? await checkReconcileOwnership(input) : await updateClaimOwnership(input));
}));

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
  const health = await getHealthStatus();
  res.json(health);
}));

// POST /api/cos/health/check - Force health check
router.post('/health/check', asyncHandler(async (req, res) => {
  const result = await runHealthCheck();
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
  void cleanupZombieAgents().catch((err) => {
    console.error(`🧹 Background zombie cleanup failed: ${err.message}`);
  });
  const { active } = validateRequest(z.object({ active: z.literal('1').optional() }), req.query);
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

// Bounded completed history, including state records not yet archived.
const completedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).regex(/^\d{4}-\d{2}-\d{2}\|[^|]*\|[^|]+$/).optional(),
});
router.get('/agents/completed', asyncHandler(async (req, res) => {
  const query = validateRequest(completedQuerySchema, req.query);
  const page = await getCompletedAgentPage({ ...query, liveAgents: await getAgents() });
  const { getProjectedAgentList } = await import('../services/releaseSynchronizationProjection.js');
  res.json({ ...page, items: toAgentListItems(await getProjectedAgentList(page.items)) });
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
  const dates = await getAgentDates();
  if (!hydrate) return res.json({ dates });
  // `latest: null` is the answer for an install with no archived runs at all —
  // distinct from a bucket that read back empty, which the client must not
  // mistake for "not hydrated" and re-request.
  const latestDate = dates[0]?.date;
  const { getProjectedAgentList } = await import('../services/releaseSynchronizationProjection.js');
  const latest = latestDate
    ? { date: latestDate, agents: toAgentListItems(await getProjectedAgentList(await getAgentsByDate(latestDate))) }
    : null;
  res.json({ dates, latest });
}));

// GET /api/cos/agents/history/:date - Get completed agents for a date
router.get('/agents/history/:date', asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ServerError('Invalid date format (expected YYYY-MM-DD)', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const agents = await getAgentsByDate(date);
  const { getProjectedAgentList } = await import('../services/releaseSynchronizationProjection.js');
  res.json(toAgentListItems(await getProjectedAgentList(agents)));
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
  const { limit, cursor, countOnly } = validateRequest(z.object({
    countOnly: z.literal('1').optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(512).optional(),
  }), req.query);
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
  const { lines } = validateRequest(agentQuerySchema, req.query);
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
