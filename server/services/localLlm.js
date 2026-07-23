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
import { readFileSync, createWriteStream } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { PATHS, atomicWrite, ensureDir, pathExists, sleep } from '../lib/fileUtils.js'
import { compareSemver } from '../lib/versionUtils.js'
import { isBackend, mapModelToBackend } from '../lib/localLlmCatalog.js'
import { sanitizeOllamaName } from '../lib/localLlmDisk.js'
import { recommendEditorialModel, isVisionModel, isVisionCapableCliProvider, isToolUseModel } from '../lib/localModelHeuristics.js'
import * as ollamaManager from './ollamaManager.js'
import * as lmStudioManager from './lmStudioManager.js'
import { getProviderById, getAllProviders, updateProvider, refreshProviderModels, isOllamaBackedProvider } from './providers.js'

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

// Which (platform, backend) pairs PortOS can UPGRADE in place. This is NOT the
// same as canAutoInstall: LM Studio installs via the Homebrew cask on macOS but
// self-updates through Sparkle, which PortOS can't drive (upgradeBackend returns
// manualUpdateRequired for it). Only Ollama has a PortOS-driven upgrade path
// (direct .app download on macOS, brew formula / official script otherwise).
function canAutoUpgrade(backend) {
  if (backend !== 'ollama') return false
  return process.platform === 'darwin' || process.platform === 'linux'
}

// aiToolkit provider id that pairs with each backend.
const PROVIDER_ID = { ollama: 'ollama', lmstudio: 'lmstudio' }

// Possible places `brew` registers each backend. Ollama has both a CLI-only
// formula and a separate macOS .app cask (`ollama-app`); LM Studio is cask-only.
const BREW_LOCATIONS = {
  ollama: [
    { kind: 'formula', name: 'ollama', listArgs: ['list', '--formula', 'ollama'], upgradeArgs: ['upgrade', 'ollama'] },
    { kind: 'cask', name: 'ollama-app', listArgs: ['list', '--cask', 'ollama-app'], upgradeArgs: ['upgrade', '--cask', 'ollama-app'] }
  ],
  lmstudio: [
    { kind: 'cask', name: 'lm-studio', listArgs: ['list', '--cask', 'lm-studio'], upgradeArgs: ['upgrade', '--cask', 'lm-studio'] }
  ]
}

// Macs that installed Ollama via the official .app downloader (not Homebrew)
// have /usr/local/bin/ollama (or /opt/homebrew/bin/ollama) as a symlink into
// the bundle, and the app's built-in updater handles upgrades. The .app for
// LM Studio works the same way. Detecting this lets us tell the user "open
// the app and use its own updater" instead of blindly running brew.
function macAppPath(backend) {
  if (process.platform !== 'darwin') return null
  return backend === 'ollama' ? '/Applications/Ollama.app' : '/Applications/LM Studio.app'
}

/**
 * Where did this install of `backend` come from? Decides which upgrade path is
 * actually safe to run — `brew upgrade ollama` against a `.app`-installed
 * Ollama fails with "Error: ollama not installed" and surfaces as a useless
 * "exited with code 1". Probes Homebrew first (formula then cask) and falls
 * back to a macOS .app presence check.
 *
 * @returns {Promise<{ source: 'brew-formula'|'brew-cask'|'mac-app'|'unknown', upgradeArgs?: string[], packageName?: string }>}
 */
async function detectInstallSource(backend) {
  if (process.platform === 'darwin' && await commandExists('brew', ['--version'])) {
    for (const loc of BREW_LOCATIONS[backend] || []) {
      if (await commandExists('brew', loc.listArgs)) {
        return { source: loc.kind === 'cask' ? 'brew-cask' : 'brew-formula', upgradeArgs: loc.upgradeArgs, packageName: loc.name }
      }
    }
  }
  if (process.platform === 'darwin' && await pathExists(macAppPath(backend))) {
    return { source: 'mac-app' }
  }
  return { source: 'unknown' }
}

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

