/** Resolve the configured commission selection against live capabilities before creating a project. */
import { listMusicEngineCapabilities, musicEngineReadinessReason } from './musicEngineCapabilities.js';

export async function resolveMusicEngineSelection({ engineId, modelId } = {}) {
  const catalog = await listMusicEngineCapabilities();
  const selectedEngineId = engineId || catalog.defaultEngine;
  const engine = catalog.engines.find((entry) => entry.id === selectedEngineId);
  if (!engine) {
    return { status: 'unavailable', reason: 'music-engine-unavailable' };
  }
  const selectedModelId = modelId || engine.defaultModelId;
  const model = engine.models.find((entry) => entry.id === selectedModelId);
  const modelReady = !!model && (!engine.fixedModelInstall || engine.modelReadyById?.[model.id] === true);
  const reason = musicEngineReadinessReason(engine, modelReady);
  if (reason) {
    return {
      status: 'unavailable',
      reason: reason === 'model-unavailable' ? 'music-model-unavailable' : 'music-engine-unavailable',
    };
  }
  return {
    status: 'ready',
    selection: {
      engine: engine.id,
      modelId: model.id,
      repo: model.repo,
    },
  };
}
