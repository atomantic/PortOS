/**
 * Feature Agents Service
 *
 * Manages persistent AI developer personas that own and iterate on
 * specific features of managed apps. Each agent works in a dedicated
 * git worktree/branch and runs on a schedule.
 */

import { writeFile, readFile, rename, readdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { cosEvents } from './cosEvents.js';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { getAppById } from './apps.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = PATHS.cos;
const FA_FILE = join(DATA_DIR, 'feature-agents.json');
const FA_DIR = join(DATA_DIR, 'feature-agents');
const withLock = createMutex();

// Event name prefix
const EVT = 'feature-agent';

// Backoff constants
const MIN_BACKOFF_MS = 60 * 60 * 1000;       // 1 hour
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * Read the feature agents data file
 */
async function readData() {
  const data = await readJSONFile(FA_FILE, { version: 1, lastUpdated: new Date().toISOString(), agents: [] });
  return data;
}

/**
 * Write the feature agents data file (atomic temp+rename)
 */
async function writeData(data) {
  await ensureDir(DATA_DIR);
  data.lastUpdated = new Date().toISOString();
  const tmpFile = FA_FILE + '.tmp';
  await writeFile(tmpFile, JSON.stringify(data, null, 2));
  await rename(tmpFile, FA_FILE);
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
      backoff: null,
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
      if (value && typeof value === 'object' && !Array.isArray(value) && existing[key] && typeof existing[key] === 'object') {
        merged[key] = { ...existing[key], ...value };
      } else {
        merged[key] = value;
      }
    }

    merged.updatedAt = new Date().toISOString();
    data.agents[idx] = merged;
    await writeData(data);
    console.log(`🤖 Feature agent updated: ${merged.name} (${id})`);
    return merged;
  });
}

/**
 * Delete a feature agent and clean up resources
 */
export async function deleteFeatureAgent(id) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return false;

    const agent = data.agents[idx];
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
      await rm(agentDir, { recursive: true, force: true }).catch(err => {
        console.log(`⚠️ Feature agent data cleanup failed: ${err.message}`);
      });
    }

    console.log(`🤖 Feature agent deleted: ${agent.name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'deleted', name: agent.name });
    return true;
  });
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
    data.agents[idx].backoff = null; // Reset backoff on resume
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
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    data.agents[idx].status = 'draft';
    data.agents[idx].currentAgentId = null;
    data.agents[idx].backoff = null;
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);

    console.log(`🤖 Feature agent stopped: ${data.agents[idx].name} (${id})`);
    cosEvents.emit(`${EVT}:status`, { id, status: 'draft', name: data.agents[idx].name });
    return data.agents[idx];
  });
}

/**
 * Force-trigger an immediate run for a feature agent
 */
export async function triggerFeatureAgent(id) {
  const agent = await getFeatureAgent(id);
  if (!agent) return null;

  // Activate if in draft/paused, then reset lastRunAt/backoff so it's picked up immediately
  if (agent.status === 'draft' || agent.status === 'paused') {
    await activateFeatureAgent(id);
    return withLock(async () => {
      const data = await readData();
      const idx = data.agents.findIndex(a => a.id === id);
      if (idx === -1) return null;
      data.agents[idx].backoff = null;
      data.agents[idx].lastRunAt = null;
      data.agents[idx].updatedAt = new Date().toISOString();
      await writeData(data);
      return data.agents[idx];
    });
  }

  // For active agents, reset backoff and lastRunAt so getDueFeatureAgents picks it up immediately
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;
    data.agents[idx].backoff = null;
    data.agents[idx].lastRunAt = null;
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);
    console.log(`🤖 Feature agent force-triggered: ${data.agents[idx].name} (${id})`);
    return data.agents[idx];
  });
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

    // Check backoff
    if (agent.backoff?.currentDelayMs) {
      const nextAllowed = new Date(agent.backoff.lastIdleAt).getTime() + agent.backoff.currentDelayMs;
      if (now < nextAllowed) continue;
    }

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
      model: agent.model || undefined
    }
  };
}

/**
 * Record run completion and update agent state
 */
export async function recordRunCompletion(id, runData) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return null;

    const agent = data.agents[idx];
    agent.lastRunAt = new Date().toISOString();
    agent.runCount = (agent.runCount || 0) + 1;
    agent.currentAgentId = null;
    agent.updatedAt = new Date().toISOString();

    // Handle idle detection for backoff
    if (runData.status === 'idle-no-work') {
      const consecutiveIdles = (agent.backoff?.consecutiveIdles || 0) + 1;
      const currentDelayMs = Math.min(
        MIN_BACKOFF_MS * Math.pow(2, consecutiveIdles - 1),
        MAX_BACKOFF_MS
      );
      agent.backoff = {
        currentDelayMs,
        consecutiveIdles,
        lastIdleAt: new Date().toISOString()
      };
      console.log(`😴 Feature agent ${agent.name} idle (backoff: ${Math.round(currentDelayMs / 60000)}min)`);
    } else {
      // Reset backoff on productive work
      agent.backoff = null;
    }

    data.agents[idx] = agent;
    await writeData(data);

    // Save run history
    const runDir = join(FA_DIR, id, 'runs');
    await ensureDir(runDir);
    const runId = `run-${Date.now()}`;
    await writeFile(
      join(runDir, `${runId}.json`),
      JSON.stringify({ id: runId, ...runData, completedAt: new Date().toISOString() }, null, 2)
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

  const runs = [];
  for (const file of runFiles) {
    const run = await readJSONFile(join(runDir, file), null);
    if (run) runs.push(run);
  }

  return runs;
}

/**
 * Get live output for a currently running feature agent
 */
export async function getFeatureAgentOutput(id) {
  const agent = await getFeatureAgent(id);
  if (!agent?.currentAgentId) return null;

  const outputFile = join(PATHS.cosAgents, agent.currentAgentId, 'output.txt');
  if (!existsSync(outputFile)) return null;

  const content = await readFile(outputFile, 'utf-8').catch(() => '');
  return { agentId: agent.currentAgentId, output: content };
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
  const skillPath = join(dirname(__dirname), '../data/prompts/skills/feature-agent.md');
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
6. If nothing actionable remains, report idle status

## Structured Summary (REQUIRED at end)
Always end your work with this format:
\`\`\`
Status: [working|idle-no-work|error]
Files changed: [list of files]
Summary: [what was done]
Learnings: [anything discovered for next run]
\`\`\`
`;
}

/**
 * Mark a feature agent as having a pending task (prevents duplicate spawns).
 * The pendingTaskId is used temporarily until the real CoS agent spawns,
 * at which point currentAgentId is set via the agent:spawned listener below.
 */
export async function setCurrentAgent(id, taskId) {
  return withLock(async () => {
    const data = await readData();
    const idx = data.agents.findIndex(a => a.id === id);
    if (idx === -1) return;
    data.agents[idx].currentAgentId = taskId;
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeData(data);
  });
}

// Listen for agent:spawned events to update currentAgentId from the
// temporary task ID to the real CoS agent ID (needed for output streaming).
cosEvents.on('agent:spawned', async (agentData) => {
  if (!agentData?.taskId) return;
  // Check if this task belongs to a feature agent
  const taskId = agentData.taskId;
  const data = await readData().catch(() => null);
  if (!data) return;
  const fa = data.agents.find(a => a.currentAgentId === taskId);
  if (!fa) return;
  await setCurrentAgent(fa.id, agentData.id).catch(err => {
    console.log(`⚠️ Failed to update feature agent currentAgentId: ${err.message}`);
  });
});
