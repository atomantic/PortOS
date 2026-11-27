/** Caches the Ollama installed-model list and the errors from installed and resident model probes. */

// null = not yet fetched; cache even an empty list so catalog filtering
// does not hit /api/tags on every keystroke. An error records why that list
// or the residency list could not be read, for callers that need to tell
// a failed read from a genuinely empty backend.
export const modelListCache = {
  installedModels: null,
  lastLoadedModelsError: null,
  lastInstalledModelsError: null,
}

// Drop /api/tags after an install or delete changes the model inventory.
export function bustInstalledModelsCache() {
  modelListCache.installedModels = null
}

// The two list observations belong to the daemon that answered the probes.
export function resetModelListCache() {
  bustInstalledModelsCache()
  modelListCache.lastLoadedModelsError = null
  modelListCache.lastInstalledModelsError = null
}
