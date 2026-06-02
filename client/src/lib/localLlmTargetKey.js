// Stable string key for a local-LLM compare target (a `{ backend, modelId }`
// pair). The LocalLlmTab checkbox grid and the LocalLlmPlayground compare URL
// must agree on this exact delimiter, or a model selected in Settings won't
// match the one decoded from the playground's `?targets=` param. Centralizing
// the key here means a delimiter change can't desync the two sides.
export function localLlmTargetKey({ backend, modelId }) {
  return `${backend}\n${modelId}`;
}
