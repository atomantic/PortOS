/**
 * Sub-Agent Spawner Service
 *
 * Spawns Claude CLI instances to work on tasks with unrestricted mode
 * and MCP server integration. Includes intelligent model selection
 * and usage tracking.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { cosEvents, registerAgent, updateAgent, completeAgent, appendAgentOutput, getConfig, updateTask } from './cos.js';

/**
 * Emit a log event for UI display (mirrors cos.js helper)
 */
function emitLog(level, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  };
  console.log(`${level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️'} ${message}`);
  cosEvents.emit('log', logEntry);
}
import { getActiveProvider, getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { getMemorySection } from './memoryRetriever.js';
import { extractAndStoreMemories } from './memoryExtractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '../../');
const AGENTS_DIR = join(__dirname, '../../data/cos/agents');
const RUNS_DIR = join(__dirname, '../../data/runs');

/**
 * Select optimal model for a task based on complexity analysis
 * User can override by specifying Model: and/or Provider: in task metadata
 */
function selectModelForTask(task, provider) {
  const desc = (task.description || '').toLowerCase();
  const context = task.metadata?.context || '';
  const contextLen = context.length;
  const priority = task.priority || 'MEDIUM';

  // Check for user-specified model preference
  const userModel = task.metadata?.model;
  const userProvider = task.metadata?.provider;

  if (userModel) {
    console.log(`👤 User specified model: ${userModel}`);
    return {
      model: userModel,
      tier: 'user-specified',
      reason: 'user-preference',
      userProvider: userProvider || null
    };
  }

  // Image/visual analysis → would route to gemini if available
  if (/image|screenshot|visual|photo|picture/.test(desc)) {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'visual-analysis' };
  }

  // Critical priority → always use opus/heavy
  if (priority === 'CRITICAL') {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'critical-priority' };
  }

  // Complex reasoning tasks → opus/heavy
  if (/architect|refactor|design|complex|optimize|security|audit|review.*code|performance/.test(desc)) {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'complex-task' };
  }

  // Long context → needs more capable model
  if (contextLen > 500) {
    return { model: provider.heavyModel || provider.mediumModel || provider.defaultModel, tier: 'heavy', reason: 'long-context' };
  }

  // Simple/quick tasks → haiku/light
  if (/fix typo|update text|simple|rename|comment|documentation|readme|format/.test(desc) || contextLen < 100) {
    return { model: provider.lightModel || provider.defaultModel, tier: 'light', reason: 'simple-task' };
  }

  // Standard tasks → sonnet/medium (default)
  return { model: provider.mediumModel || provider.defaultModel, tier: 'medium', reason: 'standard-task' };
}

/**
 * Create a run entry for usage tracking
 */
async function createAgentRun(agentId, task, model, provider, workspacePath) {
  const runId = uuidv4();
  const runDir = join(RUNS_DIR, runId);

  if (!existsSync(RUNS_DIR)) {
    await mkdir(RUNS_DIR, { recursive: true });
  }
  await mkdir(runDir);

  const metadata = {
    id: runId,
    type: 'ai',
    source: 'cos-agent',
    agentId,
    taskId: task.id,
    providerId: provider.id,
    providerName: provider.name,
    model: model || provider.defaultModel,
    workspacePath,
    workspaceName: task.metadata?.app || 'portos',
    prompt: (task.description || '').substring(0, 500),
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    exitCode: null,
    success: null,
    error: null,
    outputSize: 0
  };

  await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await writeFile(join(runDir, 'prompt.txt'), task.description || '');
  await writeFile(join(runDir, 'output.txt'), '');

  return { runId, runDir };
}

/**
 * Complete a run entry with final results
 */
async function completeAgentRun(runId, output, exitCode, duration, error = null) {
  const runDir = join(RUNS_DIR, runId);
  const metaPath = join(runDir, 'metadata.json');

  if (!existsSync(metaPath)) return;

  const metadata = JSON.parse(await readFile(metaPath, 'utf-8'));
  metadata.endTime = new Date().toISOString();
  metadata.duration = duration;
  metadata.exitCode = exitCode;
  metadata.success = exitCode === 0;
  metadata.error = error;
  metadata.outputSize = Buffer.byteLength(output || '');

  await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  await writeFile(join(runDir, 'output.txt'), output || '');
}

// Active agent processes
const activeAgents = new Map();

/**
 * Initialize the spawner - listen for task:ready events
 */
export function initSpawner() {
  cosEvents.on('task:ready', async (task) => {
    await spawnAgentForTask(task);
  });

  cosEvents.on('agent:terminate', async (agentId) => {
    await terminateAgent(agentId);
  });

  console.log('🤖 Sub-agent spawner initialized');
}

/**
 * Spawn an agent for a task
 */
