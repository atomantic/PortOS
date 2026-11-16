/**
 * agentOrchestrator — the one place callers ask for an agent LIFECYCLE TRANSITION.
 *
 * Sits ABOVE the core agent cluster (`cos.js`, `cosAgentLifecycle.js`, `agentManagement.js`,
 * `agentLifecycle.js`, `subAgentSpawner.js`): it imports the three modules that own transitions
 * (`agentManagement`, `cosAgentLifecycle`, `agentLifecycle`) and is imported BY nobody inside the
 * cluster, so its edges stay static and callers above `server/services/` get one entry point.
 * `subAgentSpawner.js` is the cluster's EVENT WIRING, not this facade, and consumes it.
 *
 * **Invariant, enforced by `agentImportCycles.test.js`: no module reachable FROM this one may
 * import it back, statically OR via `import(...)`.** The forbidden set is derived from the graph.
 * Anything outside that closure may import the facade freely.
 *
 * ## Transition vs leaf
 *
 * TRANSITIONS move an agent between states; they are exactly the exports below, annotated with the
 * state edge each drives. Two share a name across modules: `cosAgentLifecycle.terminateAgent` only
 * *requests* termination (emits `agent:terminate`) while `agentManagement.terminateAgent` runs the
 * real signal sequence. The request side is renamed `requestAgentTermination` here (a namespace
 * export would re-expose the leaf module the facade hides). LEAVES — persisted agent state, the
 * in-memory maps (`agentState`), OS process control, runner RPC, the task store, post-run work —
 * stay where they are and are never wrapped. If it is not exported below, it is a leaf.
 *
 * ## Moving a caller out of the closure
 *
 * A caller stuck inside the closure is imported BY something in it. Push what that importer wanted
 * down into a leaf and the caller migrates itself. Use `agentState.js` for shared mutable state (it
 * is import-free); do not add a second leaf. Do NOT reach back in with a deferred import: the
 * guard rejects it. `agentState.js#spawnedAgentCommands` is the worked example.
 *
 * ## Callers that cannot move out
 *
 * `agentManagement.js` and `agentLifecycle.js` DEFINE transitions this module re-exports, and
 * `agentFinalization.js` and `agentCliSpawning.js` are leaves those two must call. For them the
 * goal is ONE address per transition: this module above the closure, the declaring module inside
 * it (`cosAgentLifecycle.js` for `completeAgent`). A barrel is never an answer;
 * `agentImportCycles.test.js` fails any production module that reaches a transition through one.
 * `grep -rn agentOrchestrator server/` shows what has migrated; keep no call-site inventory here.
 */

// Process/runner layer — owns the live agent maps and the OS-level signals.
export {
  pauseAgent,           // running → paused (process stopped, worktree preserved)
  resumeAgent,          // paused → completed, task requeued on the preserved branch
  relaunchAgent,        // running → paused → completed, task requeued on a new provider/model
  killAgent,            // running → completed (immediate SIGKILL)
  terminateAgent,       // running → completed (SIGTERM, SIGKILL fallback)
  getAgentProcessStats, // read, not a transition — but it needs the process layer
} from './agentManagement.js';

// Persisted-state layer — owns the agent record on disk.
export {
  completeAgent,                            // running|paused → completed
  terminateAgent as requestAgentTermination, // emits `agent:terminate`, returns
} from './cosAgentLifecycle.js';

// Spawn layer — turns a task into a running agent.
export { spawnAgentForTask } from './agentLifecycle.js'; // (none) → running
