import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
/**
 * Feature Agents Service
 *
 * Manages persistent AI developer personas that own and iterate on
 * specific features of managed apps. Each agent works in a dedicated
 * git worktree/branch and runs on a schedule.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { cosEvents } from './cos/cosEvents.js';
import { ensureDir, PATHS, readJSONFile, atomicWrite, rmGuarded } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPlainObject } from '../lib/objects.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { ServerError } from '../lib/errorHandler.js';
import { isQueuedContinuation } from '../lib/agent/agentOutcome.js';
import { getAppById } from './apps.js';
const DATA_DIR = PATHS.cos;
const FA_FILE = join(DATA_DIR, 'feature-agents.json');
const FA_DIR = join(DATA_DIR, 'feature-agents');
const withLock = createMutex();

// Event name prefix
const EVT = 'feature-agent';

/**
 * Read the feature agents data file
 */
async function readData() {
  const data = await readJSONFile(FA_FILE, { version: 1, lastUpdated: new Date().toISOString(), agents: [] }, { strict: true });
  return data;
}

/**
 * Write the feature agents data file (atomic temp+rename)
 */
async function writeData(data) {
  await ensureDir(DATA_DIR);
  data.lastUpdated = new Date().toISOString();
  await atomicWrite(FA_FILE, data);
}

/**
 * Get all feature agents
 */
export async function getAllFeatureAgents() {
  const data = await readData();
  return data.agents;
}

/**
 * Get a single feature agent by ID
 */
export async function getFeatureAgent(id) {
  const data = await readData();
  return data.agents.find(a => a.id === id) || null;
}

/**
 * Create a new feature agent
 */
export async function createFeatureAgent(input) {
  return withLock(async () => {
    const data = await readData();
    const id = `fa-${uuidv4().slice(0, 8)}`;
    const now = new Date().toISOString();

    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
    const branchName = `feature-agent/${slug}-${id.replace('fa-', '')}`;
    const agent = {
      id,
      ...input,
      git: { branchName, baseBranch: 'main', autoMergeBase: true, autoPR: true },
      status: 'draft',
      lastRunAt: null,
      runCount: 0,
      currentAgentId: null,
      createdAt: now,
      updatedAt: now
    };

    data.agents.push(agent);
    await writeData(data);
    console.log(`🤖 Feature agent created: ${agent.name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'draft', name: agent.name });
    return agent;
  });
}

/**
 * Update a feature agent's config
 */
export async function updateFeatureAgent(id, updates) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    // Deep merge for nested objects
    const existing = data.agents[idx];
    const merged = { ...existing };

    for (const [key, value] of Object.entries(updates)) {
      if (isPlainObject(value) && existing[key] && typeof existing[key] === 'object') {
        merged[key] = { ...existing[key], ...value };
      } else {
        merged[key] = value;
      }
    }

    merged.updatedAt = new Date().toISOString();
    data.agents[idx] = merged;
    await writeData(data);
    console.log(`🤖 Feature agent updated: ${merged.name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: merged.status, name: merged.name });
    return merged;
  });
}

/**
 * Delete a feature agent and clean up resources
 */
export async function deleteFeatureAgent(id) {
  return withBackupAssetPublication(() => withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return false;

    const agent = data.agents[idx];
    await terminateActiveFeatureAgentRun(agent);
    data.agents.splice(idx, 1);
    await writeData(data);

    // Clean up worktree and data directory
    const agentDir = join(FA_DIR, id);
    const worktreeDir = join(agentDir, 'worktree');
    if (existsSync(worktreeDir)) {
      const app = await getAppById(agent.appId).catch(() => null);
      if (app?.repoPath) {
        const { removePersistentWorktree } = await import('./worktreeManager.js');
        await removePersistentWorktree(id, app.repoPath, agent.git.branchName).catch(err => {
          console.log(`⚠️ Feature agent worktree cleanup failed: ${err.message}`);
        });
      }
    }
    // Remove the entire data directory (runs, etc.)
    if (existsSync(agentDir)) {
      await rmGuarded(agentDir, { recursive: true, force: true }).catch(err => {
        console.log(`⚠️ Feature agent data cleanup failed: ${err.message}`);
      });
    }

    console.log(`🤖 Feature agent deleted: ${agent.name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'deleted', name: agent.name });
    return true;
  }));
}

/**
 * Activate a feature agent (creates worktree on first activation)
 */
export async function activateFeatureAgent(id) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    const agent = data.agents[idx];
    if (agent.status === 'active') return agent;

    // Create persistent worktree on first activation
    const worktreeDir = join(FA_DIR, id, 'worktree');
    if (!existsSync(worktreeDir)) {
      const app = await getAppById(agent.appId).catch(() => null);
      if (!app?.repoPath) {
        throw new Error(`App ${agent.appId} not found or missing repoPath`);
      }

      const { createPersistentWorktree } = await import('./worktreeManager.js');
      await createPersistentWorktree(id, app.repoPath, agent.git.branchName, agent.git.baseBranch);
      console.log(`🌳 Feature agent worktree created: ${agent.git.branchName}`);
    }

    agent.status = 'active';
    agent.updatedAt = new Date().toISOString();
    data.agents[idx] = agent;
    await writeData(data);

    console.log(`🤖 Feature agent activated: ${agent.name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'active', name: agent.name });
    return agent;
  });
}

