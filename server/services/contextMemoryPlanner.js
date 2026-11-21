/**
 * Context-window plans for installed Ollama models, and the per-model window PortOS picks at install time.
 *
 * Reads each model's layout from the daemon (`/api/show`), sizes the KV cache
 * at every window step under the daemon's cache type, and recommends the
 * largest window that fits this host beside the weights (lib/contextMemoryPlan.js).
 * An MLX build reports no layout, but its runner grows the cache as the
 * context fills instead of reserving it at load, so its native maximum is safe
 * to request and is what it recommends.
 */
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  effectiveKvCacheType,
  kvLayoutFromModelInfo,
  modelMemoryBudgetBytes,
  nativeContextFromModelInfo,
  planContextWindow,
} from '../lib/contextMemoryPlan.js'
import { detectSystemCapabilities } from '../lib/systemCapabilities.js'
import * as ollamaManager from './ollamaManager.js'

// Homebrew's service plists carry the daemon env when Ollama runs as a brew service.
const BREW_PLISTS = ['Library/LaunchAgents/homebrew.mxcl.ollama.plist', 'Library/LaunchAgents/sh.brew.ollama.plist']

const plistValue = (xml, key) => {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))
  return match ? match[1] : undefined
}

/**
 * The KV cache type the daemon runs with: this process's env (which PortOS
 * hands a daemon it launches), else a Homebrew service plist, else f16.
 * Returns where it came from so the UI can say when it is assumed.
 *
 * @returns {Promise<{ cacheType: string, source: 'env'|'brew-service'|'default' }>}
 */
export async function resolveDaemonKvCacheType({ env = process.env, home = homedir(), read = readFile } = {}) {
  if (env.OLLAMA_KV_CACHE_TYPE) {
    return { cacheType: effectiveKvCacheType(env.OLLAMA_KV_CACHE_TYPE, env.OLLAMA_FLASH_ATTENTION), source: 'env' }
  }
  if (process.platform === 'darwin') {
    for (const rel of BREW_PLISTS) {
      const xml = await read(join(home, rel), 'utf8').catch(() => null)
      const type = xml && plistValue(xml, 'OLLAMA_KV_CACHE_TYPE')
      if (type) return { cacheType: effectiveKvCacheType(type, plistValue(xml, 'OLLAMA_FLASH_ATTENTION')), source: 'brew-service' }
    }
  }
  return { cacheType: 'f16', source: 'default' }
}

/**
 * One model's plan: the table of window steps with KV and total bytes and
 * whether each fits, plus the recommended window.
 *
 * @param {{ id: string, size?: number|null }} model — an installed Ollama model row
 * @param {{ cacheType: string, budgetBytes: number|null }} host
 */
export async function planModelContext(model, { cacheType, budgetBytes }) {
  const { modelInfo, runner } = await ollamaManager.getModelLayout(model.id)
  const nativeContext = nativeContextFromModelInfo(modelInfo)
  const plan = planContextWindow({
    layout: kvLayoutFromModelInfo(modelInfo),
    nativeContext,
    weightsBytes: model.size,
    budgetBytes,
    cacheType,
  })
  const lazyCache = runner === 'mlx'
  return {
    modelId: model.id,
    runner,
    lazyCache,
    ...plan,
    recommended: plan.recommended ?? (lazyCache ? nativeContext : null),
  }
}

/** Host facts every plan shares: the memory budget and the daemon's cache type. */
export async function resolveContextPlanHost() {
  const [capabilities, kv] = await Promise.all([detectSystemCapabilities().catch(() => null), resolveDaemonKvCacheType()])
  return { budgetBytes: modelMemoryBudgetBytes(capabilities), cacheType: kv.cacheType, cacheTypeSource: kv.source }
}

/**
 * Plans for every installed model on the managed Ollama daemon.
 * @param {Array<{ id: string, size?: number|null }>} models
 */
export async function planInstalledModels(models) {
  const host = await resolveContextPlanHost()
  const plans = await Promise.all(models.map((model) => planModelContext(model, host).catch(() => null)))
  return { ...host, plans: plans.filter(Boolean) }
}
