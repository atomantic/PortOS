/**
 * Per-run generation controls a task may pin on top of its provider record.
 *
 * A task form or schedule entry can carry `temperature`, `thinking` and
 * `effort` for ONE dispatch. They are layered onto a copy of the provider here
 * rather than written back to it: the saved record is shared by every other
 * run, and the child-environment composer turns the copy into OpenCode's
 * dynamic `agent.build` config downstream.
 *
 * Every value arrives untrusted — a COS-TASKS.md round-trip hands back strings,
 * and the task form can submit an empty field — so each override applies only
 * when it validates, and an invalid one leaves the provider's own setting
 * alone rather than overwriting it with `NaN`/`undefined`.
 */

/** `thinking` values a provider record accepts, string forms included. */
const THINKING_VALUES = [true, false, 'true', 'false'];

/** The inclusive sampling-temperature range a provider record accepts. */
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;

/**
 * `provider` with this task's valid generation overrides layered on top.
 *
 * An empty temperature field is treated as absent, not as 0 — `Number('')` is
 * 0, which would silently pin greedy decoding on a task whose author only
 * cleared the box.
 */
export function applyTaskGenerationOverrides(provider, metadata) {
  const temperature = metadata?.temperature === '' ? NaN : Number(metadata?.temperature);
  const thinking = metadata?.thinking;
  return {
    ...provider,
    ...(Number.isFinite(temperature) && temperature >= MIN_TEMPERATURE && temperature <= MAX_TEMPERATURE
      ? { temperature }
      : {}),
    ...(THINKING_VALUES.includes(thinking) ? { thinking } : {}),
    ...(typeof metadata?.effort === 'string' ? { effort: metadata.effort } : {}),
  };
}