/**
 * Pause a feature agent
 */
export async function pauseFeatureAgent(id) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    data.agents[idx].status = 'paused';
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);

    console.log(`🤖 Feature agent paused: ${data.agents[idx].name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'paused', name: data.agents[idx].name });
    return data.agents[idx];
  });
}

/**
 * Resume a paused feature agent
 */
export async function resumeFeatureAgent(id) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    if (data.agents[idx].status !== 'paused') return data.agents[idx];

    data.agents[idx].status = 'active';
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);

    console.log(`🤖 Feature agent resumed: ${data.agents[idx].name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'active', name: data.agents[idx].name });
    return data.agents[idx];
  });
}

/**
 * Stop a feature agent fully
 */
export async function stopFeatureAgent(id) {
  return withBackupAssetPublication(() => withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    await terminateActiveFeatureAgentRun(data.agents[idx]);
    data.agents[idx].status = 'draft';
    data.agents[idx].currentAgentId = null;
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);

    console.log(`🤖 Feature agent stopped: ${data.agents[idx].name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'draft', name: data.agents[idx].name });
    return data.agents[idx];
  }));
}

/**
 * Force-trigger an immediate run for a feature agent
 */
export async function triggerFeatureAgent(id) {
  let agent = await getFeatureAgent(id);
  if (!agent) return null;

  // Activation enables scheduling, while Trigger is an explicit Run now. Draft
  // and paused agents therefore become active first, then all states use the
  // same immediate-dispatch path below.
  if (agent.status === 'draft' || agent.status === 'paused') {
    agent = await activateFeatureAgent(id);
    if (!agent) return null;
  }

  const queued = await queueFeatureAgentTask(generateTaskFromFeatureAgent(agent), { force: true });
  if (!queued) return null;
  if (queued.reason) return { triggered: false, ...queued };

  const { task, agent: queuedAgent } = queued;
  console.log(`🤖 Feature agent force-triggered: ${queuedAgent.name} (${id})`);
  return { triggered: true, started: true, agent: queuedAgent, taskId: task.id };
}

// Persist both the queued task and its pointer before dispatch can start.
// Stop and Delete take the same lock, including while CoS is starting a process.
export async function queueFeatureAgentTask(task, { force = false } = {}) {
  return withLock(async () => {
    const data = await readData();
    const agent = data.agents.find(candidate => candidate.id === task.metadata.featureAgentId);
    if (!agent || (agent.status !== 'active' && !(force && agent.status === 'error'))) return null;
    if (agent.currentAgentId) {
      return { reason: 'Feature agent already has a run in progress', agent, taskId: agent.currentAgentId };
    }

    const { addTask } = await import('./cos/cosTaskStore.js');
    const persisted = await addTask(task, 'internal', { raw: true, suppressDequeue: true });
    if (!persisted?.id) return { reason: 'Feature agent run was not queued', agent };
    if (persisted.duplicate && persisted.metadata?.featureAgentId !== agent.id) {
      return { reason: 'An equivalent task already belongs to another workflow', agent };
    }
    if (persisted.duplicate && persisted.status !== 'pending') {
      return { reason: `Feature agent run is already ${persisted.status}`, agent, taskId: persisted.id };
    }

    agent.currentAgentId = persisted.id;
    if (force) agent.lastRunAt = null;
    agent.updatedAt = new Date().toISOString();
    await writeData(data);

    if (force) {
      const { forceSpawnTask } = await import('./cos/cos.js');
      const result = await forceSpawnTask(persisted.id);
      if (result?.error) {
        await deleteFeatureAgentTask(persisted.id);
        agent.currentAgentId = null;
        await writeData(data);
        return { reason: result.error, agent, taskId: persisted.id };
      }
    }
    return { task: { ...persisted, taskType: 'internal' }, agent };
  });
}

// Bind the replacement under the same lock as Stop, Delete and dispatch. The
// previous run's completion listener only hands off a pointer it still owns.
export async function queueFeatureAgentReplacement(task, pausedRun) {
  const { featureAgentId, featureAgentRun } = pausedRun.metadata;
  return withBackupAssetPublication(() => withLock(async () => {
    const data = await readData();
    const agent = data.agents.find(candidate => candidate.id === featureAgentId);
    const originalTaskId = pausedRun.taskId || pausedRun.metadata.taskId;
    if (!featureAgentId || !isTruthyMeta(featureAgentRun) || !agent || agent.status === 'draft'
      || !agent.currentAgentId || (agent.currentAgentId !== pausedRun.id && agent.currentAgentId !== originalTaskId)) {
      throw new ServerError('Resume blocked: the Feature Agent no longer owns this paused run. Open Feature Agents to manage the current run or start a new one.', {
        status: 409, code: 'AGENT_RESUME_FEATURE_RUN_UNAVAILABLE'
      });
    }

    const { addTask } = await import('./cos/cosTaskStore.js');
    const replacement = await addTask({
      ...task,
      metadata: { ...task.metadata, featureAgentId, featureAgentRun: true }
    }, 'internal', { suppressDequeue: true });
    // A previous write can queue the task before the feature pointer is saved.
    // Only that exact continuation is safe to adopt when the request retries.
    if (replacement?.duplicate && (replacement.status !== 'pending'
      || replacement.metadata?.resumedFromAgentId !== pausedRun.id
      || replacement.metadata?.featureAgentId !== featureAgentId
      || !isTruthyMeta(replacement.metadata?.featureAgentRun))) {
      throw new ServerError('Resume blocked: an equivalent task already exists. Resolve that task in the CoS queue, then retry.', {
        status: 409, code: 'AGENT_RESUME_FEATURE_TASK_CONFLICT'
      });
    }
    if (!replacement?.id) return { error: replacement?.error || 'Feature Agent replacement was not queued' };
    agent.currentAgentId = replacement.id;
    agent.updatedAt = new Date().toISOString();
    await writeData(data);
    return replacement;
  }));
}

/**
 * Get feature agents that are due for their next run based on schedule
 */
export async function getDueFeatureAgents() {
  const data = await readData();
  const now = Date.now();
  const due = [];

  for (const agent of data.agents) {
    if (agent.status !== 'active') continue;
    if (agent.autonomyLevel === 'standby') continue; // Standby agents only run when manually triggered
    if (agent.currentAgentId) continue; // Already running

    const lastRun = agent.lastRunAt ? new Date(agent.lastRunAt).getTime() : 0;
    const mode = agent.schedule?.mode || 'continuous';

    if (mode === 'continuous') {
      const pause = agent.schedule?.pauseBetweenRunsMs || 60000;
      if (now - lastRun >= pause) {
        due.push(agent);
      }
    } else if (mode === 'interval') {
      const interval = agent.schedule?.intervalMs || 3600000;
      if (now - lastRun >= interval) {
        due.push(agent);
      }
    }
  }

  return due;
}

/**
 * Generate a CoS task from a feature agent
 */
export function generateTaskFromFeatureAgent(agent) {
  return {
    id: `fa-run-${agent.id}-${Date.now()}`,
    description: `[Feature Agent] ${agent.name}: ${agent.description}`,
    priority: agent.priority || 'MEDIUM',
    status: 'pending',
    taskType: 'internal',
    approvalRequired: false,
    metadata: {
      featureAgentId: agent.id,
      featureAgentRun: true,
      app: agent.appId,
      provider: agent.providerId || undefined,
      model: agent.model || undefined,
      effort: agent.effort || undefined
    }
  };
}

/**
 * Record run completion and update agent state
 */
async function recordRunCompletion(id, runData, { id: agentId, taskId }) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    const agent = data.agents[idx];
    if (!agent.currentAgentId || (agent.currentAgentId !== agentId && agent.currentAgentId !== taskId)) return null;
    agent.lastRunAt = new Date().toISOString();
    agent.runCount = (agent.runCount || 0) + 1;
    agent.currentAgentId = null;
    agent.updatedAt = new Date().toISOString();

    data.agents[idx] = agent;
    await writeData(data);

    // Save run history
    const runDir = join(FA_DIR, id, 'runs');
    await ensureDir(runDir);
    const runId = `run-${Date.now()}`;
    await atomicWrite(
      join(runDir, `${runId}.json`),
      { id: runId, ...runData, completedAt: new Date().toISOString() }
    );

    cosEvents.emit(`${EVT}:run-complete`, { id, runId, name: agent.name, status: runData.status });
    return agent;
  });
}

/**
 * Get run history for a feature agent
 */
export async function getFeatureAgentRuns(id, limit = 20) {
  const runDir = join(FA_DIR, id, 'runs');
  if (!existsSync(runDir)) return [];

  const files = await readdir(runDir);
  const runFiles = files
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a)) // newest first
    .slice(0, limit);

  // Read the (already limit-capped) run files in parallel — these are
  // independent small JSON reads, so a sequential loop needlessly serializes
  // disk latency on the run-history endpoint.
  const loaded = await Promise.all(
    // Read-only run history: unreadable entries are filtered, never rewritten.
    runFiles.map(file => readJSONFile(join(runDir, file), null))
  );

  return loaded.filter(Boolean);
}

/**
 * Get live output for a currently running feature agent
 */
export async function getFeatureAgentOutput(id) {
  const agent = await getFeatureAgent(id);
  if (!agent?.currentAgentId) return null;

  const agentId = agent.currentAgentId;
  const { getAgentDir, loadAgentIndex } = await import('./cos/cosAgentIndex.js');
  const { readAgentTranscriptTail } = await import('./cos/cosAgentLifecycle.js');
  const options = { limit: 500 };
  let tail = await readAgentTranscriptTail(join(getAgentDir(agentId), 'output.txt'), options);
  if (!tail) {
    const date = (await loadAgentIndex()).get(agentId);
    if (date) tail = await readAgentTranscriptTail(join(getAgentDir(agentId, date), 'output.txt'), options);
  }
  return tail ? { agentId, output: tail.lines.join('\n') } : null;
}

/**
 * Build the full prompt for a feature agent run
 */
export async function buildFeatureAgentPrompt(agent) {
  const app = await getAppById(agent.appId).catch(() => null);
  const recentRuns = await getFeatureAgentRuns(agent.id, 3);

  const runSummaries = recentRuns.length > 0
    ? recentRuns.map(r => `- ${r.completedAt}: ${r.status} - ${r.summary || 'No summary'}`).join('\n')
    : 'No previous runs.';

  const worktreeDir = join(FA_DIR, agent.id, 'worktree');

  // Load skill template if exists
  const skillPath = join(PATHS.promptSkills, 'feature-agent.md');
  const skillTemplate = existsSync(skillPath)
    ? await readFile(skillPath, 'utf-8').catch(() => '')
    : '';

  return `# Feature Agent Briefing

${agent.persona ? `## Persona\n${agent.persona}\n` : ''}

## Identity
- **Name**: ${agent.name}
- **Feature**: ${agent.description}
- **App**: ${app?.name || agent.appId} (${app?.repoPath || 'unknown path'})

## Goals
${agent.goals?.length ? agent.goals.map(g => `- ${g}`).join('\n') : '- No specific goals defined'}

## Constraints
${agent.constraints?.length ? agent.constraints.map(c => `- ${c}`).join('\n') : '- No specific constraints'}

## Git Context
- **Branch**: \`${agent.git.branchName}\`
- **Base branch**: \`${agent.git.baseBranch}\`
- **Worktree**: \`${worktreeDir}\`
- **Auto PR**: ${agent.git.autoPR ? 'yes' : 'no'}

**Important**: You are working in a persistent worktree on branch \`${agent.git.branchName}\`. Commit your changes to this branch. When you have completed meaningful work, create or update a PR using \`gh pr create\` or \`gh pr edit\`.

## Previous Runs
${runSummaries}

## Testing
Use the Playwright MCP to visually verify your changes in the browser. Navigate to the app, interact with the UI, and validate that your changes work correctly.

${skillTemplate ? `## Skill Guidelines\n${skillTemplate}\n` : ''}

## Instructions
1. Review the current state of your feature branch
2. Identify what needs to be done based on your goals
3. Make targeted changes within your feature scope
4. Test changes when possible (run tests, check Playwright URLs)
5. Commit with clear messages prefixed with the feature name
6. If nothing actionable remains, say so briefly and stop
`;
}

async function deleteFeatureAgentTask(taskId) {
  const { deleteTask } = await import('./cos/cosTaskStore.js');
  const result = await deleteTask(taskId, 'internal');
  if (result.error && result.error !== 'Task not found') throw new Error(result.error);
}

async function terminateActiveFeatureAgentRun(agent) {
  const pointer = agent.currentAgentId;
  if (!pointer) return;

  const { getAgents, getAgentRecord, isLiveAgentRecord } = await import('./cos/cosAgentLifecycle.js');
  const record = await getAgentRecord(pointer);
  const continuation = isQueuedContinuation(record) ? record.result.resumedTaskId : null;
  const taskId = continuation ?? record?.taskId ?? pointer;
  // The task can already own a process while its agent:spawned listener waits
  // to take this lock. Match only this feature's run before using that agent id.
  const owner = isLiveAgentRecord(record) ? record : (await getAgents()).find(run =>
    isLiveAgentRecord(run) && run.taskId === taskId && run.metadata?.featureAgentId === agent.id);
  if (owner) {
    const { killAgent } = await import('./agent/agentManagement.js');
    try {
      await killAgent(owner.id);
    } catch (error) {
      if (error.status !== 404 || error.code !== 'NOT_FOUND') throw error;
      const retired = await getAgentRecord(owner.id);
      if (isQueuedContinuation(retired)) {
        await deleteFeatureAgentTask(retired.result.resumedTaskId);
        return;
      }
      if (retired?.status === 'completed') return;
    }
    // killAgent blocks the task for manual retry. A feature run being stopped
    // here must release that task's dedup slot so the feature can run again.
    if (owner.taskId) await deleteFeatureAgentTask(owner.taskId);
    return;
  }
  if (!record || continuation) await deleteFeatureAgentTask(taskId);
}

export async function withFeatureAgentDispatch(task, spawn) {
  return withBackupAssetPublication(() => withLock(async () => {
    const agent = await getFeatureAgent(task.metadata.featureAgentId);
    if (!agent?.currentAgentId) return null;
    if (agent.currentAgentId !== task.id) {
      // The continuation can reach dequeue before the completion listener has
      // moved the pointer from the retired agent back to the queued task.
      const { getAgentRecord } = await import('./cos/cosAgentLifecycle.js');
      const previous = await getAgentRecord(agent.currentAgentId);
      if (!isQueuedContinuation(previous) || previous.result.resumedTaskId !== task.id) return null;
    }
    return spawn();
  }));
}

// Move a feature agent's pointer from the run that just handed off to the task its
// continuation will spawn from — but ONLY while it still names that retired run.
// See the `agent:completed` handler for the race this guards.
async function handOffCurrentAgent(id, retiredAgentId, continuationTaskId) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1 || data.agents[idx].currentAgentId !== retiredAgentId) return;
    data.agents[idx].currentAgentId = continuationTaskId;
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);
  });
}

// Listen for agent:spawned events to update currentAgentId from the
// temporary task ID to the real CoS agent ID (needed for output streaming).
cosEvents.on('agent:spawned', async (agentData) => {
  if (!agentData?.taskId || !agentData.metadata?.featureAgentRun) return;
  await withLock(async () => {
    const data = await readData();
    const fa = data.agents.find(a => a.id === agentData.metadata.featureAgentId && a.currentAgentId === agentData.taskId);
    if (!fa) return;
    fa.currentAgentId = agentData.id;
    fa.updatedAt = new Date().toISOString();
    await writeData(data);
    cosEvents.emit(`${EVT}:status`, { id: fa.id, status: fa.status, name: fa.name });
  }).catch(err => {
    console.log(`⚠️ Failed to update feature agent currentAgentId: ${err.message}`);
  });
});

// Feature-agent tasks are ordinary CoS agents at runtime. Keep the persistent
// feature-agent record in sync with that shared lifecycle so a completed run
// does not permanently block the next scheduled or manual run.
cosEvents.on('agent:completed', async (agentData) => {
  const featureAgentId = agentData?.metadata?.featureAgentId;
  if (!agentData?.metadata?.featureAgentRun || !featureAgentId) return;
  // A relaunch retires this record and requeues the SAME task on a new provider,
  // so the run is still in flight. Recording it would flip the feature agent to
  // `error`, bump its run count, and write a run-history entry reading
  // "Relaunched by user" — for work that has not finished. Instead, follow the
  // task: `currentAgentId` holds the RETIRED agent's id, and the `agent:spawned`
  // listener above re-binds only a feature agent still pointing at the TASK, so
  // without this hand-back the pointer stays on a dead agent and the
  // continuation's output never reaches the feature-agent view.
  //
  // Gated on `isQueuedContinuation`, which is what proves a continuation was
  // actually QUEUED. The bare `isAgentHandoff` (`resumed: true`) alone does not:
  // `retireStrandedPausedAgents` stamps it on a pause whose task is gone or has
  // moved on, with no `resumedTaskId` and nothing requeued. Handing back there
  // — to `agentData.taskId`, a task that no longer exists — parks a pointer no
  // `agent:spawned` can ever clear, and both `triggerFeatureAgent` and
  // `getDueFeatureAgents` refuse to run a feature agent that holds one. The
  // agent would never run again, by schedule or by hand, recoverable only by
  // Stop and re-activate. Those retirements fall through to
  // `recordRunCompletion` below, which clears the pointer as it always did.
  const continuationTaskId = isQueuedContinuation(agentData) ? agentData.result?.resumedTaskId : null;
  if (continuationTaskId) {
    // Compare-and-set against the retired agent's id, because this races the
    // spawn of the very continuation it points at: `requeuePausedTask` runs
    // BEFORE `completeAgent`, and the `tasks:changed` it emits schedules the
    // dequeue on a `setImmediate` while `completeAgent` is still writing state and
    // archiving. If that spawn won and `agent:spawned` already bound the live
    // agent, overwriting it with the task id would blank the output view for the
    // whole run; losing the race merely leaves the pointer on the task until the
    // continuation completes and clears it.
    await handOffCurrentAgent(featureAgentId, agentData.id, continuationTaskId).catch(err => {
      console.log(`⚠️ Failed to hand feature agent ${featureAgentId} back to its relaunched task: ${err.message}`);
    });
    return;
  }
  const success = agentData.result?.success === true;
  await recordRunCompletion(featureAgentId, {
    status: success ? 'working' : 'error',
    summary: success ? 'Feature agent run completed' : agentData.result?.error || 'Feature agent run failed'
  }, agentData).catch(err => {
    console.log(`⚠️ Failed to record feature agent completion: ${err.message}`);
  });
});

async function releasePendingTask(taskId, { retainQueued = true } = {}) {
  if (!taskId) return;
  return withLock(async () => {
    const data = await readData();
    const agent = data.agents.find(candidate => candidate.currentAgentId === taskId);
    if (!agent) return;
    if (retainQueued) {
      const { getTaskById } = await import('./cos/cosTaskStore.js');
      const task = await getTaskById(taskId);
      if (task?.status === 'pending') return;
    }
    agent.currentAgentId = null;
    agent.updatedAt = new Date().toISOString();
    await writeData(data);
  }).catch(err => {
    console.log(`⚠️ Failed to clear feature agent pending task: ${err.message}`);
  });
}

// A held or failed dispatch may be retried while its task is still pending.
// Release legacy unpersisted pointers and terminal setup failures so their
// feature agent can be scheduled again.
cosEvents.on('agent:error', (agentData) => releasePendingTask(agentData?.taskId));
cosEvents.on('task:held', (held) => releasePendingTask(held?.taskId));
cosEvents.on('tasks:changed', (change) => {
  if (change?.action === 'deleted' && change.type === 'internal') {
    return releasePendingTask(change.taskId, { retainQueued: false });
  }
});