export async function spawnAgentForTask(task) {
  const agentId = `agent-${uuidv4().slice(0, 8)}`;

  // Get configuration
  const config = await getConfig();
  const provider = await getActiveProvider();

  if (!provider) {
    cosEvents.emit('agent:error', { taskId: task.id, error: 'No active AI provider configured' });
    return null;
  }

  // Select optimal model for this task
  const modelSelection = selectModelForTask(task, provider);
  const selectedModel = modelSelection.model;

  emitLog('info', `Model selection: ${selectedModel} (${modelSelection.reason})`, {
    taskId: task.id,
    model: selectedModel,
    tier: modelSelection.tier,
    reason: modelSelection.reason
  });

  // Determine workspace path
  const workspacePath = task.metadata?.app
    ? await getAppWorkspace(task.metadata.app)
    : ROOT_DIR;

  // Build the agent prompt
  const prompt = await buildAgentPrompt(task, config);

  // Create agent directory
  const agentDir = join(AGENTS_DIR, agentId);
  if (!existsSync(agentDir)) {
    await mkdir(agentDir, { recursive: true });
  }

  // Save prompt to file
  await writeFile(join(agentDir, 'prompt.txt'), prompt);

  // Create run entry for usage tracking
  const { runId } = await createAgentRun(agentId, task, selectedModel, provider, workspacePath);

  // Build spawn arguments with model selection
  const spawnArgs = buildSpawnArgs(config, selectedModel);

  // Register the agent with model info
  await registerAgent(agentId, task.id, {
    workspacePath,
    taskDescription: task.description,
    taskType: task.taskType,
    priority: task.priority,
    model: selectedModel,
    modelTier: modelSelection.tier,
    modelReason: modelSelection.reason,
    runId,
    phase: 'initializing'
  });

  emitLog('info', `Agent ${agentId} initializing...`, { agentId, taskId: task.id });

  // Mark the task as in_progress to prevent re-spawning
  await updateTask(task.id, { status: 'in_progress' }, task.taskType || 'user');

  // Spawn the Claude CLI process using full path for PM2 compatibility
  const claudePath = process.env.CLAUDE_PATH || '/Users/antic/.nvm/versions/node/v25.2.1/bin/claude';

  // Build full command string for display
  const fullCommand = `${claudePath} ${spawnArgs.join(' ')} <<< "${(task.description || '').substring(0, 100)}..."`;

  emitLog('success', `Spawning agent for task ${task.id}`, { agentId, model: selectedModel });

  const claudeProcess = spawn(claudePath, spawnArgs, {
    cwd: workspacePath,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
    env: {
      ...process.env,
      // Pass through any provider-specific env vars
      ...provider.envVars
    }
  });

  // Register the spawned agent with its full command for process listing
  registerSpawnedAgent(claudeProcess.pid, {
    fullCommand,
    agentId,
    taskId: task.id,
    model: selectedModel,
    workspacePath,
    prompt: (task.description || '').substring(0, 500)
  });

  // Send prompt via stdin and close it
  claudeProcess.stdin.write(prompt);
  claudeProcess.stdin.end();

  // Store process reference
  activeAgents.set(agentId, {
    process: claudeProcess,
    taskId: task.id,
    startedAt: Date.now(),
    runId,
    pid: claudeProcess.pid
  });

  // Set up output handling
  let outputBuffer = '';
  let hasStartedWorking = false;
  const outputFile = join(agentDir, 'output.txt');

  claudeProcess.stdout.on('data', async (data) => {
    const text = data.toString();
    outputBuffer += text;

    // Update phase to 'working' on first output
    if (!hasStartedWorking) {
      hasStartedWorking = true;
      await updateAgent(agentId, { phase: 'working' });
      emitLog('info', `Agent ${agentId} working...`, { agentId, phase: 'working' });
    }

    // Append to file
    await writeFile(outputFile, outputBuffer).catch(() => {});

    // Emit output event
    await appendAgentOutput(agentId, text);
  });

  claudeProcess.stderr.on('data', async (data) => {
    const text = data.toString();
    outputBuffer += `[stderr] ${text}`;

    // Append to file
    await writeFile(outputFile, outputBuffer).catch(() => {});

    await appendAgentOutput(agentId, `[stderr] ${text}`);
  });

  claudeProcess.on('error', async (err) => {
    console.error(`❌ Agent ${agentId} spawn error: ${err.message}`);
    cosEvents.emit('agent:error', { agentId, error: err.message });
    await completeAgent(agentId, { success: false, error: err.message });
    // Complete the run tracking with error
    await completeAgentRun(runId, outputBuffer, 1, 0, err.message);
    unregisterSpawnedAgent(claudeProcess.pid);
    activeAgents.delete(agentId);
  });

  claudeProcess.on('close', async (code) => {
    const success = code === 0;
    const agentData = activeAgents.get(agentId);
    const duration = Date.now() - (agentData?.startedAt || Date.now());

    // Save final output
    await writeFile(outputFile, outputBuffer).catch(() => {});

    await completeAgent(agentId, {
      success,
      exitCode: code,
      duration,
      outputLength: outputBuffer.length
    });

    // Complete the run tracking
    await completeAgentRun(agentData?.runId || runId, outputBuffer, code, duration);

    // Update task status based on result
    const newStatus = success ? 'completed' : 'pending'; // Reset to pending on failure for retry
    await updateTask(task.id, { status: newStatus }, task.taskType || 'user');

    // Extract and store memories from successful agent output
    if (success && outputBuffer.length > 100) {
      extractAndStoreMemories(agentId, task.id, outputBuffer, task).catch(err => {
        console.log(`⚠️ Memory extraction failed: ${err.message}`);
      });
    }

    unregisterSpawnedAgent(agentData?.pid || claudeProcess.pid);
    activeAgents.delete(agentId);
  });

  return agentId;
}

