/** Bounded, versioned execution settings; never interpreted as arbitrary argv. */
export const EXECUTION_OPTIONS_VERSION = 1;
export const EXECUTION_OPTIONS_ERROR = 'EXECUTION_OPTIONS_UNSUPPORTED';
const CODEX_SPEED_PROBE_FAILURE_MESSAGES = Object.freeze({
  launch: 'The Codex speed probe could not start. Check the configured Codex executable and its permissions, then refresh capabilities.',
  timeout: 'The Codex speed probe did not respond before its deadline. Retry capability inspection and check that Codex app-server responds.',
  required_rpc: 'Codex app-server did not provide a required speed capability RPC response. Update Codex to a compatible version, then refresh capabilities.',
  early_exit: 'Codex app-server exited before returning speed capabilities. Check that the configured Codex runtime starts successfully.',
  invalid_response: 'Codex app-server returned an unusable speed capability response. Refresh capabilities after updating Codex.',
  unknown: 'This runtime could not verify speed capabilities. Refresh capabilities or update Codex.',
});
export const CODEX_SPEED_PROBE_FAILURES = Object.freeze(Object.keys(CODEX_SPEED_PROBE_FAILURE_MESSAGES));

export function codexSpeedProbeFailureMessage(category) {
  return typeof category === 'string' && Object.hasOwn(CODEX_SPEED_PROBE_FAILURE_MESSAGES, category)
    ? CODEX_SPEED_PROBE_FAILURE_MESSAGES[category] : undefined;
}

export function executionOptionsError(message, probeFailure) {
  return Object.assign(new Error(message), { code: EXECUTION_OPTIONS_ERROR, status: 400 },
    codexSpeedProbeFailureMessage(probeFailure) ? { probeFailure } : {});
}
export const EXECUTION_OPTION_DEFINITIONS = Object.freeze({
  serviceTier: Object.freeze({
    key: 'serviceTier', type: 'enum', label: 'Speed', harnesses: ['codex', 'grok'],
    values: ['standard', 'fast'], default: null, inheritance: 'per-key',
    help: 'Fast may consume more subscription usage or credits. Saved schedules use this choice on future runs; it does not enable or reschedule a job. Availability depends on the model and account.',
  }),
});

export function validateExecutionOptions(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw executionOptionsError('executionOptions must be an object');
  const result = {};
  for (const [key, setting] of Object.entries(value)) {
    const definition = EXECUTION_OPTION_DEFINITIONS[key];
    if (!Object.hasOwn(EXECUTION_OPTION_DEFINITIONS, key) || !definition.values.includes(setting)) {
      throw executionOptionsError(`Unsupported execution option: ${key}`);
    }
    result[key] = setting;
  }
  return result;
}

/** Unset inherits; an explicit Standard overrides an inherited Fast. */
export function resolveExecutionOptions(...layers) {
  const requested = {};
  const provenance = {};
  for (const { source, options } of layers) {
    for (const [key, value] of Object.entries(validateExecutionOptions(options))) {
      requested[key] = value;
      provenance[key] = source;
    }
  }
  return { version: EXECUTION_OPTIONS_VERSION, requested, effective: {}, provenance,
    confirmation: Object.keys(requested).length ? 'requested/unconfirmed' : 'default/unconfirmed' };
}

/** Resume preserves explicit task/run overrides without pinning inherited defaults. */
export function taskExecutionOptions(value) {
  if (value?.version !== EXECUTION_OPTIONS_VERSION) return value == null ? undefined : validateExecutionOptions(value);
  return Object.fromEntries(Object.entries(value.requested || {}).filter(([key]) => ['task', 'run'].includes(value.provenance?.[key])));
}