async function writeBackend(backend) {
  let content = ''
  try { content = readFileSync(ENV_PATH, 'utf8') } catch { /* no .env yet */ }
  if (/^LLM_BACKEND=/m.test(content)) {
    content = content.replace(/^LLM_BACKEND=.*/m, `LLM_BACKEND=${backend}`)
  } else {
    content = `LLM_BACKEND=${backend}\n${content}`
  }
  await atomicWrite(ENV_PATH, content)
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
  if (!provider) return

  const patch = {}
  if (!provider.enabled) patch.enabled = true
  // Ollama's OpenAI-compatible endpoint silently truncates to a ~4K context
  // window unless a per-request num_ctx is sent. Editorial passes feed the
  // whole manuscript (tens of thousands of tokens), so default a generous
  // window (override with OLLAMA_NUM_CTX). LM Studio sets context at model
  // load, so this only applies to Ollama.
  if (backend === 'ollama' && !(Number(provider.numCtx) > 0)) {
    patch.numCtx = Number(process.env.OLLAMA_NUM_CTX) || 32768
  }
  if (Object.keys(patch).length === 0) return

  const ok = await updateProvider(id, patch)
    .then(() => true)
    .catch((err) => {
      console.error(`⚠️ Failed to configure ${id} provider: ${err.message}`)
      return false
    })
  if (ok) console.log(`🔌 Configured ${id} provider for local LLM backend (${Object.keys(patch).join(', ')})`)
}

// ---- backend capability probes ----------------------------------------------

async function commandExists(cmd, args) {
  return execFileAsync(cmd, args, { timeout: 5_000 }).then(() => true).catch(() => false)
}

// Whether Homebrew already has the backend's formula/cask installed. Used to
// recover from a non-zero `brew install` exit that nonetheless left the package
// on disk (post-install cleanup/hint failures exit 1 after a successful pour).
// `brew list` exits 0 only when the package is present, so its success IS the
// presence check — no output parsing needed.
async function brewPackageInstalled(backend) {
  const args = backend === 'ollama'
    ? ['list', '--versions', 'ollama']
    : ['list', '--cask', '--versions', 'lm-studio']
  return commandExists('brew', args)
}

const manager = (backend) => (backend === 'ollama' ? ollamaManager : lmStudioManager)

/**
 * Spawn a command and stream its stdout/stderr lines to `onLine`, resolving
 * `{ success }` on exit. Used for package-manager installs where live output is
 * the only progress signal. Never rejects (errors resolve as `{ success:false }`)
 * and guards the `onLine` hook — this runs outside the request lifecycle.
 *
 * The error path includes a tail of the streamed output (last ~1KB of recent
 * lines) so callers get an actionable message — `brew upgrade ollama` exiting
 * non-zero with stderr "Error: ollama not installed" must surface that string,
 * not just "exited with code 1".
 */
