/**
 * Local LLM orchestration — unifies the Ollama and LM Studio backends behind
 * one shape so the UI can list / search / install / delete models, move models
 * between backends, and pick the default backend. Both backends can be installed
 * and running at the same time; the "default" is just which one PortOS routes
 * local runs to.
 *
 * The default backend is recorded in `.env` as `LLM_BACKEND` (parallel to
 * `PGMODE`), so it survives restarts and is readable by the setup script. The
 * matching aiToolkit provider (`ollama` / `lmstudio`) is enabled whenever a
 * backend becomes the default (each provider stays independently enabled — we
 * never disable the other, so both remain usable concurrently).
 *
 * The GGUF weights ARE portable between the two backends — only the on-disk
 * layout differs (Ollama's content-addressed blob store vs LM Studio's plain
 * file tree). So `migrateBackend` (bidirectional, independent of the default
 * marker) hardlinks each model's GGUF across — sharing it on disk with zero
 * extra space — or copies it, and re-pulls the cross-backend catalog equivalent
 * only for models it can't share/copy (LM Studio MLX-format, sharded, or
 * multimodal). See `server/lib/localLlmDisk.js` for the disk logic.
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
  if (backend === 'ollama') {
    emit('Starting Ollama as a Homebrew service…')
    const service = await ollamaManager.startPersistentService().catch((err) => ({ success: false, error: err.message }))
    if (service.success) {
      return {
        success: true,
        backend,
        service: service.service,
        note: 'Started as a Homebrew service; it will run in the background at login.'
      }
    }
    const fallback = await ollamaManager.startServer().catch((err) => ({ success: false, error: err.message }))
    return {
      success: true,
      backend,
      service: service.service,
      note: fallback.success
        ? `Installed, but Homebrew services could not register Ollama (${service.error}). Started it for this session.`
        : `Installed, but PortOS could not start Ollama automatically (${service.error || fallback.error}). Use Run at Startup from this screen.`
    }
  }
  return {
    success: true,
    backend,
    note: 'Launch LM Studio, enable the local server (Developer tab), then run `lms bootstrap`.'
  }
}

/**
 * Start/stop the Ollama HTTP server from the UI. LM Studio is app-controlled,
 * so keep this intentionally narrow instead of inventing unreliable app-launch
 * behavior for every platform.
 */
