/**
 * Local LLM orchestration — unifies the Ollama and LM Studio backends behind
 * one shape so the UI can list / search / install / delete models and migrate
 * or switch the active backend (mirroring the Docker↔native Postgres flow).
 *
 * The active backend is recorded in `.env` as `LLM_BACKEND` (parallel to
 * `PGMODE`), so it survives restarts and is readable by the setup script. The
 * matching aiToolkit provider (`ollama` / `lmstudio`) is enabled whenever a
 * backend becomes active.
 *
 * The GGUF weights ARE portable between the two backends — only the on-disk
 * layout differs (Ollama's content-addressed blob store vs LM Studio's plain
 * file tree). So "migrate" copies each model's GGUF across locally (no
 * download) when it can, and re-pulls the cross-backend catalog equivalent only
 * for models it can't copy (LM Studio MLX-format, sharded, or multimodal), then
 * flips the active marker. See `server/lib/localLlmDisk.js` for the disk logic.
 */

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../lib/fileUtils.js'
import { isBackend, mapModelToBackend } from '../lib/localLlmCatalog.js'
import { sanitizeOllamaName } from '../lib/localLlmDisk.js'
import * as ollamaManager from './ollamaManager.js'
import * as lmStudioManager from './lmStudioManager.js'
import { getProviderById, updateProvider } from './providers.js'

const execFileAsync = promisify(execFile)
const ENV_PATH = join(PATHS.root, '.env')
const DEFAULT_BACKEND = 'ollama'

// `lms get` blocks until the download finishes — generous but finite so a
// stalled connection (or an unexpected interactive prompt) can't hang the
// request forever. Large models on a slow link still fit comfortably.
const LMS_INSTALL_TIMEOUT_MS = 60 * 60 * 1000

// Backend (app/binary) installs go through a package manager and can pull a
// large cask; bound them so a wedged installer can't hang the request forever.
const BACKEND_INSTALL_TIMEOUT_MS = 30 * 60 * 1000

const DOWNLOAD_URL = { ollama: 'https://ollama.com/download', lmstudio: 'https://lmstudio.ai/download' }

// Which (platform, backend) pairs PortOS can install automatically. macOS uses
// Homebrew for both; Linux has an official Ollama script but no clean LM Studio
// CLI install; Windows is download-only.
function canAutoInstall(backend) {
  if (process.platform === 'darwin') return true
  if (process.platform === 'linux') return backend === 'ollama'
  return false
}

// aiToolkit provider id that pairs with each backend.
const PROVIDER_ID = { ollama: 'ollama', lmstudio: 'lmstudio' }

// ---- active-backend marker (.env LLM_BACKEND) --------------------------------

function readEnv() {
  const result = {}
  let content = ''
  try { content = readFileSync(ENV_PATH, 'utf8') } catch { return result }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[trimmed.slice(0, idx).trim()] = value
  }
  return result
}

/**
 * The active local-LLM backend, read fresh from `.env` each call. `.env` wins
 * when valid; otherwise a valid `process.env` override wins (a stale/invalid
 * `.env` marker must not mask a valid runtime env override — validate each
 * source before falling through, don't `||` on mere presence).
 */
export function getBackend() {
  const fromFile = readEnv().LLM_BACKEND
  if (isBackend(fromFile)) return fromFile
  if (isBackend(process.env.LLM_BACKEND)) return process.env.LLM_BACKEND
  return DEFAULT_BACKEND
}

function writeBackend(backend) {
  let content = ''
  try { content = readFileSync(ENV_PATH, 'utf8') } catch { /* no .env yet */ }
  if (/^LLM_BACKEND=/m.test(content)) {
    content = content.replace(/^LLM_BACKEND=.*/m, `LLM_BACKEND=${backend}`)
  } else {
    content = `LLM_BACKEND=${backend}\n${content}`
  }
  writeFileSync(ENV_PATH, content)
}

/**
 * Enable the aiToolkit provider that pairs with `backend`, so the active local
 * backend is actually usable for runs. Best-effort: a misconfigured provider
 * store must not crash a boot-time or migrate call.
 */
export async function ensureBackendProvider(backend) {
  const id = PROVIDER_ID[backend]
  if (!id) return
  const provider = await getProviderById(id).catch(() => null)
  if (provider && !provider.enabled) {
    const enabled = await updateProvider(id, { enabled: true })
      .then(() => true)
      .catch((err) => {
        console.error(`⚠️ Failed to enable ${id} provider: ${err.message}`)
        return false
      })
    if (enabled) console.log(`🔌 Enabled ${id} provider for active local LLM backend`)
  }
}

// ---- backend capability probes ----------------------------------------------

async function commandExists(cmd, args) {
  return execFileAsync(cmd, args, { timeout: 5_000 }).then(() => true).catch(() => false)
}

