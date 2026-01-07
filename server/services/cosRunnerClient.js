/**
 * CoS Runner Client
 *
 * Communicates with the standalone portos-cos PM2 process
 * that manages agent spawning to prevent orphaned processes.
 */

import { io } from 'socket.io-client';

const COS_RUNNER_URL = process.env.COS_RUNNER_URL || 'http://localhost:5558';

// Socket.IO client for real-time events
let socket = null;
let eventHandlers = new Map();

/**
 * Initialize connection to CoS Runner
 */
export function initCosRunnerConnection() {
  if (socket) return;

  socket = io(COS_RUNNER_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('🔌 Connected to CoS Runner');
    // Emit reconnect event so services can sync their state
    const handler = eventHandlers.get('connection:ready');
    if (handler) handler();
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected from CoS Runner');
    const handler = eventHandlers.get('connection:lost');
    if (handler) handler();
  });

  // Forward events to registered handlers
  socket.on('agent:output', (data) => {
    const handler = eventHandlers.get('agent:output');
    if (handler) handler(data);
  });

  socket.on('agent:completed', (data) => {
    const handler = eventHandlers.get('agent:completed');
    if (handler) handler(data);
  });

  socket.on('agent:error', (data) => {
    const handler = eventHandlers.get('agent:error');
    if (handler) handler(data);
  });

  // Forward devtools run events to registered handlers
  socket.on('run:data', (data) => {
    const handler = eventHandlers.get('run:data');
    if (handler) handler(data);
  });

  socket.on('run:complete', (data) => {
    const handler = eventHandlers.get('run:complete');
    if (handler) handler(data);
  });

  socket.on('run:error', (data) => {
    const handler = eventHandlers.get('run:error');
    if (handler) handler(data);
  });
}

/**
 * Register event handler
 */
export function onCosRunnerEvent(event, handler) {
  eventHandlers.set(event, handler);
}

/**
 * Check if CoS Runner is available
 */
export async function isRunnerAvailable() {
  const response = await fetch(`${COS_RUNNER_URL}/health`).catch(() => null);
  if (!response || !response.ok) return false;
  return true;
}

/**
 * Get runner health status
 */
export async function getRunnerHealth() {
  const response = await fetch(`${COS_RUNNER_URL}/health`).catch(() => null);
  if (!response || !response.ok) {
    return { available: false, error: 'Runner not available' };
  }
  const data = await response.json();
  return { available: true, ...data };
}

/**
 * Spawn an agent via the CoS Runner
 */
export async function spawnAgentViaRunner(options) {
  const {
    agentId,
    taskId,
    prompt,
    workspacePath,
    model,
    envVars,
    claudePath
  } = options;

  const response = await fetch(`${COS_RUNNER_URL}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      taskId,
      prompt,
      workspacePath,
      model,
      envVars,
      claudePath
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to spawn agent');
  }

  return response.json();
}

/**
 * Get list of active agents from runner
 */
export async function getActiveAgentsFromRunner() {
  const response = await fetch(`${COS_RUNNER_URL}/agents`);
  if (!response.ok) {
    throw new Error('Failed to get agents');
  }
  return response.json();
}

/**
 * Terminate an agent via the runner (graceful SIGTERM with SIGKILL fallback)
 */
export async function terminateAgentViaRunner(agentId) {
  const response = await fetch(`${COS_RUNNER_URL}/terminate/${agentId}`, {
    method: 'POST'
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to terminate agent');
  }
  return response.json();
}

/**
 * Force kill an agent via the runner (immediate SIGKILL)
 */
export async function killAgentViaRunner(agentId) {
  const response = await fetch(`${COS_RUNNER_URL}/kill/${agentId}`, {
    method: 'POST'
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to kill agent');
  }
  return response.json();
}

/**
 * Get process stats for an agent
 */
export async function getAgentStatsFromRunner(agentId) {
  const response = await fetch(`${COS_RUNNER_URL}/agents/${agentId}/stats`);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

/**
 * Terminate all agents via the runner
 */
export async function terminateAllAgentsViaRunner() {
  const response = await fetch(`${COS_RUNNER_URL}/terminate-all`, {
    method: 'POST'
  });
  if (!response.ok) {
    throw new Error('Failed to terminate agents');
  }
  return response.json();
}

/**
 * Get agent output from runner
 */
export async function getAgentOutputFromRunner(agentId) {
  const response = await fetch(`${COS_RUNNER_URL}/agents/${agentId}/output`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get agent output');
  }
  return response.json();
}

// ============================================
// DEVTOOLS RUNS - CLI execution via runner
// ============================================

/**
 * Execute a CLI run via the CoS Runner
 */
export async function executeCliRunViaRunner(options) {
  const {
    runId,
    command,
    args,
    prompt,
    workspacePath,
    envVars,
    timeout
  } = options;

  const response = await fetch(`${COS_RUNNER_URL}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId,
      command,
      args,
      prompt,
      workspacePath,
      envVars,
      timeout
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to execute run');
  }

  return response.json();
}

/**
 * Get list of active runs from runner
 */
export async function getActiveRunsFromRunner() {
  const response = await fetch(`${COS_RUNNER_URL}/runs`);
  if (!response.ok) {
    throw new Error('Failed to get runs');
  }
  return response.json();
}

/**
 * Check if a run is active in the runner
 */
export async function isRunActiveInRunner(runId) {
  const response = await fetch(`${COS_RUNNER_URL}/runs/${runId}/active`);
  if (!response.ok) {
    return false;
  }
  const data = await response.json();
  return data.active;
}

/**
 * Get run output from runner
 */
export async function getRunOutputFromRunner(runId) {
  const response = await fetch(`${COS_RUNNER_URL}/runs/${runId}/output`);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.output;
}

/**
 * Stop a run via the runner
 */
export async function stopRunViaRunner(runId) {
  const response = await fetch(`${COS_RUNNER_URL}/runs/${runId}/stop`, {
    method: 'POST'
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to stop run');
  }
  return response.json();
}
