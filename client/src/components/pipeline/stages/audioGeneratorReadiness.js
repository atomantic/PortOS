export function generatorUnavailableReason(engine, modelId = engine?.defaultModelId) {
  if (!engine) return 'unknown-engine';
  const byModel = engine.unavailableReasonByModelId;
  if (byModel && Object.hasOwn(byModel, modelId)) return byModel[modelId];
  // Older generator endpoints used ready only for runtime health.
  return engine.unavailableReason ?? (engine.ready ? null : 'runtime-unavailable');
}
