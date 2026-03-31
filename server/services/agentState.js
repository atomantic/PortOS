/**
 * Shared mutable state for agent tracking.
 * Imported by agentLifecycle.js, agentManagement.js, and subAgentSpawner.js.
 */

// activeAgents: direct spawn mode processes (Map<agentId, { process, task, runId, ... }>)
export const activeAgents = new Map();

// runnerAgents: runner-spawned agents (Map<agentId, { taskId, task, runId, model, ... }>)
export const runnerAgents = new Map();

// userTerminatedAgents: agents the user explicitly killed (Set<agentId>)
export const userTerminatedAgents = new Set();

// spawningTasks: tasks currently being spawned (Set<taskId>) — deduplication guard
export const spawningTasks = new Set();

// useRunner: whether CoS Runner mode is active
export let useRunner = false;
export const setUseRunner = (val) => { useRunner = val; };
