/**
 * CoS local-inference agent slots
 *
 * `promptRunner`'s `withLocalConcurrencyGate` caps IN-FLIGHT calls per local endpoint but only sees requests
 * PortOS itself makes. A CoS TUI agent runs a vendor CLI with its own connection to the model server, so PortOS
 * never observes that traffic and `dequeueNextTask` could dispatch several agents at one GPU and OOM it.
 *
 * This module supplies the *avoidance* half, at two altitudes:
 *
 *   - `acquireLocalEndpointSpawnSlot` is the AUTHORITATIVE cap, called from subAgentSpawner's `task:ready`
 *     listener (the chokepoint every emitter funnels through). It reserves the slot across the spawn window so two
 *     dispatches can't both pass a pre-registration snapshot.
 *   - `createLocalEndpointSlotContext` feeds the pure capacity tracker in cosDequeue.js, so `dequeueNextTask`
 *     never emits a task that would be held, and logs queued-no-slot against the right task.
 *
 * Separate accounting from promptRunner's in-process gate on purpose: one throttles requests PortOS makes, the
 * other agents PortOS launches. A shared counter across process boundaries isn't worth the coupling.
 */

import { LOCAL_LLM_MAX_CONCURRENCY } from '../../lib/localLlmConcurrency.js';
import { SWARM_COUNT_MAX, SWARM_COUNT_MIN } from '../../lib/cos/cosTaskMetadata.js';
import { localRuntimeForProvider, localEndpointPort, normalizeOpenAiBaseUrl } from '../../lib/localProviderRuntime.js';
import { listProviders, getActiveProvider } from '../provider/providers.js';
import { isProviderAvailable, getFallbackProvider } from '../provider/providerStatus.js';
import { allowedModesFor } from '../../lib/callerModePolicy.js';

/**
 * The raw base URL a provider's inference actually goes to, local or not.
 *
 * `localRuntimeForProvider` owns this question: the provider's own configured base (an OpenCode `baseURL`,
 * `ANTHROPIC_BASE_URL`, or `endpoint`), then the `OLLAMA_URL`/`OLLAMA_HOST`/`LM_STUDIO_URL` overrides the backend
 * managers read, then the runtime's canonical default. Otherwise a user relocating their daemon with
 * `OLLAMA_HOST` would get two slot keys for one daemon, the double-booking this cap prevents.
 *
 * It answers `null` for a provider mapping to no KNOWN local runtime, so fall back to the recorded endpoint: an
 * arbitrary local server (e.g. the shipped `opencode-vllm-tui` on `127.0.0.1:18020`) still occupies a GPU.
 * Whether either is on THIS box is decided by `localEndpointPort`, never by the provider's name or model id.
 */
export function providerBaseUrl(provider) {
  return localRuntimeForProvider(provider)?.endpoint
    || provider?.endpoint
    // Last resort, and REMOTE by construction (`localRuntimeForProvider` already took this value when it pointed at
        // this box). It must still be returned: an Ollama-backed CLI aimed at another host records its base ONLY here,
        // and `endpointForAgent` treats an absent stamp as "re-resolve by id". Answering null would let that cloud agent
        // start counting against a local endpoint when its provider record is re-pointed.
    || provider?.envVars?.ANTHROPIC_BASE_URL
    || null;
}

/**
 * The slot key a provider's inference occupies, or null when it isn't on this machine. Host+port identifies the
 * model server; scheme, path (`/v1`) and host SPELLING do not (the catalog seeds `lmstudio` at `localhost:1234`
 * and the rest at `127.0.0.1`, so the raw string would give one process two caps).
 *
 * `localEndpointPort` supplies that normalization (loopback spellings collapse, port defaults by scheme) AND
 * rejects a LAN/Tailscale peer that merely shares a port. Not gated on `provider.type === 'api'` (unlike
 * promptRunner's request gate): a TUI provider pointed at a local LM Studio is the case this exists for.
 */
export function localEndpointOfProvider(provider) {
  return localSlotKey(providerBaseUrl(provider));
}

/**
 * Codex's multi-agent limit includes the root orchestrator, so cloud claim swarms need `workers + 1` session
 * threads to honor the configured worker count. A provider on this machine gets no override: local inference stays
 * governed by its bounded GPU concurrency posture.
 */
