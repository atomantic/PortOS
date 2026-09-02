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
 * (`cosAgents.js` no longer exists — it was the back-compat barrel between
 * `cos.js` and the four modules the #2530 split produced, and #3450 retired it.)
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
 * keep its name, symmetric with its sibling `killAgent`. AGENTS.md resolves
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
 * `agentSummaryExtraction`). If it is not exported below, it is a leaf.
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
 * ## When the caller CANNOT move out (the other half)
 *
 * Some callers are inside the closure permanently, and no edge-breaking changes
 * that. `agentManagement.js` and `agentLifecycle.js` DEFINE transitions this
 * module re-exports — importing the facade from either is the cycle, by
 * construction. `agentFinalization.js` and `agentCliSpawning.js` are leaves those
 * two must call to spawn and to finalize; inverting that would move the spawn
 * implementation and the completion flow, which buys nothing the facade wants.
 *
 * For those, the achievable property is not "use the facade" — it is the one the
 * facade exists to create: ONE address per transition. Above the closure that
 * address is this module; inside it, the module that DECLARES the function
 * (`cosAgentLifecycle.js` for `completeAgent`). A barrel is never an answer.
 * `agentImportCycles.test.js` derives the transition names from the export blocks
 * below, walks re-export edges to find which modules forward them, and fails any
 * production module that reaches a transition through one — by named import,
 * renamed import, namespace property read, or destructure off a namespace handle.
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
 * Step 3 is done. The four in-closure `completeAgent` callers
 * (`agentManagement`, `agentLifecycle`, `agentFinalization`, `agentCliSpawning`)
 * name `cosAgentLifecycle.js` directly under the rule above, and the deferred
 * `import('./cos.js')` in `cleanupOrphanedAgents` — which reached `completeAgent`
 * and `getAgents` through the `cos.js` re-export block for no cycle-breaking
 * benefit, since that module is a static import here — is gone with it.
 *
 * The `cosAgents.js` barrel is retired too. It re-exported all four modules the
 * #2530 split produced (`cosAgentIndex`, `cosAgentLifecycle`, `cosAgentFeedback`,
 * `cosAgentArchive`) behind one `export *` wall, so `updateAgent` and
 * `getAgentsByDate` arrived from the same specifier despite living in different
 * layers — and the barrel is what made `cos.js` a TWO-hop forwarder of a
 * transition. Every importer now names the declaring module; the four leaves are
 * unchanged, and the two test files that only ever exercised one of them are
 * renamed to sit beside it (`cosAgentLifecycle.test.js`, `cosAgentIndex.merge.test.js`).
 *
 * Remaining: `cos.js`'s agent re-export block (`export { … } from` the four
 * modules above, ~20 names) is the last partial view of the cluster. It is a
 * wide surface with many `vi.mock`ed importers and wants its own PR.
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
