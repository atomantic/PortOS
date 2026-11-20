/**
 * agentOrchestrator — the one place callers ask for an agent LIFECYCLE TRANSITION.
 *
 * Sits ABOVE the core agent cluster and is imported BY nobody inside it, so its edges stay
 * static. **Enforced by `server/test/guards/modules/serviceImportCycles.test.js`: no module reachable FROM this one may
 * import it back, statically OR via `import(...)`.** Inside the closure, push what the
 * importer wanted into a leaf (`agentState.js`), never a deferred import or a barrel.
 *
 * Only transitions are exported; everything else is a leaf.
 */

export {
  pauseAgent,           // running → paused (process stopped, worktree preserved)
  resumeAgent,          // paused → completed, task requeued on the preserved branch
  relaunchAgent,        // running → paused → completed, task requeued on a new provider/model
  killAgent,            // running → completed (immediate SIGKILL)
  getAgentProcessStats, // read, not a transition — but it needs the process layer
} from './agentManagement.js';

export {
  completeAgent, // running|paused → completed
} from '../cos/cosAgentLifecycle.js';

export { spawnAgentForTask } from './agentLifecycle.js'; // (none) → running