function runStreaming(cmd, args, onLine, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    let settled = false
    const tail = [] // recent non-empty lines, capped by char budget for the error message
    let tailChars = 0
    const TAIL_BUDGET = 1024
    const rememberLine = (line) => {
      if (!line) return
      tail.push(line)
      tailChars += line.length + 1
      while (tailChars > TAIL_BUDGET && tail.length > 1) {
        tailChars -= tail.shift().length + 1
      }
    }
    const safeLine = (line) => {
      if (!line) return
      rememberLine(line)
      if (typeof onLine !== 'function') return
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
      if (code === 0) return finish({ success: true })
      const detail = tail.join(' — ').trim()
      finish({ success: false, error: detail ? `exit ${code}: ${detail}` : `exited with code ${code}` })
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
  if (!r.success) {
    // `brew install` routinely exits non-zero AFTER a successful pour — a
    // failed `brew cleanup`, a dependency's post-install hint, or env-hint
    // noise (e.g. Ollama's new mlx/mlx-c deps) all bubble up as exit 1 even
    // though the formula/cask is fully installed. Treat presence-on-disk as
    // the source of truth: if `brew list` now sees it, the install worked.
    if (await brewPackageInstalled(backend)) {
      console.log(`🍺 ${label} already present after non-zero brew exit — treating as installed (${r.error})`)
      emit(`${label} is installed (Homebrew reported a non-fatal warning).`)
    } else {
      return { success: false, error: `Homebrew install failed: ${r.error}` }
    }
  } else {
    console.log(`🍺 Installed ${label} via Homebrew`)
  }
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
 * Fetch the latest Ollama GitHub release object (or null on any failure). The
 * full object carries both the tag and the downloadable assets — getStatus's
 * cached version lookup reads `tag_name`, the macOS upgrader reads `assets`.
 */
async function fetchLatestOllamaRelease(timeoutMs = 8000) {
  return fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
    headers: { 'User-Agent': 'PortOS', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
}

// Cache the latest Ollama release tag. GitHub's release API is slow and
// unauthenticated-rate-limited, and getStatus() runs on every Local LLMs tab
// load / refresh / action — so a steady-state UI must not hit GitHub each time.
// `version: null` is the not-fetched sentinel (distinct from a cached value); a
// successful fetch holds for LATEST_VERSION_TTL_MS, a failed one backs off for
// the shorter error TTL instead of poisoning the cache forever or hammering.
let latestOllamaCache = { version: null, fetchedAt: 0 }
const LATEST_VERSION_TTL_MS = 6 * 60 * 60 * 1000
const LATEST_VERSION_ERROR_TTL_MS = 10 * 60 * 1000

/**
 * Latest published Ollama version (no leading `v`), or null if it can't be
 * determined. Cached — see the TTL notes above. Used by getStatus to surface an
 * "update available" affordance in the UI without a per-call network round-trip.
 */
export async function getLatestOllamaVersion() {
  const age = Date.now() - latestOllamaCache.fetchedAt
  if (latestOllamaCache.version && age < LATEST_VERSION_TTL_MS) return latestOllamaCache.version
  // Recent failed lookup — back off rather than refetch on every status call.
  if (!latestOllamaCache.version && latestOllamaCache.fetchedAt && age < LATEST_VERSION_ERROR_TTL_MS) return null

  const release = await fetchLatestOllamaRelease(8000)
  const version = release?.tag_name ? String(release.tag_name).replace(/^v/, '') : null
  latestOllamaCache = { version, fetchedAt: Date.now() }
  return version
}

/**
 * Pre-upgrade Ollama version (best-effort — returns null if Ollama isn't running
 * or isn't responding). Used to verify an upgrade actually moved the version.
 */
async function readOllamaVersion() {
  const status = await ollamaManager.getStatus(true).catch(() => null)
  return status?.version || null
}

/**
 * Poll Ollama's /api/version until it responds (after a (re)start). Returns the
 * version string when reachable, null on timeout.
 */
async function waitForOllamaVersion(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await readOllamaVersion()
    if (v) return v
    await sleep(500)
  }
  return null
}

/**
 * Download + install the latest Ollama macOS .app in place. This is the only
 * reliable path on macOS — `brew upgrade ollama` either has a behind-by-weeks
 * formula, OR the running server is the .app binary (because `/usr/local/bin/
 * ollama` symlinks into the bundle) so even a successful brew upgrade leaves
 * the wrong binary serving. Pulls the latest `Ollama-darwin.zip` from the
 * official GitHub releases, replaces `/Applications/Ollama.app` on disk, strips
 * quarantine, and relaunches.
 *
 * The .app keeps its own user prefs / model store (`~/.ollama`) so this is
 * non-destructive; only the bundle itself gets swapped.
 */
async function upgradeOllamaMacApp(emit) {
  const appPath = '/Applications/Ollama.app'

  emit('Looking up the latest Ollama release on GitHub…')
  // Uncached on purpose — an explicit upgrade needs the live release (and its
  // download assets), not the status-path's 6h-cached tag.
  const release = await fetchLatestOllamaRelease(15000)
  if (!release) return { success: false, error: 'Could not reach GitHub to look up the latest Ollama release.' }

  const asset = (release.assets || []).find((a) => a.name === 'Ollama-darwin.zip')
  if (!asset?.browser_download_url) {
    return { success: false, error: `Latest Ollama release ${release.tag_name} has no Ollama-darwin.zip asset — try downloading from ${DOWNLOAD_URL.ollama}.` }
  }

  const before = await readOllamaVersion()
  const tagClean = String(release.tag_name || '').replace(/^v/, '')
  if (before && tagClean && before === tagClean) {
    return { success: true, backend: 'ollama', note: `Ollama is already at ${before} (latest).`, alreadyLatest: true }
  }

  const tmpDir = join(tmpdir(), `portos-ollama-upgrade-${Date.now()}`)
  const zipPath = join(tmpDir, 'Ollama-darwin.zip')
  await ensureDir(tmpDir)

  emit(`Downloading Ollama ${release.tag_name} (${Math.round(asset.size / 1024 / 1024)} MB)…`)
  // No timeout signal here: it would cover the entire multi-hundred-MB body
  // stream, turning slow links into mid-download aborts. User-triggered and
  // recoverable, so an unbounded stream is the lesser evil.
  const dl = await fetch(asset.browser_download_url).catch((err) => ({ _err: err.message }))
  if (dl._err || !dl?.ok || !dl.body) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: `Download failed: ${dl?._err || dl?.statusText || 'no response body'}` }
  }
  const pipeErr = await pipeline(Readable.fromWeb(dl.body), createWriteStream(zipPath)).then(() => null, (err) => err)
  if (pipeErr) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: `Download failed: ${pipeErr.message}` }
  }

  emit('Stopping running Ollama…')
  await ollamaManager.stopServer().catch(() => null)
  // Force-kill stragglers — the menu-bar .app launches `ollama serve` as a child
  // that doesn't always exit cleanly via the service stop above.
  await runStreaming('pkill', ['-x', 'Ollama'], () => {}, 10_000).catch(() => null)
  await runStreaming('pkill', ['-x', 'ollama'], () => {}, 10_000).catch(() => null)
  // Brief settle so the OS releases the bundle before we replace it.
  await sleep(1500)

  emit('Extracting…')
  const unzip = await runStreaming('unzip', ['-q', '-o', zipPath, '-d', tmpDir], emit, 5 * 60 * 1000)
  if (!unzip.success) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: `Extract failed: ${unzip.error}` }
  }
  const extractedApp = join(tmpDir, 'Ollama.app')
  if (!(await pathExists(extractedApp))) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: 'Extracted archive did not contain Ollama.app — release layout may have changed.' }
  }

  emit('Installing /Applications/Ollama.app…')
  // rm the old bundle first — `mv` can't merge with an existing directory on macOS.
  await rm(appPath, { recursive: true, force: true }).catch(() => {})
  const move = await runStreaming('mv', [extractedApp, appPath], emit, 60_000)
  if (!move.success) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: `Could not install ${appPath}: ${move.error}. PortOS may not have permission to write to /Applications — try running the official installer manually.` }
  }
  // Strip quarantine so Gatekeeper doesn't refuse to launch the freshly-downloaded bundle.
  await runStreaming('xattr', ['-dr', 'com.apple.quarantine', appPath], () => {}, 30_000).catch(() => null)
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})

  emit('Starting Ollama…')
  const launch = await runStreaming('open', ['-g', '-a', appPath], () => {}, 30_000)
  if (!launch.success) {
    return {
      success: true,
      backend: 'ollama',
      note: `Upgraded to ${release.tag_name}, but couldn't auto-launch Ollama (${launch.error}). Open Ollama.app manually.`
    }
  }
  const after = await waitForOllamaVersion(30_000)
  if (!after) {
    return {
      success: true,
      backend: 'ollama',
      note: `Upgraded to ${release.tag_name}, but Ollama did not come back online within 30s. Open Ollama.app if it isn't already running.`
    }
  }
  console.log(`⬆️ Upgraded Ollama: ${before || 'unknown'} → ${after} (${release.tag_name})`)
  return { success: true, backend: 'ollama', note: `Ollama ${before ? `${before} → ` : ''}${after}. The new binary is now serving requests.` }
}

