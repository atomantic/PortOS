/**
 * Runner agent recovery.
 *
 * Rehydrates the in-memory `runnerAgents` map from the CoS Runner after a
 * server restart, so completion events for agents spawned before the restart
 * still land. Extracted from `agentLifecycle.js` (issue #2837): both
 * `agentManagement.js` and `subAgentSpawner.js` need it, and importing it from
 * the lifecycle orchestrator dragged that whole module graph into a cycle.
 *
 * Leaf with respect to the agent cluster — must not import `agentLifecycle.js`
 * or `agentManagement.js` (enforced by `agentImportCycles.test.js`).
 */

import { connectTuiSessionViaRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import { runnerEntryShieldsRunningRecord } from '../lib/runnerAgentLiveness.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { isAgentOwnedLocally, runnerAgents } from './agentState.js';
import { AGENT_RECORD_UNREADABLE, isLiveAgentRecord, readAgentRecordOrUnreadable } from './cosAgentLifecycle.js';
import { appendRunEvent } from './agentRunEventLog.js';
import * as shellService from './shell.js';

/**
 * Sync running agents from the runner (recovery after server restart).
 * This allows us to receive completion events for agents spawned before restart.
 *
 * Recovery adopts only agents this process does NOT already own — see
 * `isAgentOwnedLocally` for why that question needs both maps, and why asking
 * `runnerAgents` alone silently hoisted live TUI runs. `cleanupOrphanedAgents`
 * calls this every 15 minutes, so the bug reached any TUI run that outlived a
 * single health-check tick: once hoisted, the `agent:completed` the runner emits
 * when the TUI spawner's own `finish()` kills the session passed subAgentSpawner's
 * `if (!agent) return` guard and ran a SECOND `finalizeAgent`, overwriting a
 * sentinel-signalled success with `success: false, exitCode: 143` and a bogus
 * `startup-failure` analysis — which flipped the agent card to Failed and requeued
 * the finished task. Observed on a 55-min release-check run that had already
 * published its release and merged all of its PRs.
 */
export async function syncRunnerAgents() {
  const agents = await getActiveAgentsFromRunner().catch(err => {
    console.error(`❌ Failed to get active agents from runner: ${err.message}`);
    return [];
  });
  if (agents.length === 0) return 0;

  console.log(`🔄 Syncing ${agents.length} running agents from CoS Runner`);

  // Get all tasks to find task data for each agent
  const { getAllTasks } = await import('./cos.js');
  const allTasksData = await getAllTasks().catch(() => ({ user: {}, cos: {} }));

  // Build a task lookup map from all task sources, tagging each with its taskType
  const taskMap = new Map();
  const addTasks = (groupedTasks, taskType) => {
    if (!groupedTasks) return;
    for (const tasks of Object.values(groupedTasks)) {
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          taskMap.set(task.id, { ...task, taskType });
        }
      }
    }
  };

  addTasks(allTasksData.user?.grouped, 'user');
  addTasks(allTasksData.cos?.grouped, 'internal');

  let syncedCount = 0;
  for (const agent of agents) {
    // A stale runner handle (listed, process gone) is not a survivor to
    // re-adopt — adopting it would put it in runnerAgents and the orphan
    // sweep would treat that local map as ownership. Live rows still sync.
    if (!(await runnerEntryShieldsRunningRecord(agent))) continue;
    // Only sync if this process isn't already driving it
    if (!isAgentOwnedLocally(agent.id)) {
      const task = taskMap.get(agent.taskId);

      const inferredType = isInternalTaskId(agent.taskId) ? 'internal' : 'user';
      // Recover the run id from the PERSISTED agent record (#3244). The runner's
      // /agents response describes the live process and carries no `metadata`,
      // but `spawnViaRunner` wrote `runId` into the agent record before handing
      // off, so it is still on disk — `agentManagement.js` reads it the same way
      // on its orphan path. Dropping it here left the survivor's run permanently
      // open (`completeAgentRun` returns early on a null id), so the Runs list
      // showed it running forever and `recordCompletedRunUsage` never fired —
      // silently exempting the longest-lived runs in the system from all cost
      // accounting. Survivors are the normal case since #3202 made TUI agents
      // durable, so this cannot stay a best-effort null.
      // Adopt only what PortOS still believes is running. The runner keeps
      // advertising a PTY it never managed to kill, and adopting one of those
      // mints a phantom `runnerAgents` entry that nothing ever removes: it holds
      // an open run, reads as locally owned forever, and counts against the
      // "CoS agents running" gate that pauses the Update page — while the agent
      // list, built from the durable records, shows nothing at all.
      //
      // A read that FAILED is not a record that is absent: the failure proves
      // nothing, and the live process behind it still needs its completion event
      // to land, so it gets its own sentinel and is adopted anyway.
      const read = await readAgentRecordOrUnreadable(agent.id);
      if (read !== AGENT_RECORD_UNREADABLE && !isLiveAgentRecord(read)) {
        console.warn(`⚠️ Ignoring stale runner agent ${agent.id} — PortOS has no live record for it`);
        continue;
      }
      const persisted = read === AGENT_RECORD_UNREADABLE ? null : read;
      const recoveredRunId = persisted?.metadata?.runId || null;
      runnerAgents.set(agent.id, {
        taskId: agent.taskId,
        task: task || { id: agent.taskId, taskType: inferredType, description: 'Recovered from runner' },
        runId: recoveredRunId,
        model: persisted?.metadata?.model || null,
        hasStartedWorking: true,
        startedAt: agent.startedAt
      });
      if (!recoveredRunId) {
        console.warn(`⚠️ Recovered agent ${agent.id} has no run id on record — its run stays open and unbilled`);
      }
      // Record the re-adoption in the lifecycle ledger (#4540). No explicit
      // idempotency key here, unlike the orphan sweep: `runnerAgents.set` above
      // has already made this agent locally owned, so the `isAgentOwnedLocally`
      // guard stops this branch re-firing within the process. A SECOND
      // re-adoption therefore means a second server lifetime — a genuinely
      // distinct recovery, which `recoveryCount` is supposed to count — and that
      // count is what turns "this run has been running for nine
      // hours" into "this run has survived three restarts". `hasRunId:false`
      // is the durable trace of the unbilled-run warning above — today that
      // warning only exists in a console line nothing retains.
      await appendRunEvent({
        kind: 'run.runner-recovered',
        runId: recoveredRunId,
        agentId: agent.id,
        taskId: agent.taskId,
        data: {
          kind: agent.kind ?? null,
          hasRunId: Boolean(recoveredRunId),
          startedAt: agent.startedAt ?? null,
        },
      });
      if (agent.kind === 'tui' && agent.sessionId && !shellService.getSession(agent.sessionId)) {
        const session = connectTuiSessionViaRunner(agent);
        shellService.registerExternalSession(agent.sessionId, session.ptyProcess, {
          cwd: agent.workspacePath,
          kind: 'agent-tui',
          agentId: agent.id,
          label: `Recovered TUI ${agent.id}`,
          command: agent.command,
        });
        // A live PTY was re-attached to a still-running agent (#4540). Distinct
        // from the `run.runner-recovered` above: that says the RUN was
        // re-adopted, this says its terminal stream was re-plumbed — and only
        // one of the two can fail. No explicit idempotency key: the
        // `!getSession` guard already means "not currently attached", so every
        // event here is a genuinely distinct reconnect and `reconnectCount`
        // reads as the number of times this run lost and regained its stream.
        await appendRunEvent({
          kind: 'run.reconnected',
          runId: recoveredRunId,
          agentId: agent.id,
          taskId: agent.taskId,
          data: { transport: 'runner-pty', sessionId: agent.sessionId ?? null },
        });
        session.ptyProcess.onExit(({ exitCode }) => {
          shellService.unregisterExternalSession(agent.sessionId, { exitCode });
        });
      }
      console.log(`🔄 Recovered agent ${agent.id} (task: ${agent.taskId})`);
      syncedCount++;
    }
  }

  return syncedCount;
}
