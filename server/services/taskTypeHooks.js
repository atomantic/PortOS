/**
 * Programmatic-I/O hooks per scheduled task type.
 *
 * Most scheduled task types are `prompt → agent → wait for the .agent-done
 * sentinel`. A few need PROGRAMMATIC steps around the agent. A hook module may
 * export either or both of:
 *
 *   - `buildTaskInput({ app, taskType })` — runs BEFORE spawn, inside the task
 *     generator. Collects data beyond the base prompt (telemetry, open issues, …)
 *     and returns `{ prompt?, providerId?, model?, skip? }`:
 *       • `prompt`     — a fully-rendered prompt that REPLACES the template.
 *       • `providerId` / `model` — pin the agent's provider/model (per-app choice).
 *       • `skip: { reason }` — short-circuit: no agent is spawned.
 *
 *   - `processTaskOutput({ appId, success, payload, workspacePath, agentId, task }, deps?)`
 *     — runs AFTER the agent finishes, from the finalize chokepoint. `payload` is
 *     the parsed `.agent-done` sentinel payload (the agent's structured output);
 *     the hook does deterministic work on it (e.g. filing a tracker issue) and
 *     returns an outcome. `deps` is an injectable seam for tests.
 *
 * The agent itself runs through the NORMAL path (visible in the CoS queue +
 * Active Agents, TUI-capable), so a programmatic-I/O task differs from any other
 * scheduled task only in these two slots. See
 * docs/plans/2026-07-09-programmatic-io-scheduled-tasks.md.
 *
 * Hook modules are lazy-imported (their dependency graphs are heavy) and resolved
 * by task type. `HOOK_MODULES` is the single registration point; a new
 * programmatic-I/O task type adds one entry here plus a module that exports the
 * hook(s) above. The resolvers return `null` for any unregistered type without
 * importing anything, so a normal task type pays ~zero cost.
 */

// taskType → () => import('./path/to/hookModule.js'). A module may export either
// or both hooks; a missing export means "no hook of that kind for this type".
const HOOK_MODULES = {
  'layered-intelligence': () => import('./autonomousJobs/layeredIntelligenceHooks.js'),
};

async function loadHookModule(taskType) {
  const load = HOOK_MODULES[taskType];
  if (!load) return null;
  return load();
}

/**
 * Resolve the pre-agent input hook for a task type, or null if it has none.
 * `buildTaskInput({ app, taskType })` → `{ prompt?, providerId?, model?, skip? }`.
 */
export async function getTaskInputHook(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.buildTaskInput === 'function' ? mod.buildTaskInput : null;
}

/**
 * Resolve the post-agent output hook for a task type, or null if it has none.
 * `processTaskOutput({ appId, success, payload, workspacePath, agentId, task })` → outcome.
 */
export async function getTaskOutputHook(taskType) {
  const mod = await loadHookModule(taskType);
  return mod && typeof mod.processTaskOutput === 'function' ? mod.processTaskOutput : null;
}