export function cloudSwarmThreadCapacity(provider, swarmCount) {
  const workers = Number(swarmCount);
  if (!Number.isSafeInteger(workers) || workers < SWARM_COUNT_MIN || workers > SWARM_COUNT_MAX) return null;
  return localEndpointOfProvider(provider) ? null : workers + 1;
}

// Normalize first so a schemeless value still parses: `localEndpointPort` goes through `new URL`, which reads
// `localhost:1234` as a SCHEME and yields null, and UI-configured providers can carry a bare `host:port`.
const localSlotKey = (endpoint) => {
  const port = localEndpointPort(normalizeOpenAiBaseUrl(endpoint));
  return port ? `localhost:${port}` : null;
};

/**
 * Build the per-cycle local-endpoint lookups from an ALREADY-FETCHED provider snapshot. Pure and synchronous, so
 * the capacity tracker can consult it per candidate and tests can drive it with fixtures.
 *
 *  - `endpointForAgent(agent)`: the endpoint a RUNNING agent occupies, from the `providerId` agentLifecycle stamps
 *    onto its metadata.
 *  - `resolveLocalEndpoint(task)`: the endpoint a QUEUED task would land on. Mirrors
 *    `resolveAgentProviderAndModel`: a `metadata.provider` pin wins, an unknown pin falls back to the active
 *    provider, and an UNAVAILABLE provider is followed through the SAME `getFallbackProvider` spawn uses. Gating
 *    on a benched provider would hold the task behind a GPU it never touches; ignoring the swap would drop the
 *    cap when the endpoint is unhealthy (four shipped providers share `127.0.0.1:18021`). A RUNTIME fallback later
 *    can still move a run: this is avoidance, not a guarantee; promptRunner's gate and the OOM nudge/fail-over
 *    are the recovery half.
 *
 * `isAvailable` / `resolveFallback` are injected so this stays pure.
 */
export function createLocalEndpointSlotContext({
  providers = [],
  activeProvider = null,
  // One knob governs both paths: a box that lifts LOCAL_LLM_MAX_CONCURRENCY gets as many agent slots as in-flight
    // API calls.
  limit = LOCAL_LLM_MAX_CONCURRENCY,
  isAvailable = () => true,
  resolveFallback = () => null,
} = {}) {
  const byId = new Map();
  for (const provider of providers) {
    if (provider?.id) byId.set(provider.id, provider);
  }
  if (activeProvider?.id && !byId.has(activeProvider.id)) byId.set(activeProvider.id, activeProvider);

  const endpointById = (id) => localEndpointOfProvider(byId.get(id));
  // `getFallbackProvider` indexes its providers arg BY ID, so hand it a map —
  // not the array (mirrors the same note in promptRunner.js / agentProviderResolution.js).
  const providersMap = Object.fromEntries(byId);

  // The provider a queued task would be resolved onto, before the availability check below. An unknown pin falls
    // through to the active provider, as `resolveAgentProviderAndModel` does.
  const providerForTask = (task) => {
    const pinnedId = task?.metadata?.provider;
    return (pinnedId && byId.get(pinnedId)) || activeProvider;
  };

  return {
    limit,
    endpointForAgent: (agent) => {
      // A PRESENT stamp is authoritative in BOTH directions: it is where this agent's inference actually landed, so a
            // REMOTE stamp means "not on a local endpoint", never "re-resolve the provider" (a cloud agent would start
            // counting against whatever endpoint its provider record now names). Only an ABSENT stamp (a legacy record)
            // falls back to the id lookup.
      const stamped = agent?.metadata?.providerEndpoint;
      if (stamped != null) return localSlotKey(stamped);
      const providerId = agent?.metadata?.providerId || agent?.providerId;
      return providerId ? endpointById(providerId) : null;
    },
    resolveLocalEndpoint: (task) => {
      const primary = providerForTask(task);
      if (!primary?.id) return null;
      // An unavailable provider is NOT where this task lands: spawn swaps it for a fallback that may be cloud (gating
            // would starve the task) or another provider on the SAME local server (ignoring it would drop the cap).
            // Follow the real resolver.
      const effective = isAvailable(primary.id)
        ? primary
        : resolveFallback(primary.id, providersMap, task);
      return localEndpointOfProvider(effective);
    },
  };
}

