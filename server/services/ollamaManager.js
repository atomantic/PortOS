/** Public service interface for PortOS's native Ollama integration. */

export {
  beginOllamaWork,
  beginOllamaWorkAfterReload,
  CONTEXT_RELOAD_DRAIN_TIMEOUT_MS,
  ensureContextWindow,
  getInFlightOllamaWorkCount,
  getResidentModelContext,
  getRuntimeContextLength,
  waitForOllamaDrain,
} from './ollama/ollamaContextWindow.js'
export {
  checkOllamaAvailable,
  ensureProviderReady,
  ensureRunning,
  getBaseUrl,
  getVersion,
  isOllamaProvider,
  restartWithEnv,
  startPersistentService,
  startServer,
  stopPersistentService,
  stopServer,
} from './ollama/ollamaDaemon.js'
export { getModelsDir, manifestPathFor } from './ollama/ollamaHuggingFaceImport.js'
export { bustInstalledModelsCache } from './ollama/ollamaModelCache.js'
export {
  deleteModel,
  getEmbeddings,
  getInstalledModels,
  getLastInstalledModelsError,
  getLastLoadedModelsError,
  getLoadedModels,
  getLoadedModelsAt,
  getModelCapabilities,
  getModelLayout,
  getStatus,
  unloadModel,
  warmModel,
} from './ollama/ollamaModels.js'
export { pullModel, streamNdjson } from './ollama/ollamaPull.js'