/**
 * Upgrade an already-installed backend in place. Used when a model pull returns
 * Ollama's 412 "requires a newer version of Ollama" error.
 *
 * macOS Ollama is special: even when Homebrew has a recent enough formula, the
 * .app binary is what `ollama serve` actually runs (via the symlink at
 * `/usr/local/bin/ollama` → `/Applications/Ollama.app/Contents/Resources/ollama`),
 * so a brew-only upgrade leaves the OLD binary serving. So we prefer a direct
 * download + .app replacement on macOS whenever the .app is present. Other paths:
 *
 *   • macOS LM Studio cask → `brew upgrade --cask lm-studio`
 *   • macOS Ollama brew formula (no .app) → `brew upgrade ollama`
 *   • Linux Ollama → re-run the official install script (idempotent upgrade)
 *
 * @param {string} backend - 'ollama' | 'lmstudio'
 * @param {(p: { event: string, message: string }) => void} [onProgress]
 */
export async function upgradeBackend(backend, onProgress = () => {}) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  const emit = (message) => onProgress({ event: 'start', message })
  const label = backend === 'ollama' ? 'Ollama' : 'LM Studio'
  const downloadHint = `Download the latest version from ${DOWNLOAD_URL[backend]}.`

  // Linux Ollama: the official install script is also the upgrade path.
  if (process.platform === 'linux' && backend === 'ollama') {
    emit('Upgrading Ollama via the official install script…')
    const r = await runStreaming('bash', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], emit, BACKEND_INSTALL_TIMEOUT_MS)
    if (!r.success) {
      console.error(`⚠️ Ollama upgrade (linux script) failed: ${r.error}`)
      return { success: false, error: `Ollama upgrade failed: ${r.error}. ${downloadHint}` }
    }
    console.log('⬆️ Upgraded Ollama (linux script)')
    return { success: true, backend }
  }

  if (process.platform !== 'darwin') {
    return { success: false, error: `Automatic upgrade isn't supported on this platform. ${downloadHint}` }
  }

  // macOS Ollama with a .app present — direct download is the only path that
  // actually replaces the binary that's serving requests.
  if (backend === 'ollama' && await pathExists(macAppPath('ollama'))) {
    return upgradeOllamaMacApp(emit)
  }

  // Everything else: route through Homebrew.
  const source = await detectInstallSource(backend)
  if (source.source === 'mac-app') {
    // LM Studio .app — Sparkle handles updates; brew doesn't know about it.
    return {
      success: false,
      manualUpdateRequired: true,
      error: `LM Studio was installed from the official .app, which has its own updater — PortOS can't drive it from here. Open LM Studio → Settings → "Check for updates", or ${downloadHint.toLowerCase()}`
    }
  }
  if (source.source === 'unknown') {
    return { success: false, error: `Couldn't identify how ${label} was installed. ${downloadHint}` }
  }
  if (!(await commandExists('brew', ['--version']))) {
    return { success: false, error: `Homebrew not found — install it from https://brew.sh first, or ${downloadHint.toLowerCase()}` }
  }
  emit(`Upgrading ${label} via Homebrew (${source.packageName}) — this can take a few minutes…`)
  const r = await runStreaming('brew', source.upgradeArgs, emit, BACKEND_INSTALL_TIMEOUT_MS)
  if (!r.success) {
    console.error(`⚠️ ${label} upgrade via brew ${source.upgradeArgs.join(' ')} failed: ${r.error}`)
    return { success: false, error: `Homebrew upgrade failed: ${r.error}` }
  }
  console.log(`🍺 Upgraded ${label} via Homebrew (${source.source})`)
  if (backend === 'ollama') {
    const stop = await ollamaManager.stopPersistentService().catch((err) => ({ success: false, error: err.message }))
    const restart = await ollamaManager.startPersistentService().catch((err) => ({ success: false, error: err.message }))
    const note = restart.success
      ? 'Restarted Ollama service so the new binary is now serving requests.'
      : `Upgraded, but PortOS could not restart the Ollama service (${restart.error || stop.error}). Restart it from the Local LLMs tab.`
    return { success: true, backend, note }
  }
  return { success: true, backend, note: 'Restart LM Studio so the new binary is loaded.' }
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

