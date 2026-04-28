/**
 * Agent Completion Helpers
 *
 * Post-completion tasks shared between runner mode (handleAgentCompletion)
 * and direct mode (spawnDirectly): memory extraction and app cooldown.
 */

import { updateAgent } from './cosAgents.js';
import { getConfig } from './cos.js';
import { startAppCooldown, markAppReviewCompleted } from './appActivity.js';
import { emitLog } from './cosEvents.js';
import { extractAndStoreMemories } from './memoryExtractor.js';
import { isRecoveryTask } from './recoveryTasks.js';

/**
 * Process post-completion tasks: memory extraction and app cooldown.
 * Shared between handleAgentCompletion (runner mode) and spawnDirectly (direct mode).
 */
export async function processAgentCompletion(agentId, task, success, outputBuffer) {
  // Extract memories from successful output
  if (success && outputBuffer.length > 100) {
    const memoryResult = await extractAndStoreMemories(agentId, task.id, outputBuffer, task).catch(err => {
      console.log(`⚠️ Memory extraction failed: ${err.message}`);
      return { created: 0, pendingApproval: 0 };
    });
    if (memoryResult.created > 0 || memoryResult.pendingApproval > 0) {
      await updateAgent(agentId, {
        memoryExtraction: {
          created: memoryResult.created,
          pendingApproval: memoryResult.pendingApproval,
          extractedAt: new Date().toISOString()
        }
      });
    }
  }

  // Handle app cooldown
  const appId = task.metadata?.app;
  if (appId) {
    // Recovery tasks are administrative — they retry a failed merge/PR for an
    // already-reviewed agent run. Bumping the cooldown for them pushes sibling
    // improvement tasks for the same app another full window into the future,
    // which is exactly the queue-stalling we're trying to prevent.
    if (isRecoveryTask(task)) {
      emitLog('info', `Skipping cooldown bump for recovery task on app ${appId}`, { appId, taskId: task.id });
      return;
    }

    const config = await getConfig();
    const cooldownMs = config.appReviewCooldownMs || 3600000;

    const issuesFound = success ? 1 : 0;
    const issuesFixed = success ? 1 : 0;
    await markAppReviewCompleted(appId, issuesFound, issuesFixed).catch(err => {
      emitLog('warn', `Failed to mark app review completed: ${err.message}`, { appId });
    });

    await startAppCooldown(appId, cooldownMs).catch(err => {
      emitLog('warn', `Failed to start app cooldown: ${err.message}`, { appId });
    });

    emitLog('info', `App ${appId} cooldown started (${Math.round(cooldownMs / 60000)} min)`, { appId, cooldownMs });
  }
}
