/**
 * Which provider/model a scheduled app task actually spawns its agent on.
 *
 * Two pins can name one: the task's global Schedule pin, and the app's own
 * per-app override (`taskTypeOverrides[<taskType>].providerId` / `.model`). The
 * per-app pin is the more specific choice, so it wins — for EVERY task type
 * (#4783), not only the one whose `buildTaskInput` hook happened to read it.
 *
 * The constraint both pins answer to is the HARNESS BOUNDARY: an `api`-type
 * provider (Ollama / LM Studio / kimi over HTTP) returns plain text with no
 * file-writing tool harness, so a CoS agent task pinned to one can never do the
 * work. `agentProviderResolution` already refuses such a task at spawn, but by
 * then the run is a permanent failure the user has to notice and clear — and for
 * layered-intelligence (whose per-app pin migration 184 populated verbatim,
 * ollama entries included) it wedged the task instead. Catching it HERE lets an
 * api-typed per-app pin fall back to the task's Schedule pin, which is the
 * self-heal LI shipped, generalized: every task type spawns an agent that needs a
 * harness, so the constraint was never LI's.
 *
 * The walk, in one place so the generic generator path and LI's hook cannot drift:
 *
 *   per-app pin → (api-typed? adopt the Schedule pin instead) → Schedule pin →
 *   the install's default coding agent
 */

const NOT_AGENT_CAPABLE = 'provider-not-agent-capable';

/**
 * Resolve the agent provider/model pin for one app + task type.
 *
 * @param {object}   args
 * @param {object}   [args.appPin]         `{ providerId, model }` the app pinned for this task type.
 * @param {function} args.readSchedulePin  Async thunk returning the task's global Schedule pin
 *   (`{ providerId, model }`). A THUNK, not a value, so a per-app pin that already resolves
 *   never pays for the read; it is invoked at most once per call.
 * @param {string}   args.taskType         Task type, for the harness-fallback log line.
 * @param {string}   args.appName          App name, for the same log line.
 * @param {function} [args.getProviderType] Injectable `(id) => Promise<type|null>` seam for tests.
 * @returns {Promise<{ providerId: string|null, model: string|null, healedFrom: string|null, skipReason: string|null }>}
 *   `skipReason` is `'provider-not-agent-capable'` when NOTHING resolvable has a harness. Callers
 *   that can decline to generate (LI) gate on it; the generic path leaves the Schedule pin alone so
 *   `agentProviderResolution` reports its actionable permanent error rather than silently rerouting
 *   the run onto a provider the user never chose.
 */
export async function resolveAgentProviderPin({ appPin, readSchedulePin, taskType, appName, getProviderType } = {}) {
  const typeOf = getProviderType || (async (id) => {
    const { getProviderById } = await import('./providers.js');
    const provider = await getProviderById(id).catch(() => null);
    return provider?.type ?? null;
  });
  const providerTypeOf = async (id) => (id ? typeOf(id) : null);

  // Read the Schedule pin at most once, and only when a branch below needs it.
  let schedulePinPromise = null;
  const schedulePin = () => {
    if (!schedulePinPromise) schedulePinPromise = Promise.resolve(readSchedulePin()).catch(() => null);
    return schedulePinPromise;
  };

  let providerId = appPin?.providerId || null;
  let model = appPin?.model ?? null;
  let type = await providerTypeOf(providerId);
  let healedFrom = null;

  if (type === 'api') {
    const pin = await schedulePin();
    const pinId = pin?.providerId || null;
    const pinType = await providerTypeOf(pinId);
    // Adopt the Schedule pin only when it RESOLVES to a real non-api provider.
    // `pinType` is null for an unresolvable id (deleted / renamed / typo'd pin) —
    // treating that as "not api" would re-wedge the task on a doomed provider
    // under a misleading "healed" line, so require a positively-known type.
    if (pinId && pinType && pinType !== 'api') {
      healedFrom = providerId;
      providerId = pinId;
      // Adopt the pin's model too — provider+model are a matched pair the user set
      // together, and an api provider's model name may not be valid for a CLI/TUI one.
      model = pin?.model ?? null;
      type = pinType;
    }
  } else if (!providerId) {
    // No per-app provider → the Schedule pin IS the resolved choice; resolving it
    // here (rather than leaving that leg to the caller) keeps this the single
    // source of truth for what the agent runs on. No pin at all leaves
    // `providerId` null, which inherits the install's default coding agent.
    const pin = await schedulePin();
    const pinId = pin?.providerId || null;
    if (pinId) {
      providerId = pinId;
      type = await providerTypeOf(pinId);
      // Keep an explicit per-app model when the user set one (a model pinned
      // without a provider); only fall back to the pin's model when there is none.
      model = appPin?.model ?? pin?.model ?? null;
    }
  }

  if (healedFrom) {
    console.warn(`⚠️ ${taskType}: ${appName} per-app provider '${healedFrom}' is API-only (no coding harness) — using the task provider '${providerId}' instead`);
  }

  return { providerId, model, healedFrom, skipReason: type === 'api' ? NOT_AGENT_CAPABLE : null };
}

export { NOT_AGENT_CAPABLE };