const manager = (backend) => (backend === 'ollama' ? ollamaManager : lmStudioManager)

/**
 * Spawn a command and stream its stdout/stderr lines to `onLine`, resolving
 * `{ success }` on exit. Used for package-manager installs where live output is
 * the only progress signal. Never rejects (errors resolve as `{ success:false }`)
 * and guards the `onLine` hook — this runs outside the request lifecycle.
 */
function runStreaming(cmd, args, onLine, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    let settled = false
    const safeLine = (line) => {
      if (!line || typeof onLine !== 'function') return
      try { onLine(line) } catch (err) { console.error(`⚠️ install progress hook failed: ${err.message}`) }
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => { child.kill('SIGKILL'); finish({ success: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` }) }, timeoutMs)
      : null
    const onData = (chunk) => {
      buffer += chunk.toString()
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        safeLine(buffer.slice(0, nl).trim())
        buffer = buffer.slice(nl + 1)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => finish({ success: false, error: err.message }))
    child.on('close', (code) => {
      safeLine(buffer.trim())
      finish(code === 0 ? { success: true } : { success: false, error: `exited with code ${code}` })
    })
  })
}

/**
 * Install a backend's app/binary via the platform package manager (Homebrew on
 * macOS for both; the official script for Ollama on Linux). Streams installer
 * output via `onProgress`. Returns `{ success, note? }` — `note` tells the user
 * how to start it (installing the binary doesn't start the server/app).
 *
 * @param {string} backend - 'ollama' | 'lmstudio'
 * @param {(p: { event: string, message: string }) => void} [onProgress]
 */
export async function installBackend(backend, onProgress = () => {}) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  const emit = (message) => onProgress({ event: 'start', message })
  const downloadHint = `Download it from ${DOWNLOAD_URL[backend]}.`

  if (!canAutoInstall(backend)) {
    return { success: false, error: `Automatic install isn't supported on this platform. ${downloadHint}` }
  }

  // Linux Ollama: official install script.
  if (process.platform === 'linux') {
    emit('Installing Ollama via the official install script…')
    const r = await runStreaming('bash', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], emit, BACKEND_INSTALL_TIMEOUT_MS)
    if (!r.success) return { success: false, error: `Ollama install failed: ${r.error}. ${downloadHint}` }
    console.log('⬇️ Installed Ollama (linux script)')
    return { success: true, backend }
  }

  // macOS: Homebrew (formula for Ollama, cask for LM Studio).
  if (!(await commandExists('brew', ['--version']))) {
    return { success: false, error: `Homebrew not found — install it from https://brew.sh first, or download the app: ${DOWNLOAD_URL[backend]}` }
  }
  const label = backend === 'ollama' ? 'Ollama' : 'LM Studio'
  const args = backend === 'ollama' ? ['install', 'ollama'] : ['install', '--cask', 'lm-studio']
  emit(`Installing ${label} via Homebrew (this can take a few minutes)…`)
  const r = await runStreaming('brew', args, emit, BACKEND_INSTALL_TIMEOUT_MS)
  if (!r.success) return { success: false, error: `Homebrew install failed: ${r.error}` }
  console.log(`🍺 Installed ${label} via Homebrew`)
  return {
    success: true,
    backend,
    note: backend === 'ollama'
      ? 'Start it with `ollama serve` (or `brew services start ollama`), then refresh.'
      : 'Launch LM Studio, enable the local server (Developer tab), then run `lms bootstrap`.'
  }
}

/** Normalize each backend's installed-model shape into one card shape. */
function normalizeModels(backend, models) {
  if (backend === 'ollama') {
    return models.map((m) => ({
      id: m.id, name: m.name, size: m.size ?? null,
      params: m.params || null, quantization: m.quantization || null, family: m.family || null
    }))
  }
  return models.map((m) => ({
    id: m.id, name: m.id, size: null,
    params: null, quantization: m.quantization || null, family: m.arch || null
  }))
}

/**
 * Installed models for a backend, normalized.
 * @param {boolean} [forceRefresh] - bypass the Ollama installed-models cache.
 *   Default false so the catalog-overlay path (hit on every debounced keystroke)
 *   reuses the cache instead of spamming `/api/tags`. The cache is busted on
 *   pull/delete, so it stays accurate; force only for explicit refresh/migrate.
 */
export async function listModels(backend, forceRefresh = false) {
  if (!isBackend(backend)) return []
  const raw = backend === 'ollama'
    ? await ollamaManager.getInstalledModels(forceRefresh)
    : await lmStudioManager.getAvailableModels(forceRefresh)
  return normalizeModels(backend, raw)
}

/**
 * Combined status for both backends plus the active marker.
 */
export async function getStatus() {
  const [ollamaStatus, ollamaCli, lmStudioStatus, lmsCli, lmStudioModels] = await Promise.all([
    ollamaManager.getStatus(),
    commandExists('ollama', ['--version']),
    lmStudioManager.getStatus(),
    commandExists('lms', ['version']),
    // forceRefresh: status/refresh path bypasses the list cache.
    listModels('lmstudio', true).catch(() => [])
  ])

  return {
    backend: getBackend(),
    ollama: {
      installed: ollamaCli || ollamaStatus.available,
      available: ollamaStatus.available,
      version: ollamaStatus.version,
      baseUrl: ollamaStatus.baseUrl,
      modelCount: ollamaStatus.modelCount,
      models: normalizeModels('ollama', ollamaStatus.models),
      canAutoInstall: canAutoInstall('ollama'),
      downloadUrl: DOWNLOAD_URL.ollama
    },
    lmstudio: {
      // macOS app bundle counts as installed even with no CLI / server stopped.
      installed: lmsCli || lmStudioStatus.available || lmStudioManager.isAppInstalled(),
      available: lmStudioStatus.available,
      hasCli: lmsCli,
      baseUrl: lmStudioStatus.baseUrl,
      modelCount: lmStudioModels.length,
      models: lmStudioModels,
      // Non-null when LM Studio answered the availability probe but the model
      // list call failed — lets the UI tell "0 models" from "couldn't list".
      modelsError: lmStudioManager.getLastListError(),
      canAutoInstall: canAutoInstall('lmstudio'),
      downloadUrl: DOWNLOAD_URL.lmstudio
    }
  }
}

// ---- install / delete --------------------------------------------------------

/**
 * Install (pull/download) a model on a backend.
 * @param {(p) => void} [onProgress] - streaming progress (Ollama only)
 */
export async function installModel(backend, modelId, onProgress) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  if (backend === 'ollama') {
    return ollamaManager.pullModel(modelId, onProgress)
  }
  // LM Studio: prefer the `lms` CLI (real, blocking download), fall back to the
  // REST hook.
  if (await commandExists('lms', ['version'])) {
    // `lms get` streams substantial progress to stdout; the default 1MB
    // maxBuffer overflows and surfaces as a false install failure (see
    // voice/bootstrap.js which uses the same 64MB ceiling for `lms get`).
    const r = await execFileAsync('lms', ['get', '-y', modelId], { timeout: LMS_INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
      .then(() => ({ ok: true })).catch((err) => ({ _err: err.stderr || err.message }))
    if (r._err) return { success: false, error: r._err, modelId }
    lmStudioManager.resetCache()
    return { success: true, modelId }
  }
  // REST fallback only *queues* the download — LM Studio pulls it in the
  // background and the call returns immediately. Flag it `pending` so callers
  // don't claim the model is installed before it actually is.
  const r = await lmStudioManager.downloadModel(modelId)
  return r.success ? { ...r, pending: true } : r
}

/**
 * Delete an installed model from a backend.
 */
export async function deleteModel(backend, modelId) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  if (backend === 'ollama') {
    return ollamaManager.deleteModel(modelId)
  }
  // LM Studio has no delete in its REST API — use the `lms` CLI if present.
  if (await commandExists('lms', ['version'])) {
    const r = await execFileAsync('lms', ['rm', modelId, '-y'], { timeout: 30_000 })
      .then(() => ({ ok: true })).catch((err) => ({ _err: err.stderr || err.message }))
    if (r._err) return { success: false, error: r._err, modelId }
    lmStudioManager.resetCache()
    return { success: true, modelId }
  }
  return { success: false, error: 'Deleting LM Studio models requires the `lms` CLI. Remove it from the LM Studio app instead.', modelId }
}

// ---- switch / migrate --------------------------------------------------------

/**
 * Flip the active backend without moving any models.
 */
export async function switchBackend(to) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  writeBackend(to)
  await ensureBackendProvider(to)
  console.log(`🔀 Active local LLM backend → ${to}`)
  return { success: true, backend: to }
}

/**
 * Try to provision a single source model on the target WITHOUT downloading, by
 * copying its GGUF weights across the two on-disk layouts (the underlying GGUF
 * is the same; only Ollama's content-addressed blob store vs LM Studio's plain
 * file tree differ). Returns a per-model result on success, or `null` to tell
 * the caller to fall back to a re-pull (no local file, MLX-only, multi-file
 * sharded, a multimodal projector we can't carry into Ollama, or a copy error).
 */
async function tryLocalImport(to, model, targetId, resolved, onProgress) {
  // Fast path requires a single-file GGUF on disk. MLX (no GGUF) and sharded
  // models fall through; a separate projector can be copied to LM Studio but
  // not cleanly imported into Ollama, so that case re-pulls too.
  if (!resolved?.ggufPath || resolved.isSharded) return null
  if (to === 'ollama' && resolved.projectorPath) return null

  const name = to === 'ollama'
    ? sanitizeOllamaName(targetId || model.id)
    : (targetId || `imported/${model.id.split('/').pop()}`)
  onProgress({ event: 'start', message: `Importing ${name} on ${to} (local copy, no download)…` })
  const r = to === 'ollama'
    ? await ollamaManager.importModelFromGguf({ name, ggufPath: resolved.ggufPath })
    : await lmStudioManager.importModelFromGguf({ lmstudioId: name, ggufPath: resolved.ggufPath, projectorPath: resolved.projectorPath })
  if (!r.success) {
    onProgress({ event: 'start', message: `Local import of ${model.id} failed (${r.error}); re-pulling…` })
    return null
  }
  onProgress({ event: 'start', message: `Imported ${r.modelId} on ${to} (no download)` })
  return { source: model.id, target: r.modelId, status: 'imported', reason: null }
}

/**
 * Migrate to a backend: provision the active backend's installed models on the
 * target, then flip the active marker. The underlying GGUF weights ARE portable
 * across backends, so each model is first copied locally (no download) when it's
 * a single-file GGUF; models that can't be copied (LM Studio MLX-format, sharded,
 * or with a separate projector) fall back to re-pulling the catalog equivalent.
 * Per-model results are reported; an individual failure doesn't abort the switch.
 *
 * @param {string} to - target backend
 * @param {(p: { event: string, message: string }) => void} [onProgress]
 */
export async function migrateBackend(to, onProgress = () => {}) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  // Source is whatever's active now — we're moving away from it. Migrating to
  // the already-active backend is a no-op, not "re-provision from the other".
  const from = getBackend()
  if (from === to) {
    return { success: false, error: `${to} is already the active backend — nothing to migrate.` }
  }

  onProgress({ event: 'start', message: `Reading models installed on ${from}…` })
  const sourceModels = await listModels(from, true) // fresh source list for an accurate migration

  const results = []
  for (const model of sourceModels) {
    const { targetId, exact } = mapModelToBackend(from, model.id, to)
    const resolved = await manager(from).resolveLocalModel(model.id).catch(() => null)

    // 1) Fast path — copy the GGUF locally (no download) when we can.
    const imported = await tryLocalImport(to, model, targetId, resolved, onProgress)
    if (imported) { results.push(imported); continue }

    // 2) Fallback — re-pull the catalog equivalent.
    if (!targetId) {
      const reason = resolved?.isMlx ? 'MLX format — no GGUF equivalent to re-pull' : 'no known equivalent'
      results.push({ source: model.id, target: null, status: 'skipped', reason })
      onProgress({ event: 'start', message: `Skipped ${model.id} — ${reason}` })
      continue
    }
    onProgress({ event: 'start', message: `Downloading ${targetId} on ${to}${exact ? '' : ' (best-effort)'}…` })
    const r = await installModel(to, targetId, (p) => {
      if (p?.percent != null) onProgress({ event: 'start', message: `Pulling ${targetId}: ${p.percent}%` })
    })
    // `pending` (LM Studio REST fallback) means the download was queued, not
    // finished — don't report it as a completed install.
    const status = r.success ? (r.pending ? 'started' : 'installed') : 'failed'
    results.push({ source: model.id, target: targetId, status, reason: r.error })
  }

  const imported = results.filter((r) => r.status === 'imported').length
  const installed = results.filter((r) => r.status === 'installed').length
  const started = results.filter((r) => r.status === 'started').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.length - imported - installed - started - failed
  const succeeded = imported + installed + started

  // Don't flip the active marker onto a backend we couldn't provision anything
  // on — if every attempt failed (target not installed/running), switching would
  // leave PortOS pointed at an unusable backend. All-skipped is fine (the target
  // itself works; we just had no equivalent to move).
  if (failed > 0 && succeeded === 0) {
    const error = `Migration to ${to} failed — no models could be provisioned (is ${to} installed and running?). Active backend left unchanged.`
    onProgress({ event: 'error', message: error })
    console.error(`⚠️ Migration to ${to} aborted: ${failed} failed, 0 succeeded — marker unchanged`)
    return { success: false, error, results }
  }

  writeBackend(to)
  await ensureBackendProvider(to)

  const parts = [
    imported ? `${imported} copied locally` : null,
    installed ? `${installed} downloaded` : null,
    started ? `${started} downloading` : null,
    failed ? `${failed} failed` : null,
    skipped ? `${skipped} skipped` : null
  ].filter(Boolean)
  onProgress({ event: 'complete', message: `Migrated to ${to} — ${parts.join(', ') || 'no models to move'}` })
  console.log(`🔀 Migrated local LLM backend → ${to} (${imported} copied, ${installed} downloaded, ${failed} failed)`)
  return { success: true, backend: to, results }
}
