/**
 * Agent Completion Helpers
 *
 * Post-completion tasks shared between runner mode (handleAgentCompletion)
 * and direct mode (spawnDirectly): memory extraction and app cooldown.
 */

import { updateAgent } from './cosAgentLifecycle.js';
// `getConfig` comes from cosState.js, NOT cos.js, and that asymmetry with the
// other cos.js getConfig importers is load-bearing — do not "fix" it for
// consistency. This module sits on a cycle (cos.js → agentState.js →
// agentOrchestrator.js → agentManagement.js → agentFinalization.js → here), and
// pointing this import back at cos.js while cos.js re-exports getConfig from
// cosState.js leaves cos.js's own re-exported bindings uninitialized at import
// time — `firstLine is not a function` in cos.test.js, verified.
//
// agentCompletion.test.js's getConfig stub therefore has to name cosState.js
// too — pointed at cos.js it intercepts nothing, and the suite silently
// exercises the real loadState() against the running install's config.
import { getConfig } from './cosState.js';
import { startAppCooldown, markAppReviewCompleted } from './appActivity.js';
import { emitLog } from './cosEvents.js';
import { extractAndStoreMemories } from './memoryExtractor.js';
import { isRecoveryTask } from './recoveryTasks.js';
import { finalizeMalwareScan } from './malwareScanReports.js';

/**
 * Process post-completion tasks: memory extraction and app cooldown.
 * Shared between handleAgentCompletion (runner mode) and spawnDirectly (direct mode).
 */
export async function processAgentCompletion(agentId, task, success, outputBuffer) {
  await finalizeMalwareScan({ agentId, task, success }).catch(err => {
    emitLog('warn', `Failed to finalize malware scan for ${task.id}: ${err.message}`, { taskId: task.id, agentId });
  });

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

    // Perpetual (drain-until-done) tasks intentionally re-queue back-to-back
    // until their work-detector idles and the task PARKS itself
    // (taskSchedule.parkPerpetual). Bumping the per-app review cooldown here
    // would throttle that drain to one item per cooldown window (default 30
    // min), defeating the "keep going until done" contract — the drain's own
    // park IS the throttle. Skip the cooldown bump for them (stats above still
    // recorded). Same spirit as the recovery-task skip above.
    if (task.metadata?.perpetual) {
      emitLog('info', `Skipping cooldown bump for perpetual task on app ${appId}`, { appId, taskId: task.id });
      return;
    }

    await startAppCooldown(appId, cooldownMs).catch(err => {
      emitLog('warn', `Failed to start app cooldown: ${err.message}`, { appId });
    });

    emitLog('info', `App ${appId} cooldown started (${Math.round(cooldownMs / 60000)} min)`, { appId, cooldownMs });
  }
}