export async function controlOllamaServer(action) {
  if (action === 'start') return ollamaManager.startServer()
  if (action === 'stop') return ollamaManager.stopServer()
  if (action === 'enable') return ollamaManager.startPersistentService()
  if (action === 'disable') return ollamaManager.stopPersistentService()
  return { success: false, error: `Unknown Ollama action: ${action}` }
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
    ollamaManager.getStatus(true),
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
      canControl: ollamaCli || ollamaStatus.available,
      service: ollamaStatus.service,
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
  // LM Studio has no delete in its REST API and the `lms` CLI has no `rm`
  // command — deleteModel removes the model's on-disk folder directly.
  return lmStudioManager.deleteModel(modelId)
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
async function tryLocalImport(to, model, targetId, resolved, mode, onProgress) {
  // Fast path requires a single-file GGUF on disk. MLX (no GGUF) and sharded
  // models fall through; a separate projector can be copied to LM Studio but
  // not cleanly imported into Ollama, so that case re-pulls too.
  if (!resolved?.ggufPath || resolved.isSharded) return null
  if (to === 'ollama' && resolved.projectorPath) return null

  const name = to === 'ollama'
    ? sanitizeOllamaName(targetId || model.id)
    : (targetId || `imported/${model.id.split('/').pop()}`)
  const verb = mode === 'link' ? 'Linking' : 'Copying'
  onProgress({ event: 'start', message: `${verb} ${name} onto ${to} (no download)…` })
  const r = to === 'ollama'
    ? await ollamaManager.importModelFromGguf({ name, ggufPath: resolved.ggufPath, mode })
    : await lmStudioManager.importModelFromGguf({ lmstudioId: name, ggufPath: resolved.ggufPath, projectorPath: resolved.projectorPath, mode })
  if (!r.success) {
    onProgress({ event: 'start', message: `Local import of ${model.id} failed (${r.error}); re-pulling…` })
    return null
  }
  // `linked` reflects what actually happened on disk — link mode falls back to a
  // copy across filesystems, so report the real outcome, not the requested mode.
  onProgress({ event: 'start', message: `${r.linked ? 'Linked' : 'Copied'} ${r.modelId} onto ${to} (no download)` })
  return { source: model.id, target: r.modelId, status: 'imported', linked: !!r.linked, reason: null }
}

/** The other of the two backends (migration source for a given target). */
const otherBackend = (backend) => (backend === 'ollama' ? 'lmstudio' : 'ollama')

/**
 * Provision the OTHER backend's installed models onto `to`. This is bidirectional
 * (source is simply the opposite backend, NOT the active one) and decoupled from
 * the default-backend marker — it never flips it. Use `switchBackend` ("Set as
 * Default") for routing. The underlying GGUF weights ARE portable across backends:
 *
 *   • `mode: 'link'` (default) — hardlink the GGUF so both backends share one file
 *     on disk (zero extra space), falling back to a copy where a hardlink isn't
 *     possible (different filesystem).
 *   • `mode: 'copy'` — make an independent duplicate.
 *
 * Either way there's no re-download for portable single-file GGUFs; models that
 * can't be shared/copied (LM Studio MLX-format, sharded, or with a separate
 * projector when targeting Ollama) fall back to re-pulling the catalog
 * equivalent. Per-model results are reported; an individual failure doesn't abort.
 *
 * @param {string} to - target backend
 * @param {{ mode?: 'link'|'copy', onProgress?: (p: { event: string, message: string }) => void }} [opts]
 */
export async function migrateBackend(to, { mode = 'link', onProgress = () => {} } = {}) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  if (mode !== 'link' && mode !== 'copy') mode = 'link'
  const from = otherBackend(to)

  onProgress({ event: 'start', message: `Reading models installed on ${from}…` })
  const sourceModels = await listModels(from, true) // fresh source list for an accurate migration
  if (sourceModels.length === 0) {
    const message = `No models installed on ${from} to move.`
    onProgress({ event: 'complete', message })
    return { success: true, from, to, mode, results: [] }
  }

  const results = []
  for (const model of sourceModels) {
    const { targetId, exact } = mapModelToBackend(from, model.id, to)
    const resolved = await manager(from).resolveLocalModel(model.id).catch(() => null)

    // 1) Fast path — link/copy the GGUF locally (no download) when we can.
    const imported = await tryLocalImport(to, model, targetId, resolved, mode, onProgress)
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

  const linked = results.filter((r) => r.status === 'imported' && r.linked).length
  const copied = results.filter((r) => r.status === 'imported' && !r.linked).length
  const installed = results.filter((r) => r.status === 'installed').length
  const started = results.filter((r) => r.status === 'started').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const succeeded = linked + copied + installed + started

  // Surface a hard failure when nothing could be provisioned (e.g. target not
  // installed/running). All-skipped is fine — the target works, we just had no
  // equivalent to move.
  if (failed > 0 && succeeded === 0) {
    const error = `Migration ${from} → ${to} failed — no models could be provisioned (is ${to} installed and running?).`
    onProgress({ event: 'error', message: error })
    console.error(`⚠️ Migration ${from} → ${to} aborted: ${failed} failed, 0 succeeded`)
    return { success: false, from, to, mode, error, results }
  }

  const parts = [
    linked ? `${linked} linked (shared on disk)` : null,
    copied ? `${copied} copied` : null,
    installed ? `${installed} downloaded` : null,
    started ? `${started} downloading` : null,
    failed ? `${failed} failed` : null,
    skipped ? `${skipped} skipped` : null
  ].filter(Boolean)
  onProgress({ event: 'complete', message: `Moved ${from} → ${to} — ${parts.join(', ') || 'no models to move'}` })
  console.log(`🔀 Moved models ${from} → ${to} (${linked} linked, ${copied} copied, ${installed} downloaded, ${failed} failed)`)
  return { success: true, from, to, mode, results }
}
