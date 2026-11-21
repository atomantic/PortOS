/**
 * One authoritative view of the music engines this install can actually run.
 *
 * Shared by the Music UI, pipeline audio stage, commissions and federation.
 * Keeping runtime, platform, fixed-model, and CUDA readiness in one place is
 * important: a provider must never advertise work that the local UI would
 * correctly reject, especially when CUDA probing returned `unknown`.
 */

import { inspectModelCache } from '../lib/hfCache.js';
import { getCudaCapability } from '../lib/cudaCapability.js';
import { musicEngineReadinessReason } from '../lib/generationModes.js';
import {
  ENGINES,
  DEFAULT_ENGINE_ID,
  getEngineModel,
  isEngineHealthy,
  isEnginePlatformSupported,
  enginePlatformLabel,
  resolveEngineVramReadiness,
} from './pipeline/musicGen.js';
import { listEngineModels } from './audioModels.js';

export { musicEngineReadinessReason };

export async function listMusicEngineCapabilities() {
  const cuda = await getCudaCapability();
  const engines = await Promise.all(Object.values(ENGINES).map(async (engine) => {
    const fixedModels = engine.fixedModelInstall ? engine.models : [];
    const modelReadyById = engine.fixedModelInstall
      ? Object.fromEntries(await Promise.all(fixedModels.map(async (model) => [
        model.id,
        (await inspectModelCache(model.repo, { revision: model.revision }).catch(() => ({ cached: false }))).cached === true,
      ])))
      : null;
    // Preserve the aggregate for older clients, while newer consumers gate
    // the exact selected checkpoint through modelReadyById.
    const modelReady = modelReadyById ? Object.values(modelReadyById).some(Boolean) : true;
    const fixedModel = engine.fixedModelInstall
      ? getEngineModel(engine.id, engine.defaultModelId)
      : null;
    const modelSizeGbById = engine.fixedModelInstall
      ? Object.fromEntries(fixedModels.map((model) => [model.id, model.downloadSizeGb ?? null]))
      : null;
    const runtimeReady = await isEngineHealthy(engine.id);
    const cudaState = engine.cudaRequired ? cuda.status : 'available';
    const vram = resolveEngineVramReadiness(engine.id, cuda);

    const capabilities = {
      id: engine.id,
      name: engine.name,
      models: await listEngineModels(engine.id),
      defaultModelId: engine.defaultModelId,
      minDurationSec: engine.minDurationSec,
      maxDurationSec: engine.maxDurationSec,
      defaultDurationSec: engine.defaultDurationSec,
      lyrics: engine.lyrics === true,
      autoDuration: engine.autoDuration === true,
      customModels: engine.customModels === true,
      fixedModelInstall: engine.fixedModelInstall === true,
      modelReady,
      ...(modelReadyById ? { modelReadyById } : {}),
      modelSizeGb: fixedModel?.downloadSizeGb ?? null,
      ...(modelSizeGbById ? { modelSizeGbById } : {}),
      runtimeReady,
      cudaRequired: engine.cudaRequired === true,
      platformSupported: isEnginePlatformSupported(engine.id),
      platformLabel: enginePlatformLabel(engine.id),
      cudaState,
      executionProfile: vram.executionProfile,
      vramState: vram.state,
      vramProfileLabel: vram.profileLabel,
      minVramGb: vram.minVramGb,
      recommendedVramGb: vram.recommendedVramGb,
      maxVramGb: vram.maxVramGb,
      installEnv: engine.installEnv,
      venvDefault: engine.venvDefault,
    };
    return { ...capabilities, ready: musicEngineReadinessReason(capabilities, modelReady) === null };
  }));

  return { engines, defaultEngine: DEFAULT_ENGINE_ID };
}
