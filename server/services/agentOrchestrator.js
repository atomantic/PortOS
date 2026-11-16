/**
 * agentOrchestrator — the one place callers ask for an agent LIFECYCLE TRANSITION.
 *
 * Sits ABOVE the core agent cluster and is imported BY nobody inside it, so its edges stay
 * static. **Enforced by `agentImportCycles.test.js`: no module reachable FROM this one may
 * import it back, statically OR via `import(...)`.** Inside the closure, push what the
 * importer wanted into a leaf (`agentState.js`), never a deferred import or a barrel.
 *
 * Only transitions are exported; everything else is a leaf. Two share a name:
 * `cosAgentLifecycle.terminateAgent` only *requests* termination, renamed
 * `requestAgentTermination` here; `agentManagement.terminateAgent` runs the signal sequence.
 */

export {
  pauseAgent,           // running → paused (process stopped, worktree preserved)
  resumeAgent,          // paused → completed, task requeued on the preserved branch
  relaunchAgent,        // running → paused → completed, task requeued on a new provider/model
  killAgent,            // running → completed (immediate SIGKILL)
  terminateAgent,       // running → completed (SIGTERM, SIGKILL fallback)
  getAgentProcessStats, // read, not a transition — but it needs the process layer
} from './agentManagement.js';

export {
  completeAgent,                            // running|paused → completed
  terminateAgent as requestAgentTermination, // emits `agent:terminate`, returns
} from './cosAgentLifecycle.js';

export { spawnAgentForTask } from './agentLifecycle.js'; // (none) → running
