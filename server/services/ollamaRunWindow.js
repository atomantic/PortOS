/**
 * Per-run Ollama bookkeeping for API/prompt runs on the managed daemon: registers the run as
 * in-flight (so `ollamaManager.ensureContextWindow` waits instead of restarting under it) and
 * reconciles the per-model window with what the resident runner is actually serving.
 *
 * Why: the MLX runner keeps a loaded model at its original window and ignores a per-request
 * `num_ctx` (#17338), so a run budgeting against a larger configured window would be silently
 * served smaller. Idle -> unload so the next request loads at the configured window; busy -> budget
 * against the resident window.
 */

import { isOllamaBackedProvider, ollamaBaseFromProvider, withModelNumCtx } from '../lib/aiToolkit/internal/ollamaBacked.js'
import { isSameOllamaDaemon } from '../lib/ollamaContext.js'
import {
  beginOllamaWork,
  getBaseUrl,
  getInFlightOllamaWorkCount,
  getResidentModelContext,
  unloadModel
} from './ollamaManager.js'

const noop = () => {}

/**
 * @param {object} provider
 * @param {string|null} model
 * @returns {Promise<{ provider: object, release: () => void }>} release must be called when the run settles
 */
export async function beginOllamaRun(provider, model) {
  if (!provider || !isOllamaBackedProvider(provider)) return { provider, release: noop }
  if (!isSameOllamaDaemon(ollamaBaseFromProvider(provider), getBaseUrl())) return { provider, release: noop }

  const release = beginOllamaWork()
  const target = Number(withModelNumCtx(provider, model)?.numCtx)
  if (!model || !(target > 0)) return { provider, release }

  const resident = await getResidentModelContext(model).catch(() => null)
  if (resident == null || resident >= target) return { provider, release }

  if (getInFlightOllamaWorkCount() <= 1) {
    const result = await unloadModel(model).catch(() => ({ unloaded: false }))
    if (result.unloaded) {
      console.log(`🪟 ${model} was resident at ${resident} tokens; unloaded so it reloads at ${target}`)
      return { provider, release }
    }
  }
  console.log(`🪟 ${model} is serving ${resident} tokens (configured ${target}) and busy — budgeting against ${resident}`)
  return {
    provider: { ...provider, numCtx: resident, modelNumCtx: { ...provider.modelNumCtx, [model]: resident } },
    release
  }
}
