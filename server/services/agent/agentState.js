/**
 * Shared mutable state for agent tracking.
 * Imported by agentLifecycle.js, agentManagement.js, and subAgentSpawner.js.
 *
 * **This module must stay import-free.** It is what lets modules that cannot
 * import each other share state, so one import of a cluster module here closes
 * a cycle for every one of them at once. `server/test/guards/modules/serviceImportCycles.test.js` enforces it.
 */

export const activeAgents = new Map();

export const runnerAgents = new Map();

// A runner entry may carry `releaseOllamaWork`, the in-flight hold that keeps
// another spawn's context reload from restarting the local Ollama daemon under a
// live harness (#17342). Mutate the map ONLY through these two helpers so every
// teardown and overwrite releases that hold; a bare `runnerAgents.delete` leaks
// it and defers every later reload until the drain timeout.
const releaseEntryHold = (entry) => {
  try {
    entry?.releaseOllamaWork?.();
  } catch (err) {
    console.error(`❌ Ollama work release failed: ${err.message}`);
  }
};

/** Track a runner-hosted agent; an entry it replaces has its hold released. */
export const trackRunnerAgent = (agentId, entry) => {
  const previous = runnerAgents.get(agentId);
  runnerAgents.set(agentId, entry);
  if (previous && previous !== entry) releaseEntryHold(previous);
  return entry;
};

/** Stop tracking a runner-hosted agent and release its in-flight hold. */
export const dropRunnerAgent = (agentId) => {
  const entry = runnerAgents.get(agentId);
  const deleted = runnerAgents.delete(agentId);
  releaseEntryHold(entry);
  return deleted;
};

// Completion events can outlive the runner process (hooks, forge checks and
// persistence all await). Sweeps must not race them to the first terminal write.
export const completingAgents = new Set();

export const userTerminatedAgents = new Set();

// pausedAgents: stopped without finalizing the task or cleaning up the worktree
export const pausedAgents = new Map();

const pausedExitWaiters = new Map();

/**
 * Consume the pause flag on the way out of a close handler. Deleting through
 * here also releases `whenPausedAgentExits` waiters, so the delete IS the
 * notification.
 */
export const consumePausedAgentExit = (agentId) => {
  pausedAgents.delete(agentId);
  const waiters = pausedExitWaiters.get(agentId);
  if (!waiters) return;
  pausedExitWaiters.delete(agentId);
  for (const settle of waiters) settle(true);
};

/**
 * Resolve once a paused agent's process is gone — `true` if the exit was
 * observed, `false` if the window closed first.
 *
 * `pauseAgent` returns after the signal and the close handler lands later. A
 * caller that retires the record first (relaunch) must let that handler run, or
 * it would finalize the run and clean up the worktree the requeued task uses.
 *
 * An agent not in `activeAgents` has nothing to wait for: the handler already
 * ran, or the run is runner-backed and its stop was confirmed by an awaited RPC.
 */
export const whenPausedAgentExits = (agentId, timeoutMs) => {
  if (!activeAgents.has(agentId)) return Promise.resolve(true);
  return new Promise(resolve => {
    const settle = (exited) => {
      clearTimeout(timer);
      const waiters = pausedExitWaiters.get(agentId);
      if (waiters) {
        const rest = waiters.filter(w => w !== settle);
        if (rest.length) pausedExitWaiters.set(agentId, rest);
        else pausedExitWaiters.delete(agentId);
      }
      resolve(exited);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    pausedExitWaiters.set(agentId, [...(pausedExitWaiters.get(agentId) || []), settle]);
  });
};

export const spawningTasks = new Set();

// spawnedAgentCommands: OS pid → spawn metadata for agents this server started
// Kept here, not in `agents.js`, so `agents.js` can statically import the
// orchestrator without an import cycle (#3450).
const spawnedAgentCommands = new Map();

export const registerSpawnedAgent = (pid, data) => {
  spawnedAgentCommands.set(pid, {
    fullCommand: data.fullCommand,
    agentId: data.agentId,
    taskId: data.taskId,
    model: data.model,
    workspacePath: data.workspacePath,
    prompt: data.prompt,
    registeredAt: Date.now()
  });
};

export const unregisterSpawnedAgent = (pid) => { spawnedAgentCommands.delete(pid); };

export const getSpawnedAgent = (pid) => spawnedAgentCommands.get(pid);

export let useRunner = false;
export const setUseRunner = (val) => { useRunner = val; };

// Agents between worktree creation and `registerAgent` (Set<agentId>). A fresh
// branch sits at the default HEAD, so a reaper would read it as clean and merged;
// listing the id in `getActiveAgentIds()` protects it from every reaper that
// consults it.
export const dispatchingAgentIds = new Set();
export const markAgentDispatching = (agentId) => { dispatchingAgentIds.add(agentId); };
export const clearAgentDispatching = (agentId) => { dispatchingAgentIds.delete(agentId); };

// Lives here so cleanup jobs can read it without importing `subAgentSpawner.js`
// (which re-exports the whole lifecycle graph); `subAgentSpawner` re-exports it.
export const getActiveAgentIds = () => [...activeAgents.keys(), ...runnerAgents.keys(), ...dispatchingAgentIds];

/**
 * Agent ids whose worktree must not be taken out from under them, from an
 * already-read agent list:
 *
 *   - the in-process maps, authoritative for THIS process;
 *   - every persisted `running` agent (restart survivors, absent from the maps);
 *   - every persisted `paused` agent (pausing preserves the tree as resume context).
 *
 * Under-counting removes a directory another run is mid-edit in. Takes the list
 * to stay off `cos.js`'s import path.
 *
 * @param {Array<{id?: string, status?: string}>} [agents]
 * @returns {Set<string>}
 */
export const protectedAgentIds = (agents = []) => {
  const ids = new Set(getActiveAgentIds());
  for (const agent of agents) {
    if (agent?.status === 'running' || agent?.status === 'paused') ids.add(agent.id);
  }
  return ids;
};

// Does THIS process already own the agent's lifecycle?
//
// Which map an agent lands in is not guessable from `executionMode`: a
// runner-backed TUI (`runner-tui`) registers in `activeAgents`, NEVER in
// `runnerAgents` (only `spawnViaRunner` populates that). Consult this, not either
// map alone, or a live TUI reads as an unowned restart survivor and a stray runner
// `agent:completed` event double-finalizes it.
export const isAgentOwnedLocally = (agentId) => activeAgents.has(agentId) || runnerAgents.has(agentId);

/**
 * Keep task ownership through the whole run, including completion bookkeeping.
 * Durable running records protect restart survivors; local maps protect the
 * gap between agent completion and task completion. Age alone never releases
 * ownership: orphan/zombie recovery must retire a dead run first.
 */
export const hasActiveTaskOwner = (taskId, agents = {}) => {
  if (Object.values(agents).some(agent => agent.taskId === taskId && agent.status === 'running')) return true;
  for (const entries of [activeAgents, runnerAgents]) {
    for (const agent of entries.values()) {
      if ((agent.taskId || agent.task?.id) === taskId) return true;
    }
  }
  return false;
};

// Metadata booleans may arrive as true/'true' or false/'false' (typed rows vs rows stored before #16407 and peers on older versions)
export { isTruthyMeta, isFalsyMeta } from '../../lib/metadataFlags.js';

// Metadata strings may be absent, empty, or non-string (objects/numbers leak past `||` checks).
// Returns `value` only when it's a non-empty string, otherwise `fallback`.
export const metaStringOr = (value, fallback) => (typeof value === 'string' && value) ? value : fallback;