// Ollama's /api/show reports capabilities in its own vocabulary
// (completion/tools/vision/embedding/thinking/insert). Map the ones that have
// a home onto the badge vocabulary the Models catalog cards already render
// (CAPABILITY_META in LocalLlmTab.jsx: chat/code/reasoning/vision/embeddings/
// tools/audio) so installed models can show the same icons. Only capabilities
// the daemon actually reported are surfaced — nothing is guessed here.
const OLLAMA_CAPABILITY_BADGES = {
  completion: 'chat',
  tools: 'tools',
  vision: 'vision',
  embedding: 'embeddings',
  thinking: 'reasoning'
}

function ollamaBadgeCapabilities(rawCapabilities) {
  return (Array.isArray(rawCapabilities) ? rawCapabilities : [])
    .map((c) => OLLAMA_CAPABILITY_BADGES[String(c).toLowerCase()])
    .filter(Boolean)
}

// LM Studio's native model list tags each model's `type` (`llm` / `vlm` /
// `embeddings`) — authoritative for chat/vision/embeddings. It reports no
// tool-calling flag, so fall back to the shared id heuristic for `tools`.
function lmStudioBadgeCapabilities(m) {
  const type = m?.type ? String(m.type).toLowerCase() : null
  const caps = type === 'embeddings' ? ['embeddings'] : ['chat']
  if (type === 'vlm') caps.push('vision')
  if (type !== 'embeddings' && isToolUseModel(m?.id)) caps.push('tools')
  return caps
}

