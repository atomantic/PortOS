/**
 * Caller EXECUTION-MODE policy — the one place that answers "may THIS caller
 * run on THAT provider record's execution mode?" (#6368).
 *
 * A provider record's `type` (`cli` / `tui` / `api`) is its executable route
 * mode, and callers are not interchangeable across them: a CoS agent task needs
 * a file-writing harness, the standalone autofixer can only drive a headless
 * CLI, and a tool-free public-review stage must stay on a direct API provider
 * with no harness authority at all. Before this module each of those rules was
 * re-derived at its own call site — `provider.type === 'api'` here, a
 * `filter(p => p.type === 'cli')` there, an inline `selectionPolicy` in three
 * React components — so a rule applied at the pin was routinely missing from
 * the fallback chain that could silently replace that pin.
 *
 * The policy is deliberately NARROW. It answers mode + required model
 * capability only. It does NOT re-answer:
 *
 *   - `enabled` / benched status — owned by `providerStatus.getFallbackProvider`
 *     and the pickers, which already have the runtime state;
 *   - prerequisites (binary on PATH, credential stored) — owned by the host
 *     `prerequisitesMet` hook, which needs I/O this module must not do;
 *   - harness support and text-transport consent — owned by
 *     `routeModeEligibility` in `providerGraphPreview.js`, the declarative half
 *     of the same intersection.
 *
 * Keeping those separate is what lets this module stay pure and dependency-light
 * enough for the out-of-process autofixer to import, and keeps one concern from
 * quietly overriding another's reason string.
 *
 * **Unknown never becomes true.** A record whose `type` names no executable mode
 * is refused by every policy, and a required model capability with no positive
 * evidence is refused rather than assumed — an unknown capability is not a
 * satisfied one. That asymmetry is intentional: an over-permissive answer routes
 * untrusted content or file-writing authority somewhere the caller said it must
 * not go, while an over-strict one merely surfaces as "no eligible provider".
 */

/**
 * Executable route modes, mirroring a provider record's `type`.
 *
 * Declared here rather than imported from `providerHarnesses.js` / the toolkit
 * constants: this module is reached by the agent resolver, promptRunner and the
 * out-of-process autofixer, and a widely-reached module must not drag a subtree
 * it needs one three-string constant from (see "Import scoping" in
 * server/AGENTS.md). The browser derives its picker table from
 * `CALLER_MODE_POLICIES` directly (client/src/utils/providerSelection.js), so
 * there is no client copy to pin.
 */
export const EXECUTION_MODES = Object.freeze(['cli', 'tui', 'api']);

/** A record's executable route mode, or null when its `type` names none. */
const routeModeOf = (provider) => (EXECUTION_MODES.includes(provider?.type) ? provider.type : null);

const AGENT_HARNESS_MODES = Object.freeze(['cli', 'tui']);

/**
 * The named caller contexts PortOS routes for. A caller names one of these
 * instead of re-deriving a type test, so the rule applied to an explicit pin,
 * to `activeProvider` inheritance and to every fallback candidate is literally
 * the same object.
 *
 * `requiredModelCapabilities` is an opt-in map of `{ capability: true }`. No
 * shipped policy declares one — the tool-use signal PortOS publishes today is a
 * positive allowlist whose non-match means "unrecognized", not "incapable", so
 * turning it into a hard filter would hide working providers. A caller that has
 * PROVEN capability evidence can still declare one inline (see
 * {@link resolveCallerModePolicy}); it is then evaluated under the
 * unknown-is-not-true rule above.
 */
export const CALLER_MODE_POLICIES = Object.freeze({
  /** CoS agent tasks: needs a harness that can read/write files and run commands. */
  'agent-harness': Object.freeze({ allowedModes: AGENT_HARNESS_MODES, requiredModelCapabilities: Object.freeze({}) }),
  /** Headless one-shot CLI callers (autofixer, calendar MCP sync) — no PTY to drive a TUI. */
  'cli-harness': Object.freeze({ allowedModes: Object.freeze(['cli']), requiredModelCapabilities: Object.freeze({}) }),
  /** Direct HTTP providers only: no harness authority (tool-free review, screened analysis). */
  'direct-api': Object.freeze({ allowedModes: Object.freeze(['api']), requiredModelCapabilities: Object.freeze({}) }),
  /** Ordinary text generation — any executable mode. */
  'any-text': Object.freeze({ allowedModes: EXECUTION_MODES, requiredModelCapabilities: Object.freeze({}) }),
});

/** Policy names, for validation surfaces and tests. */
export const CALLER_MODE_POLICY_IDS = Object.freeze(Object.keys(CALLER_MODE_POLICIES));

const normalizedModes = (modes) => {
  const list = Array.isArray(modes) ? modes.filter((mode) => EXECUTION_MODES.includes(mode)) : [];
  return Object.freeze([...new Set(list)]);
};

const normalizedCapabilities = (raw) => {
  if (!raw || typeof raw !== 'object') return Object.freeze({});
  // Only a `true` requirement is meaningful. `false`/null would read as "this
  // caller requires the capability to be absent", which nothing asks for and
  // which an absent-evidence record could satisfy by accident.
  return Object.freeze(Object.fromEntries(
    Object.entries(raw).filter(([, required]) => required === true),
  ));
};

/**
 * Normalize any accepted policy spelling to `{ id, allowedModes,
 * requiredModelCapabilities }`.
 *
 * Accepts a registry name, a bare array of modes, or an inline
 * `{ allowedModes, requiredModelCapabilities }` object. An unregistered NAME
 * throws: it is a code-level typo, and the alternative — quietly resolving it to
 * a permissive default — is exactly the silent over-permission this module
 * exists to prevent. An inline spec that names no valid mode is also a hard
 * error rather than "allow everything".
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

/** The allowed-mode list for a policy — the value handed to fallback selection. */
export const allowedModesFor = (policy) => resolveCallerModePolicy(policy).allowedModes;

/**
 * Why this provider record may not serve `policy`, or null when it may.
 *
 * `modelCapabilities` is the caller's tri-state evidence for the model that
 * would actually run: `true` proven, `false` proven absent, missing/null
 * unknown. Only `true` satisfies a requirement.
 *
 * @param {object} provider — a provider record (its `type` is the route mode)
 * @param {string|readonly string[]|object} policy
 * @param {{modelCapabilities?: object}} [options]
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

/** Convenience boolean form of {@link callerModeRejection}. */
export const isCallerModeEligible = (provider, policy, options) =>
  callerModeRejection(provider, policy, options) === null;

/**
 * The subset of `providers` this caller may run on, in the input's own order.
 *
 * Order is preserved because every caller's own preference order (the provider
 * list order, a fallback priority list) is meaningful and must survive the
 * filter.
 */
export const filterCallerModeEligible = (providers, policy, options) =>
  (Array.isArray(providers) ? providers : []).filter((provider) => isCallerModeEligible(provider, policy, options));