/**
 * Fetch the provider snapshot and build the lookups above.
 *
 * Never throws: `listProviders` swallows a failed read into `[]`, and an uninitialized toolkit yields a null active
 * provider, which resolves every task to null (ungated) rather than stalling the queue.
 */
// Deliberately NOT memoized: the toolkit already caches the provider read, so a local snapshot would save little
// while adding a staleness window the toolkit lacks (it invalidates on a provider edit; nothing here can observe
// that, so an edited endpoint would keep gating on its old value).
export async function buildLocalEndpointSlotContext() {
  const providers = await listProviders();
  const activeProvider = await getActiveProvider().catch(() => null);
  return createLocalEndpointSlotContext({
    providers,
    activeProvider,
    isAvailable: isProviderAvailable,
    // The REAL resolver spawn uses, so the prediction can't drift from it.
    resolveFallback: (primaryId, providersMap, task) => getFallbackProvider(
      primaryId,
      providersMap,
      task?.metadata?.fallbackProvider ?? null,
      task?.metadata?.fallbackModel ?? null,
      // Same caller mode policy `resolveAgentProviderAndModel` sends, or this
      // prediction would follow a swap onto a route spawn will refuse.
      { allowedModes: allowedModesFor('agent-harness') }
    )?.provider ?? null,
  });
}

// ── In-flight spawn reservations ───────────────────────────────────────────
// A dispatched task is invisible to the running-agent tally until its agent record reaches `running`, a window
// several awaits wide (provider resolution, prompt build, worktree setup, PTY spawn). Two `task:ready` dispatches
// in that window would read the same snapshot and both pass the cap.
//
// So the chokepoint reserves the slot up front and releases it once the spawn settles, by which point the agent
// record carries the load. A simple in-process re-entrancy guard over one server's dispatch loop (see the
// Security Model in AGENTS.md); mirrors `spawningJobIds` in cosJobScheduler.js.
//
// Each reservation carries its task id because `registerAgent` flips the record to `running` well BEFORE
// `spawnAgentForTask` returns: one agent would otherwise be counted twice (running tally AND reservation) and
// under-admit at limits above 1. Counting only reservations whose task has no running agent yet removes the
// overlap without releasing early and reopening the window.
const pendingSpawnsByEndpoint = new Map(); // endpoint -> Map<token, taskId|null>
let reservationSeq = 0;

const NOOP_RELEASE = () => {};

/**
 * Reserve an in-flight spawn slot on `endpoint` for `taskId`. Release is idempotent: the spawner calls it from a
 * `finally` a throw can reach twice, and a second decrement would free a slot still occupied.
 */
export function reserveLocalEndpointSpawn(endpoint, taskId = null) {
  if (!endpoint) return NOOP_RELEASE;
  const token = ++reservationSeq;
  let held = pendingSpawnsByEndpoint.get(endpoint);
  if (!held) {
    held = new Map();
    pendingSpawnsByEndpoint.set(endpoint, held);
  }
  held.set(token, taskId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = pendingSpawnsByEndpoint.get(endpoint);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) pendingSpawnsByEndpoint.delete(endpoint);
  };
}

/** Spawns dispatched at `endpoint` that have not yet reached `running`. */
export function pendingLocalEndpointSpawns(endpoint, { excludeTaskIds = null } = {}) {
  const held = endpoint ? pendingSpawnsByEndpoint.get(endpoint) : null;
  if (!held) return 0;
  if (!excludeTaskIds?.size) return held.size;
  let count = 0;
  for (const taskId of held.values()) {
    if (!taskId || !excludeTaskIds.has(taskId)) count++;
  }
  return count;
}

/** Test hook — drop every outstanding reservation. */
export function __resetLocalEndpointSpawnReservations() {
  pendingSpawnsByEndpoint.clear();
}

