import { createSingleFlight } from '../lib/singleFlight.js';
import { loadState, isDaemonRunning, isImprovementEnabled, canQueueImprovementTasks } from './cosState.js';
import { emitLog } from './cosEvents.js';

// Delivery and physical retirement are separate obligations. This path opens
// the next drain slot only after exact merged-head evidence for every captured
// branch; it never completes or removes the original cleanup task.
const cleanupSwarmRefills = createSingleFlight();
export function refillDeliveredCleanupSwarm(agentId, { wake, refillPlan }) {
  return cleanupSwarmRefills.run(agentId, async () => {
    if (!isDaemonRunning()) return;
    const state = await loadState();
    if (state.paused || !isImprovementEnabled(state)) return;
    const [{ getAgentRecord, markSwarmCleanupContinuationIssued }, { getInstanceId }, contract, scheduleMod, store, generator] = await Promise.all([
      import('./cosAgentLifecycle.js'), import('./instanceIdentity.js'), import('./swarmCleanupDelivery.js'), import('./taskSchedule.js'),
      import('./cosTaskStore.js'), import('./cosTaskGenerator.js'),
    ]);
    const agent = await getAgentRecord(agentId);
    const task = agent && await store.getTaskById(agent.taskId);
    const instance = await getInstanceId();
    const taskType = task?.metadata?.analysisType;
    if (!contract.cleanupRefillSourceMatches(task, agent, instance)
      || !await contract.validCleanupRefillSource(agentId, taskType, agent.metadata.taskApp)
      || agent.metadata.swarmCleanupDelivery.continuationIssued) return;
    const proof = agent.metadata.swarmCleanupDelivery;
    const plan = refillPlan(agent, await scheduleMod.loadSchedule());
    const appId = agent.metadata.taskApp;
    let issued = false;
    let shouldWake = false;
    if (plan.lane === 'skip' || await scheduleMod.isPerpetualParkActive(taskType, appId)) {
      issued = true;
    } else if (plan.lane === 'onDemand') {
      const request = await scheduleMod.queuePerpetualRefill(taskType, appId, { cleanupSourceAgentId: agentId });
      if (request?.error) return;
      issued = true;
      shouldWake = true;
    } else if (canQueueImprovementTasks(state)) {
      const outcome = await generator.queueEligibleImprovementTasks(state, await store.getCosTasks(), {
        wakeAfterRecord: false,
        perpetualContinuation: { taskType, appId }, continuationSourceAgentId: agentId,
      });
      issued = outcome?.continuationSatisfied === true || await scheduleMod.isPerpetualParkActive(taskType, appId);
      shouldWake = outcome?.continuationSatisfied === true;
    }
    if (!issued || !await markSwarmCleanupContinuationIssued(agentId, proof)) return;
    await scheduleMod.acknowledgeSwarmCleanupRefill(agentId).catch(err => {
      emitLog('warn', `Swarm refill receipt cleanup deferred: ${err.message}`, { agentId });
    });
    if (shouldWake) await wake();
  });
}
