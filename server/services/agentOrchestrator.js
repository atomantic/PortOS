/**
 * agentOrchestrator — the one place callers ask for an agent LIFECYCLE TRANSITION.
 *
 * ## Why this module exists (#3450)
 *
 * Seven modules in the core agent path formed one tightly-coupled cluster when
 * this was filed:
 *
 *   cos.js → cosAgents.js → cosAgentLifecycle.js → agentManagement.js
 *          → agents.js → subAgentSpawner.js → agentLifecycle.js
 *
 * with several edges reaching back up the chain. There is no correctness bug —
 * the load-bearing back-edges were broken with `await import(...)` before this
 * module existed, and `agentImportCycles.test.js` derives the live static graph
 * from source and guards it. The cost is comprehension: no module owns the agent
 * state machine, so reasoning about one transition means holding all seven files
 * in mind. (`cos.js#handleOrphanedTask` is what a surviving deferred back-edge
 * looks like; the ones this facade replaced are described further down. The
 * `agents.js` and `subAgentSpawner.js` hops in that chain are gone — read it as
 * the shape of the problem, not as today's graph.)
 *
 * This module sits ABOVE that cluster. It imports the three modules that own
 * transitions (`agentManagement`, `cosAgentLifecycle`, `agentLifecycle`) and is
 * imported BY nobody inside the cluster — so its edges stay static and callers
 * above `server/services/` get one unambiguous entry point.
 *
 * `subAgentSpawner.js` calls itself an orchestrator but is not this one: it is
 * the cluster's EVENT WIRING (runner handlers, `task:ready`, `agent:terminate`),
 * and it used to re-export ~40 symbols as a back-compat barrel — including three
 * transitions this facade also owns. That barrel is retired (#3450), along with
 * the pass-through re-exports `agentLifecycle.js` kept for it, so the two modules
 * no longer answer the same question two ways. What is left there consumes the
 * facade rather than duplicating it.
 *
 * **Invariant, enforced by `agentImportCycles.test.js`: no module reachable
 * FROM this one may import it back — statically OR via `import(...)`.** One such
 * edge closes the loop and puts every dynamic-import workaround back on the
 * table, and this cluster's habit is to reach across a blocked layer with a
 * deferred import, so the guard checks both forms. The forbidden set is derived
 * from the graph rather than listed, so it grows as the cluster does. Anything
 * *outside* that closure may import the facade freely — routes, socket handlers,
 * and any service the cluster does not depend on. That is the migration path for
 * the exports below whose current callers are still inside the cluster: the
 * caller moves out, it does not import back in.
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
 * `agentSummaryExtraction`), and the one remaining re-export barrel
 * (`cosAgents.js`). If it is not exported below, it is a leaf.
 *
 * ## Moving a caller out (the shape every migration takes)
 *
 * A caller is stuck inside the closure because something in the closure imports
 * IT. Find that edge, push what the importer actually wanted down into a leaf,
 * and the caller migrates itself. Use `agentState.js` for shared mutable state —
 * it is import-free precisely so modules that cannot import each other can still
 * share; do not add a second leaf beside it. Do NOT reach back in with a deferred
 * import: the guard rejects it, and it is how this cluster got here in the first
 * place. `agentState.js#spawnedAgentCommands` documents the worked example.
 *
 * ## What is still outstanding
 *
 * `server/routes/cosAgentRoutes.js`, `agents.js` and `subAgentSpawner.js`'s event
 * wiring are migrated, the deferred forwarders that used to sit in
 * `cosAgentLifecycle.js` are gone along with the `cos.js` re-exports that were
 * their only consumers, and the `subAgentSpawner.js` barrel (plus the
 * `agentLifecycle.js` pass-throughs whose last consumer it was) is retired.
 * `grep -rn agentOrchestrator server/` is the live answer to what has moved —
 * do not keep a hand-written call-site inventory here; it only goes stale.
 *
 * Remaining: the transitions below that still have callers INSIDE the closure
 * (all four are `completeAgent`, reached through `cosAgents.js`), and the two
 * barrels that still expose a partial view of the cluster — `cosAgents.js` and
 * `cos.js`'s agent re-export block. Note that `agentFinalization.js` and
 * `agentCliSpawning.js` are LEAVES that call a transition, so "move the caller
 * out" does not apply to them as written: the closure edge to break is the one
 * `agentLifecycle.js`/`agentManagement.js` hold INTO them, not an import of
 * theirs.
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