/**
 * Claim a local-endpoint spawn slot for `task`, or report why it must wait.
 *
 * This is the AUTHORITATIVE cap. The scheduler-side check in `dequeueNextTask` only avoids emitting a `task:ready`
 * that would be held anyway; other emitters (evaluateTasks, forceSpawnTask, cosJobScheduler, the Creative Director
 * bridge, ...) bypass it, so the gate lives where all funnel: subAgentSpawner's `task:ready` listener.
 *
 * `{ ok: true }` with a no-op release when the task has no local endpoint. Callers MUST invoke `release()` in a
 * `finally` once the spawn settles.
 *
 * @param {object} task
 * @param {object} agents - `state.agents`, the running-agent map
 * @returns {Promise<{ ok: true, release: () => void } | { ok: false, reason: string }>}
 */
export async function acquireLocalEndpointSpawnSlot(task, agents) {
  const slots = await buildLocalEndpointSlotContext();
  const endpoint = slots.resolveLocalEndpoint(task);
  if (!endpoint) return { ok: true, release: NOOP_RELEASE };

  const { atCapacity, inFlight, limit } = readEndpointCapacity(endpoint, agents, slots, { ignoreTaskId: task?.id });
  if (atCapacity) {
    return { ok: false, reason: `local endpoint ${endpoint} is at capacity (${inFlight}/${limit})` };
  }
  return { ok: true, release: reserveLocalEndpointSpawn(endpoint, task?.id ?? null) };
}

/**
 * Reserve the same local inference capacity for a non-agent provider call. Persistent-mind turns call the
 * text-provider interface directly but occupy the same model server, so they share this accounting rather than a
 * parallel GPU counter. Cloud providers return a no-op release.
 */
export async function acquireLocalEndpointProviderSlot(provider, agents, reservationId = null) {
  const endpoint = localEndpointOfProvider(provider);
  if (!endpoint) return { ok: true, release: NOOP_RELEASE };
  const slots = await buildLocalEndpointSlotContext();
  const { atCapacity, inFlight, limit } = readEndpointCapacity(endpoint, agents, slots);
  if (atCapacity) {
    return { ok: false, reason: `local endpoint ${endpoint} is at capacity (${inFlight}/${limit})` };
  }
  return { ok: true, release: reserveLocalEndpointSpawn(endpoint, reservationId) };
}

/**
 * Running agents plus in-flight reservations on `endpoint`, against the cap.
 *
 * `ignoreTaskId` excludes agents belonging to the task being dispatched: a task never competes with itself, and
 * counting its own agent would break the paths that re-dispatch one (`forceSpawnTask` superseding a stale
 * `running` zombie whose PTY died, and retries), which would be unreachable at a limit of 1.
 */
export function readEndpointCapacity(endpoint, agents, slots, { ignoreTaskId = null } = {}) {
  const runningTaskIds = new Set();
  let running = 0;
  for (const agent of Object.values(agents || {})) {
    if (agent.status !== 'running') continue;
    if (ignoreTaskId && agent.taskId === ignoreTaskId) continue;
    if (slots.endpointForAgent(agent) !== endpoint) continue;
    running++;
    if (agent.taskId) runningTaskIds.add(agent.taskId);
  }
  const inFlight = running + pendingLocalEndpointSpawns(endpoint, { excludeTaskIds: runningTaskIds });
  return { inFlight, limit: slots.limit, atCapacity: inFlight >= slots.limit };
}

/**
 * Why a spawn on the ALREADY-RESOLVED `provider` must wait, or null when it may proceed.
 *
 * `forceSpawnTask` (the user's "Run now") returns synchronously while the spawn happens later in a `task:ready`
 * listener, so without this it would toast "Spawning" for a dispatch the chokepoint immediately holds. Takes the
 * post-fallback provider, so it is more accurate than the queued-task prediction in `resolveLocalEndpoint`.
 */
export async function localEndpointCapacityError(provider, agents, taskId = null) {
  const endpoint = localEndpointOfProvider(provider);
  if (!endpoint) return null;
  const slots = await buildLocalEndpointSlotContext();
  const { atCapacity, inFlight, limit } = readEndpointCapacity(endpoint, agents, slots, { ignoreTaskId: taskId });
  if (!atCapacity) return null;
  return `Local inference endpoint ${endpoint} is at capacity (${inFlight}/${limit}) — wait for a running agent to finish`;
}
