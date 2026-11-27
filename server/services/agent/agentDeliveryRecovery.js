/** Resolves recovery task updates and binds their writes to the originating dispatch. */

import { completionDispatchFence } from './agentCompletionTaskHandoff.js';
import { resolveUndeliveredTaskUpdate } from './agentErrorAnalysis.js';

// Runtime evidence is server-owned and never inferred from completion prose.
export async function resolveDeliveryRecoveryUpdate(task, outcome, agentId) {
  if (outcome?.recovery?.mode === 'dependency-wait') {
    const { resolveInvestigationDependencyUpdate } = await import('../investigationDependencyWait.js');
    return resolveInvestigationDependencyUpdate(task, outcome, agentId);
  }
  if (outcome?.recovery?.mode === 'runtime') {
    const { resolveRuntimeVerificationUpdate } = await import('../runtimeVerification.js');
    return resolveRuntimeVerificationUpdate(task, outcome, agentId);
  }
  return resolveUndeliveredTaskUpdate(task, outcome, agentId);
}

export function runtimeRecoveryFence(update) {
  if (update.dependencyWaitContext) return [update.dependencyWaitContext];
  if (update.metadata?.blockedCategory !== 'runtime-verification') return update.runtimeRecoveryContext ? [update.runtimeRecoveryContext] : [];
  const p = update.metadata.runtimeVerification;
  return [{ ...update.runtimeRecoveryContext, expectedStatus: p.dispatchStatus, expectedMetadata: {
    ...(p.dispatchStatus === 'blocked' ? { runtimeVerificationId: update.metadata.runtimeVerificationId } : {}),
    ...Object.fromEntries(['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, p.dispatch?.[key]])),
  } }];
}

// The run's own task write. A recovery fence already names its expected task
// and owner, so it wins over the dispatch fence field by field.
export function completionTaskFence(update, agent) {
  const [recovery] = runtimeRecoveryFence(update);
  const dispatch = completionDispatchFence(agent);
  if (!dispatch) return recovery ? [recovery] : [];
  return [{ ...dispatch, ...recovery, expectedMetadata: { ...dispatch.expectedMetadata, ...recovery?.expectedMetadata } }];
}
