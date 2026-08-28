/** User-triggered and capability-gated cleanup for Persistent Mind-owned state. */

import { randomUUID } from 'crypto';
import {
  persistentMindCleanupRequestSchema,
} from '../lib/persistentMindCapabilities.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import {
  appendMindEvent,
  clearPersistentMindHistory,
} from './agentRunEventLog.js';
import {
  archivePersistentMindMemories,
  clearPersistentMindRollups,
} from './persistentMindContext.js';
import { resetPersistentMindRuntimeResidue } from './persistentMindSupervisor.js';

export async function cleanupPersistentMind({
  mindId = PERSISTENT_MIND_ID,
  scopes,
  reason,
  requestedBy = 'user',
  preserveTurnId = null,
  preserveMessageId = null,
} = {}) {
  const request = persistentMindCleanupRequestSchema.parse({ scopes, ...(reason ? { reason } : {}) });
  const selected = new Set(request.scopes);
  const clearHistory = selected.has('history');
  const clearContext = clearHistory || selected.has('context');
  const results = {
    memoriesArchived: 0,
    historyEventsCleared: 0,
    historyEventsPreserved: 0,
    rollupsCleared: 0,
    runtimeResidueCleared: clearHistory || selected.has('context'),
  };

  if (selected.has('memories')) {
    const memoryResult = await archivePersistentMindMemories(mindId);
    results.memoriesArchived = memoryResult.archived;
  }
  if (clearContext) {
    const rollupResult = await clearPersistentMindRollups(mindId);
    results.rollupsCleared = rollupResult.cleared;
  }
  if (clearHistory) {
    const historyResult = await clearPersistentMindHistory({
      mindId,
      preserveTurnId,
      preserveMessageId,
    });
    results.historyEventsCleared = historyResult.cleared;
    results.historyEventsPreserved = historyResult.preserved;
  }
  if (results.runtimeResidueCleared) await resetPersistentMindRuntimeResidue();

  const eventId = `mind-maintenance:${randomUUID()}`;
  const auditResult = await appendMindEvent({
    kind: 'mind.maintenance.completed',
    mindId,
    turnId: preserveTurnId,
    eventId,
    data: {
      displayText: 'Mindspace cleanup completed',
      requestedBy: requestedBy === 'mind' ? 'mind' : 'user',
      reason: request.reason || null,
      scopes: request.scopes,
      ...results,
    },
  });
  return {
    ok: true,
    success: true,
    state: 'completed',
    scopes: request.scopes,
    reason: request.reason || null,
    auditRecorded: auditResult.appended === true || auditResult.duplicate === true,
    ...results,
    eventId: auditResult.appended === true || auditResult.duplicate === true ? eventId : null,
  };
}