/**
 * Build spawn arguments for Claude CLI
 */
function buildSpawnArgs(config, model) {
  // Note: MCP server config via --mcp-config requires a file path, not inline JSON
  // For now, we skip MCP config and rely on the user's default settings
  // Prompt will be passed via stdin to avoid shell escaping issues
  const args = [
    '--dangerously-skip-permissions', // Unrestricted mode
    '--print',                          // Print output and exit
  ];

  // Add model selection if specified
  if (model) {
    args.push('--model', model);
  }

  return args;
}

/**
 * Build the prompt for an agent
 */
async function buildAgentPrompt(task, config) {
  // Get relevant memories for context injection
  const memorySection = await getMemorySection(task, {
    maxTokens: config.memory?.maxContextTokens || 2000
  }).catch(err => {
    console.log(`⚠️ Memory retrieval failed: ${err.message}`);
    return null;
  });

  // Try to use the prompt template system
  const promptData = await buildPrompt('cos-agent-briefing', {
    task,
    config,
    memorySection,
    timestamp: new Date().toISOString()
  }).catch(() => null);

  if (promptData?.prompt) {
    return promptData.prompt;
  }

  // Fallback to built-in template
  return `# Chief of Staff Agent Briefing

${memorySection || ''}

## Task Assignment
You are an autonomous agent working on behalf of the Chief of Staff.

### Task Details
- **ID**: ${task.id}
- **Priority**: ${task.priority}
- **Description**: ${task.description}
${task.metadata?.context ? `- **Context**: ${task.metadata.context}` : ''}
${task.metadata?.app ? `- **Target App**: ${task.metadata.app}` : ''}

## Instructions
1. Analyze the task requirements carefully
2. Make necessary changes to complete the task
3. Test your changes when possible
4. Provide a summary of what was done

## Guidelines
- Focus only on the assigned task
- Make minimal, targeted changes
- Follow existing code patterns and conventions
- Do not make unrelated changes
- If blocked, explain clearly why

## Working Directory
You are working in the project directory. Use the available tools to explore, modify, and test code.

Begin working on the task now.`;
}

/**
 * Get workspace path for an app
 */
async function getAppWorkspace(appName) {
  const appsFile = join(ROOT_DIR, 'data/apps.json');

  if (!existsSync(appsFile)) {
    return ROOT_DIR;
  }

  const content = await readFile(appsFile, 'utf-8');
  const data = JSON.parse(content);

  // Handle both object format { apps: { id: {...} } } and array format [...]
  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    const app = apps.find(a => a.name === appName || a.id === appName);
    return app?.repoPath || ROOT_DIR;
  }

  // Object format - keys are app IDs
  const app = apps[appName] || Object.values(apps).find(a => a.name === appName);
  return app?.repoPath || ROOT_DIR;
}

/**
 * Terminate an agent
 */
export async function terminateAgent(agentId) {
  const agent = activeAgents.get(agentId);

  if (!agent) {
    return { success: false, error: 'Agent not found or not running' };
  }

  agent.process.kill('SIGTERM');

  // Give it a moment, then force kill if needed
  setTimeout(() => {
    if (activeAgents.has(agentId)) {
      agent.process.kill('SIGKILL');
      unregisterSpawnedAgent(agent.pid);
      activeAgents.delete(agentId);
    }
  }, 5000);

  return { success: true, agentId };
}

/**
 * Get list of active agents
 */
export function getActiveAgents() {
  const agents = [];
  for (const [agentId, agent] of activeAgents) {
    agents.push({
      id: agentId,
      taskId: agent.taskId,
      startedAt: agent.startedAt,
      runningTime: Date.now() - agent.startedAt
    });
  }
  return agents;
}

/**
 * Kill all active agents
 */
export async function killAllAgents() {
  const agentIds = Array.from(activeAgents.keys());

  for (const agentId of agentIds) {
    await terminateAgent(agentId);
  }

  return { killed: agentIds.length };
}

/**
 * Clean up orphaned agents on startup
 * Agents marked as "running" in state but not in activeAgents map are orphaned
 */
export async function cleanupOrphanedAgents() {
  const { getAgents, completeAgent: markComplete } = await import('./cos.js');
  const agents = await getAgents();
  let cleanedCount = 0;

  for (const agent of agents) {
    if (agent.status === 'running' && !activeAgents.has(agent.id)) {
      console.log(`🧹 Cleaning up orphaned agent ${agent.id}`);
      await markComplete(agent.id, {
        success: false,
        error: 'Agent process was orphaned (server restart)',
        orphaned: true
      });
      cleanedCount++;
    }
  }

  return cleanedCount;
}

// Initialize spawner when module loads
initSpawner();

// Clean up orphaned agents after a short delay (let other services init first)
setTimeout(cleanupOrphanedAgents, 2000);