/** Normalize each backend's installed-model shape into one card shape. */
function normalizeModels(backend, models) {
  if (backend === 'ollama') {
    return models.map((m) => ({
      id: m.id, name: m.name, size: m.size ?? null,
      params: m.params || null, quantization: m.quantization || null, family: m.family || null,
      contextLength: m.contextLength ?? null,
      // Ollama's /api/tags doesn't tag vision capability, but /api/show does —
      // when the model has been enriched with a `capabilities` array (status
      // path, or the listVisionModels enrichment below) prefer it; otherwise
      // fall back to the id heuristic. Passing the object lets a vision-capable
      // MoE like `qwen3.6:35b` (no `vl`/`vision` token in its id) resolve true.
      vision: isVisionModel(Array.isArray(m.capabilities) ? { id: m.id, capabilities: m.capabilities } : m.id),
      capabilities: ollamaBadgeCapabilities(m.capabilities)
    }))
  }
  return models.map((m) => ({
    id: m.id, name: m.id, size: null,
    params: null, quantization: m.quantization || null, family: m.arch || null,
    contextLength: m.maxContextLength ?? null,
    // LM Studio's native model list tags vision models `type: 'vlm'` — prefer
    // that over the id regex.
    vision: isVisionModel(m),
    capabilities: lmStudioBadgeCapabilities(m)
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
  const [ollamaStatus, ollamaCli, lmStudioStatus, lmsCli, lmStudioModels, latestOllamaVersion] = await Promise.all([
    ollamaManager.getStatus(true),
    commandExists('ollama', ['--version']),
    lmStudioManager.getStatus(),
    commandExists('lms', ['version']),
    // forceRefresh: status/refresh path bypasses the list cache.
    listModels('lmstudio', true).catch(() => []),
    // Cached (6h) — never blocks the steady-state UI on a GitHub round-trip.
    getLatestOllamaVersion().catch(() => null)
  ])

  const ollamaModels = normalizeModels('ollama', ollamaStatus.models)
  const lmStudioRecommendation = recommendEditorialModel(lmStudioModels)
  // An update is "available" only when we know BOTH the installed version (Ollama
  // must be running for /api/version to answer) and the latest, and latest is
  // newer. canUpgrade (canAutoUpgrade) gates the in-app updater to the platforms
  // where upgradeBackend can actually drive an Ollama upgrade.
  const ollamaUpdateAvailable = Boolean(
    ollamaStatus.version && latestOllamaVersion && compareSemver(latestOllamaVersion, ollamaStatus.version) > 0
  )
  return {
    backend: getBackend(),
    ollama: {
      installed: ollamaCli || ollamaStatus.available,
      available: ollamaStatus.available,
      version: ollamaStatus.version,
      latestVersion: latestOllamaVersion,
      updateAvailable: ollamaUpdateAvailable,
      canUpgrade: canAutoUpgrade('ollama'),
      baseUrl: ollamaStatus.baseUrl,
      modelCount: ollamaStatus.modelCount,
      models: ollamaModels,
      // Best installed model for editorial review/editing, surfaced so the
      // manuscript editor can suggest it (and warn against the embedding model).
      recommendations: { editorial: recommendEditorialModel(ollamaModels) },
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
      recommendations: { editorial: lmStudioRecommendation },
      // Non-null when LM Studio answered the availability probe but the model
      // list call failed — lets the UI tell "0 models" from "couldn't list".
      modelsError: lmStudioManager.getLastListError(),
      canAutoInstall: canAutoInstall('lmstudio'),
      downloadUrl: DOWNLOAD_URL.lmstudio
    }
  }
}

/**
 * Vision-capable installed models across both local backends, tagged with the
 * aiToolkit provider id (`ollama` / `lmstudio`) that serves them, PLUS
 * vision-capable CLI providers (codex / claude-code) whose model reads images
 * via a file. Powers the caption-model picker and the captioner's
 * auto-resolution of a default vision model. Each entry:
 * `{ providerId, backend, id, name, vision: true }`.
 */
export async function listVisionModels() {
  // Cache-first for both backends (the model-list caches are busted on
  // install/delete, so they stay accurate) — the picker doesn't need a forced
  // round-trip on every dataset-page load.
  const [ollama, lmstudio] = await Promise.all([
    listModels('ollama').catch(() => []),
    listModels('lmstudio').catch(() => [])
  ])
  // Ollama's /api/tags carries no vision flag, so the normalized `vision` above
  // is id-regex only — it misses vision-capable models whose id has no
  // `vl`/`vision` token (e.g. the `qwen3.6:35b` MoE). For each not already
  // matched, consult /api/show capabilities (cached per model) so they surface
  // in the picker. Models the id heuristic already caught skip the round-trip.
  const ollamaVision = await Promise.all(ollama.map(async (m) => {
    if (m.vision) return m
    const capabilities = await ollamaManager.getModelCapabilities(m.id).catch(() => [])
    return { ...m, vision: isVisionModel({ id: m.id, capabilities }) }
  }))
  const tag = (backend, models) => models
    .filter((m) => m.vision)
    .map((m) => ({ providerId: PROVIDER_ID[backend], backend, id: m.id, name: m.name || m.id, vision: true }))
  return [
    ...tag('ollama', ollamaVision),
    ...tag('lmstudio', lmstudio),
    ...await listVisionCliModels(),
  ]
}

/**
 * Vision-capable CLI providers (codex / claude-code), expanded to one entry per
 * configured model so the caption picker can offer e.g. "codex / gpt-5" or
 * "claude-code / claude-opus-4-8". A disabled provider is skipped. Each entry
 * mirrors the local-backend shape with `backend: 'cli'`. Best-effort: a load
 * failure yields no CLI entries rather than breaking the whole picker.
 */
async function listVisionCliModels() {
  const { providers } = await getAllProviders().catch(() => ({ providers: [] }))
  const entries = []
  for (const p of providers || []) {
    if (p.enabled === false) continue
    if (!isVisionCapableCliProvider(p)) continue
    const models = Array.isArray(p.models) && p.models.length ? p.models : [p.defaultModel].filter(Boolean)
    for (const id of models) {
      entries.push({ providerId: p.id, backend: 'cli', id, name: `${p.name || p.id} / ${id}`, vision: true })
    }
  }
  return entries
}

// ---- install / delete --------------------------------------------------------

/**
 * Push a live model-list refresh to every provider backed by the Ollama daemon,
 * so an install/delete on the Local LLMs tab is immediately reflected in every
 * provider/model picker (task scheduler, pipeline stages, etc.) without the user
 * having to find and click "Refresh Models" on the AI Providers page. Fire-and-
 * forget from the caller's perspective — the install/delete response shouldn't
 * wait on an extra round-trip to Ollama per matching provider. Best-effort per
 * provider — one failing refresh (e.g. Ollama briefly unreachable mid-pull)
 * must not block the others.
 */
function refreshOllamaBackedProviders() {
  getAllProviders().then(({ providers }) => {
    const targets = (providers || []).filter(isOllamaBackedProvider)
    return Promise.all(targets.map((p) => refreshProviderModels(p.id).catch((err) => {
      console.error(`⚠️ Failed to refresh models for provider ${p.id} after Ollama model change: ${err.message}`)
    })))
  }).catch((err) => {
    console.error(`⚠️ Failed to list providers for post-install Ollama refresh: ${err.message}`)
  })
}

/**
 * Install (pull/download) a model on a backend.
 * @param {(p) => void} [onProgress] - streaming progress (Ollama only)
 */
export async function installModel(backend, modelId, onProgress) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  if (backend === 'ollama') {
    const result = await ollamaManager.pullModel(modelId, onProgress)
    if (result.success) refreshOllamaBackedProviders()
    return result
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
    const result = await ollamaManager.deleteModel(modelId)
    if (result.success) refreshOllamaBackedProviders()
    return result
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
  await writeBackend(to)
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
