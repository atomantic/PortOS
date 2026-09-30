/**
 * The Codex model ids PortOS ships in its provider presets. A LEAF module so
 * both the preset migration (`providerServiceState.js`) and the catalog probe
 * (`codexModelListProbe.js`) share one list.
 *
 * The installed Codex CLI's `model/list` lags what the account can actually
 * use (a model can be selectable before the CLI's bundled catalog names it),
 * so a refresh that REPLACED the stored list with the probe's answer silently
 * dropped every shipped model the CLI did not yet list.
 */
export const CODEX_SHIPPED_MODELS = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
];

/** The CLI's own ids first (its ordering), then shipped ids it did not list. */
export function withCodexShippedModels(listed) {
  return [...new Set([...listed, ...CODEX_SHIPPED_MODELS])];
}
