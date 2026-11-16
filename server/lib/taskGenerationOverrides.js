/**
 * `applyTaskGenerationOverrides(provider, metadata)` layers a run's temperature, thinking and effort
 * overrides onto a copy of the provider record.
 */

import { resolveExecutionOptions } from './executionOptions.js';
/**
 * Per-run generation controls a task may pin on top of its provider record: `temperature`, `thinking` and `effort` for ONE dispatch, layered onto a copy of the provider (the saved record is shared by every other run; the child-environment composer turns the copy into OpenCode's dynamic `agent.build` config).
 * Every value arrives untrusted (a COS-TASKS.md round-trip returns strings; the form can submit an empty field), so each override applies only when it validates, and an invalid one leaves the provider's setting alone rather than writing `NaN`/`undefined`.
 */

/** `thinking` values a provider record accepts, string forms included. */
const THINKING_VALUES = [true, false, 'true', 'false'];

/** The inclusive sampling-temperature range a provider record accepts. */
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;

/** `provider` with this task's valid generation overrides layered on. An empty temperature field is absent, not 0 (`Number('')` is 0, which would silently pin greedy decoding for a task whose author only cleared the box); a blank effort inherits the provider's saved default. */
export function applyTaskGenerationOverrides(provider, metadata) {
  const temperature = metadata?.temperature === '' ? NaN : Number(metadata?.temperature);
  const thinking = metadata?.thinking;
  const overridden = {
    ...provider,
    ...((provider.executionOptions || metadata?.executionOptions) ? { executionOptions: resolveExecutionOptions(
      { source: 'provider', options: provider.executionOptions },
      { source: 'task', options: metadata?.executionOptions },
    ).requested } : {}),
    ...(Number.isFinite(temperature) && temperature >= MIN_TEMPERATURE && temperature <= MAX_TEMPERATURE
      ? { temperature }
      : {}),
    ...(THINKING_VALUES.includes(thinking) ? { thinking } : {}),
    ...(typeof metadata?.effort === 'string' && metadata.effort.trim()
      ? { effort: metadata.effort.trim() }
      : {}),
  };

  // Gateway-backed providers carry their inherited API key as a
  // non-enumerable, execution-only property. The spread above deliberately
  // omits it so the credential cannot be persisted or serialized, but this
  // copy is about to be executed for this run and still needs the key. Without
  // carrying it forward, NVIDIA NIM/OpenRouter/OpenCode runs reach the gateway
  // without Authorization after any task passes through this helper.
  const apiKeyDescriptor = provider && typeof provider === 'object'
    ? Object.getOwnPropertyDescriptor(provider, 'apiKey')
    : null;
  if (apiKeyDescriptor && !apiKeyDescriptor.enumerable) {
    Object.defineProperty(overridden, 'apiKey', {
      ...apiKeyDescriptor,
      configurable: true,
    });
  }

  return overridden;
}
