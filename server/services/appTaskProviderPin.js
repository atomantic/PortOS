/**
 * Which provider/model a scheduled app task actually spawns its agent on.
 *
 * The global Schedule pin and the app's per-app override
 * (`taskTypeOverrides[<taskType>].providerId` / `.model`) can both name one; the
 * more specific per-app pin wins, for EVERY task type (#4783).
 *
 * HARNESS BOUNDARY: an `api`-type provider has no file-writing tool harness, so a
 * task pinned to one can never do the work; catching it HERE (rather than at
 * spawn, a permanent failure) lets an api-typed per-app pin fall back to the
 * Schedule pin. The walk, in one place so the generator path and LI's hook agree:
 *
 *   per-app pin → (api-typed? adopt the Schedule pin instead) → Schedule pin →
 *   the install's default coding agent
 *
 * NOT expressed on `lib/llmRoutePin.js` (#4793): its rules are synchronous and
 * decide on pin VALUES; this walk is async, decides on resolved TYPE, reads the
 * Schedule pin as a lazy thunk at most once, and uses `??` so an explicitly-blank
 * per-app model stays blank.
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
 *   `skipReason` is `'provider-not-agent-capable'` when NOTHING resolvable has a harness. LI gates
 *   on it; the generic path leaves the Schedule pin alone so `agentProviderResolution` reports its
 *   error rather than silently rerouting onto a provider the user never chose.
 */
export async function resolveAgentProviderPin({ appPin, readSchedulePin, taskType, appName, getProviderType } = {}) {
  const typeOf = getProviderType || (async (id) => {
    const { getProviderById } = await import('./providers.js');
    const provider = await getProviderById(id).catch(() => null);
    return provider?.type ?? null;
  });
  const providerTypeOf = async (id) => (id ? typeOf(id) : null);

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
    // Require a positively-known type: `pinType` is null for an unresolvable id,
    // and treating that as "not api" would re-wedge the task on a doomed provider.
    if (pinId && pinType && pinType !== 'api') {
      healedFrom = providerId;
      providerId = pinId;
      // Provider+model are a matched pair; an api model name may not suit a CLI/TUI provider.
      model = pin?.model ?? null;
      type = pinType;
    }
  } else if (!providerId) {
    // No per-app provider → the Schedule pin IS the resolved choice. No pin at all
    // leaves `providerId` null, inheriting the install's default coding agent.
    const pin = await schedulePin();
    const pinId = pin?.providerId || null;
    if (pinId) {
      providerId = pinId;
      type = await providerTypeOf(pinId);
      // An explicit per-app model (pinned without a provider) wins over the pin's.
      model = appPin?.model ?? pin?.model ?? null;
    }
  }

  if (healedFrom) {
    console.warn(`⚠️ ${taskType}: ${appName} per-app provider '${healedFrom}' is API-only (no coding harness) — using the task provider '${providerId}' instead`);
  }

  return { providerId, model, healedFrom, skipReason: type === 'api' ? NOT_AGENT_CAPABLE : null };
}

export { NOT_AGENT_CAPABLE };
