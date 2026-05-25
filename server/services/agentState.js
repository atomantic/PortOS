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

// Active agent IDs (direct-mode + runner-mode), for zombie/orphan detection.
// Lives here in the side-effect-free state module so callers (cleanup jobs,
// zombie sweeps) can read it without importing `subAgentSpawner.js`, whose
// module load runs `initSpawner()` + schedules orphan cleanup. `subAgentSpawner`
// re-exports it for backward compatibility.
export const getActiveAgentIds = () => [...activeAgents.keys(), ...runnerAgents.keys()];

// Metadata booleans may arrive as true/'true' or false/'false' (JSON vs TASKS.md string round-trip)
export const isTruthyMeta = (value) => value === true || value === 'true';
export const isFalsyMeta = (value) => value === false || value === 'false';

// Metadata strings may be absent, empty, or non-string (objects/numbers leak past `||` checks).
// Returns `value` only when it's a non-empty string, otherwise `fallback`.
export const metaStringOr = (value, fallback) => (typeof value === 'string' && value) ? value : fallback;
