/**
 * Caller EXECUTION-MODE policy — the one place that answers "may THIS caller
 * run on THAT provider record's execution mode?" (#6368).
 *
 * A provider's `type` (`cli` / `tui` / `api`) is its route mode: a CoS agent needs a
 * file-writing harness, the autofixer a headless CLI, a tool-free public-review stage a
 * direct API provider. Narrow on purpose (mode + required model capability); not
 * re-answered here: benched status (`providerStatus`), prerequisites (needs I/O) and
 * harness/consent (`routeModeEligibility` in `providerGraphPreview.js`). That keeps it
 * pure enough for the out-of-process autofixer to import.
 *
 * **Unknown never becomes true.** A `type` naming no mode, or a required capability
 * without positive evidence, is refused: over-permissive would route untrusted content or
 * file-writing authority where forbidden; over-strict only yields "no eligible provider".
 */

/**
 * Executable route modes, mirroring a provider record's `type`. Declared here, not
 * imported from `providerHarnesses.js`, so this widely-reached module drags in no
 * subtree (see "Import scoping" in server/AGENTS.md).
 */
export const EXECUTION_MODES = Object.freeze(['cli', 'tui', 'api']);

const routeModeOf = (provider) => (EXECUTION_MODES.includes(provider?.type) ? provider.type : null);

const AGENT_HARNESS_MODES = Object.freeze(['cli', 'tui']);

/**
 * Named caller contexts; pins, inheritance and fallbacks share the same object.
 * `requiredModelCapabilities` (opt-in `{ capability: true }`) is empty in every shipped
 * policy because the tool-use signal's non-match means "unrecognized", not "incapable".
 */
export const CALLER_MODE_POLICIES = Object.freeze({
  'agent-harness': Object.freeze({ allowedModes: AGENT_HARNESS_MODES, requiredModelCapabilities: Object.freeze({}) }),
  /** Headless one-shot CLI callers: no PTY to drive a TUI. */
  'cli-harness': Object.freeze({ allowedModes: Object.freeze(['cli']), requiredModelCapabilities: Object.freeze({}) }),
  /** Direct HTTP providers only: no harness authority. */
  'direct-api': Object.freeze({ allowedModes: Object.freeze(['api']), requiredModelCapabilities: Object.freeze({}) }),
  'any-text': Object.freeze({ allowedModes: EXECUTION_MODES, requiredModelCapabilities: Object.freeze({}) }),
});

export const CALLER_MODE_POLICY_IDS = Object.freeze(Object.keys(CALLER_MODE_POLICIES));

const normalizedModes = (modes) => {
  const list = Array.isArray(modes) ? modes.filter((mode) => EXECUTION_MODES.includes(mode)) : [];
  return Object.freeze([...new Set(list)]);
};

const normalizedCapabilities = (raw) => {
  if (!raw || typeof raw !== 'object') return Object.freeze({});
  // Only `true` is meaningful; `false`/null would read as "requires absence".
  return Object.freeze(Object.fromEntries(
    Object.entries(raw).filter(([, required]) => required === true),
  ));
};

/**
 * Normalize any accepted policy spelling to `{ id, allowedModes,
 * requiredModelCapabilities }`.
 *
 * Accepts a registry name, a bare mode array, or an inline spec. An unregistered NAME
 * or an inline spec with no valid mode throws rather than resolving to a permissive default.
 *
 * @param {string|readonly string[]|{allowedModes?: readonly string[], requiredModelCapabilities?: object}} policy
 * @returns {{id: string|null, allowedModes: readonly string[], requiredModelCapabilities: Readonly<object>}}
 */
export function resolveCallerModePolicy(policy) {
  if (typeof policy === 'string') {
    const found = CALLER_MODE_POLICIES[policy];
    if (!found) throw new Error(`Unknown caller mode policy: ${policy}`);
    return { id: policy, ...found };
  }
  const spec = Array.isArray(policy) ? { allowedModes: policy } : policy;
  if (!spec || typeof spec !== 'object') throw new Error('Caller mode policy must be a policy name, a mode array, or a policy object');
  const allowedModes = normalizedModes(spec.allowedModes);
  if (allowedModes.length === 0) throw new Error('Caller mode policy must allow at least one of: ' + EXECUTION_MODES.join(', '));
  return { id: null, allowedModes, requiredModelCapabilities: normalizedCapabilities(spec.requiredModelCapabilities) };
}

export const allowedModesFor = (policy) => resolveCallerModePolicy(policy).allowedModes;

/**
 * Why this provider may not serve `policy`, or null. `modelCapabilities` is tri-state
 * evidence (`true` proven, `false` absent, missing/null unknown); only `true` satisfies.
 *
 * @returns {{code: string, reason: string}|null}
 */
export function callerModeRejection(provider, policy, { modelCapabilities = null } = {}) {
  const { allowedModes, requiredModelCapabilities } = resolveCallerModePolicy(policy);
  const mode = routeModeOf(provider);
  if (!mode) return { code: 'mode-unknown', reason: `has no executable mode (type: ${provider?.type ?? 'none'})` };
  if (!allowedModes.includes(mode)) {
    return { code: 'mode-not-allowed', reason: `runs in ${mode} mode; this caller allows ${allowedModes.join('/')}` };
  }
  for (const capability of Object.keys(requiredModelCapabilities)) {
    if (modelCapabilities?.[capability] !== true) {
      return { code: `capability-${capability}`, reason: `model capability "${capability}" is not proven for this route` };
    }
  }
  return null;
}

export const isCallerModeEligible = (provider, policy, options) =>
  callerModeRejection(provider, policy, options) === null;

/** The subset of `providers` this caller may run on; input order (a preference order) is preserved. */
export const filterCallerModeEligible = (providers, policy, options) =>
  (Array.isArray(providers) ? providers : []).filter((provider) => isCallerModeEligible(provider, policy, options));
