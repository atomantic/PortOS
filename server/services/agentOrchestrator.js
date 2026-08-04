/**
 * agentOrchestrator — the one place callers ask for an agent LIFECYCLE TRANSITION.
 *
 * ## Why this module exists (#3450)
 *
 * Seven modules in the core agent path form one tightly-coupled cluster:
 *
 *   cos.js → cosAgents.js → cosAgentLifecycle.js → agentManagement.js
 *          → agents.js → subAgentSpawner.js → agentLifecycle.js
 *
 * with several edges reaching back up the chain. There is no correctness bug —
 * the load-bearing back-edges are already broken with `await import(...)` (see
 * the comment at `cosAgentLifecycle.js#pauseAgent`) and `agentImportCycles.test.js`
 * derives the live static graph from source and guards it. The cost is
 * comprehension: no module owns the agent state machine, so reasoning about one
 * transition means holding all seven files in mind.
 *
 * This module sits ABOVE that cluster. It imports the three modules that own
 * transitions (`agentManagement`, `cosAgentLifecycle`, `agentLifecycle`) and is
 * imported BY nobody inside the cluster — so its edges stay static and callers
 * above `server/services/` get one unambiguous entry point.
 *
 * `subAgentSpawner.js` calls itself an orchestrator but cannot be this: it is
 * *inside* the cluster (`agents.js` and `cos.js` both reach it via
 * `await import(...)`), and it re-exports ~40 symbols as a back-compat barrel.
 * A facade has to be small, complete, and outside the graph it fronts.
 *
 * **Invariant, enforced by `agentImportCycles.test.js`: none of those seven
 * modules may import this one — statically OR via `await import(...)`.** One
 * such edge closes the loop and puts every dynamic-import workaround back on the
 * table, and this cluster's habit is to reach across a blocked layer with
 * `await import()`, so the guard checks both forms. Anything *outside* the seven
 * may import the facade freely — routes, socket handlers, and any service the
 * cluster does not depend on. That is the migration path for the exports below
 * whose current callers are still inside the cluster: the caller moves out, it
 * does not import back in.
 *
 * ## Transition vs leaf (step 1 of the #3450 sequencing)
 *
 * TRANSITIONS move an agent between states. They are exactly the exports below,
 * annotated there with the state edge each one drives. Two of them are the same
 * name in two different modules — `cosAgentLifecycle.terminateAgent` only
 * *requests* termination (emits `agent:terminate`, returns immediately) while
 * `agentManagement.terminateAgent` runs the real signal sequence. That collision
 * is the most confusing thing in the cluster, so the facade renames the
 * request-side one to `requestAgentTermination` and lets the process-side one
 * keep its name, symmetric with its sibling `killAgent`. CLAUDE.md resolves
 * same-name collisions with `export * as <namespace>`, but namespacing here
 * would spell the call `agentOrchestrator.agentManagement.terminateAgent` —
 * re-exposing the very leaf module the facade exists to hide — so this one
 * renames instead.
 *
 * LEAVES are everything a transition calls on its way through, and they stay
 * exactly where they are — the facade does not wrap them and never should:
 * persisted agent state (`cosAgentLifecycle` reads/writes, `cosAgentIndex`,
 * `cosState`), the in-memory maps (`agentState`), OS process control (`agents.js`,
 * `bufferedSpawn.killProcessTree`), runner RPC (`cosRunnerClient`), the task store
 * (`cos.js` task functions), post-run work (`agentWorktreeCleanup`,
 * `agentFinalization`, `agentRunTracking`, `agentCompletionCleanup`,
 * `agentSummaryExtraction`), and the pure re-export barrels (`cosAgents.js`,
 * `subAgentSpawner.js`). If it is not exported below, it is a leaf.
 *
 * ## What is still outstanding
 *
 * `server/routes/cosAgentRoutes.js` is migrated. Every other call site still
 * reaches these transitions through `cos.js` or `subAgentSpawner.js`, and the
 * `await import(...)` forwarders at `cosAgentLifecycle.js#pauseAgent` /
 * `#killAgent` / `#getAgentProcessStats` still exist to serve them — those are
 * steps 3 and 4 of the #3450 sequencing. `grep -rn agentOrchestrator server/`
 * is the live answer to "what has moved so far".
 */

// Process/runner layer — owns the live agent maps and the OS-level signals.
export {
  pauseAgent,           // running → paused (process stopped, worktree preserved)
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
