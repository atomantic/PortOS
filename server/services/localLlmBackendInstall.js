/**
 * Installs and updates the Ollama and LM Studio runtimes and resolves their release channels.
 */

import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { rename, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { fileURLToPath } from 'url'
import { commandExists } from '../lib/commandExists.js'
import { ensureDir, pathExists, sleep } from '../lib/fileUtils.js'
import { isBackend } from '../lib/localLlmCatalog.js'
import { whichFirst } from '../lib/processEnv.js'
import { runStreamingCommand } from '../lib/streamingSpawn.js'
import { compareSemver } from '../lib/versionUtils.js'
import * as ollamaManager from './ollamaManager.js'

// Backend (app/binary) installs go through a package manager and can pull a
// large cask; bound them so a wedged installer can't hang the request forever.
const BACKEND_INSTALL_TIMEOUT_MS = 30 * 60 * 1000

export const DOWNLOAD_URL = { ollama: 'https://ollama.com/download', lmstudio: 'https://lmstudio.ai/download' }

// Which (platform, backend) pairs PortOS can install automatically. macOS uses
// Homebrew for both; Linux has an official Ollama script but no clean LM Studio
// CLI install; Windows is download-only.
export function canAutoInstall(backend) {
  if (process.platform === 'darwin') return true
  if (process.platform === 'linux') return backend === 'ollama'
  return false
}

// Which (platform, backend) pairs PortOS can UPGRADE in place. This is NOT the
// same as canAutoInstall: LM Studio installs via the Homebrew cask on macOS but
// self-updates through Sparkle, which PortOS can't drive (upgradeBackend returns
// manualUpdateRequired for it). Only Ollama has a PortOS-driven upgrade path
// (direct .app download on macOS, brew formula / official script otherwise).
export function canAutoUpgrade(backend) {
  if (backend !== 'ollama') return false
  return process.platform === 'darwin' || process.platform === 'linux'
}

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

// `runStreaming` moved to lib/streamingSpawn.js — the one-click local-runtime
// setup flow needs the same line-streamed spawn (see localRuntimeSetup.js).
const runStreaming = (cmd, args, onLine, timeoutMs = 0) => runStreamingCommand(cmd, args, onLine, { timeoutMs })

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
    const r = await runStreaming('bash', [fileURLToPath(new URL('../../scripts/install-ollama.sh', import.meta.url))], emit, BACKEND_INSTALL_TIMEOUT_MS)
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

// Homebrew's API is a CDN with no rate limit, so it can be read more often, and an
// update Homebrew just published should not wait out the GitHub TTL to appear.
const HOMEBREW_VERSION_TTL_MS = 60 * 60 * 1000
let homebrewOllamaCache = { version: null, fetchedAt: 0 }

async function getHomebrewOllamaVersion(channel) {
  const age = Date.now() - homebrewOllamaCache.fetchedAt
  if (homebrewOllamaCache.version && age < HOMEBREW_VERSION_TTL_MS) return homebrewOllamaCache.version
  if (!homebrewOllamaCache.version && homebrewOllamaCache.fetchedAt && age < LATEST_VERSION_ERROR_TTL_MS) return null
  const { fetchHomebrewLatestVersion } = await import('../lib/homebrewPackage.js')
  const version = await fetchHomebrewLatestVersion(channel).catch(() => null)
  homebrewOllamaCache = { version, fetchedAt: Date.now() }
  return version
}

/**
 * The Homebrew package upgradeBackend would upgrade, or null when it would take
 * another route. Mirrors its routing: Linux runs the official script and a present
 * Ollama.app is replaced from GitHub, even for the `ollama-app` cask. A third-party
 * tap can share its name with an unrelated homebrew-core formula, so it is not asked.
 */
async function getOllamaHomebrewChannel() {
  if (process.platform !== 'darwin' || await pathExists(macAppPath('ollama'))) return null
  const { homebrewPackageFor } = await import('../lib/homebrewPackage.js')
  const channel = homebrewPackageFor(await whichFirst('ollama').catch(() => null))
  return channel && !channel.thirdPartyTap ? channel : null
}

/**
 * The newest version this copy's updater can install. A Homebrew copy compares
 * against Homebrew, because `brew upgrade` cannot deliver a GitHub release Homebrew
 * has not published. GitHub stays the answer when Homebrew cannot say.
 */
export async function resolveLatestOllamaVersion() {
  const [upstream, channel] = await Promise.all([
    // Cached — never blocks the steady-state UI on a GitHub round-trip.
    getLatestOllamaVersion().catch(() => null),
    getOllamaHomebrewChannel().catch(() => null),
  ])
  const brew = channel ? await getHomebrewOllamaVersion(channel) : null
  if (!brew) return { latestVersion: upstream, latestVersionSource: upstream ? 'github' : null, upstreamAheadVersion: null, installChannel: channel }
  return {
    latestVersion: brew,
    latestVersionSource: 'homebrew',
    upstreamAheadVersion: upstream && compareSemver(upstream, brew) > 0 ? upstream : null,
    installChannel: channel,
  }
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
 *
 * The swap is STAGED: the existing bundle is renamed to `<app>.portos-old-<ts>`
 * and only removed once the replacement is verifiably a directory at the real
 * path, so any failure downstream rolls back to the working install instead of
 * leaving the machine with no Ollama at all. It then verifies the RUNNING
 * version advanced, because a second install ahead of the bundle on PATH can
 * keep serving the old binary past a perfectly successful swap.
 */
const DOWNLOAD_HEADER_TIMEOUT_MS = 30_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

/**
 * Download `url` to `destPath` with stall detection instead of a total
 * deadline (which would abort slow-but-progressing links): the response headers
 * must arrive within `headerMs`, then every body chunk resets an idle timer that
 * aborts after `idleMs` without bytes. `signal` aborts early (client gone).
 * Resolves `{ error }` on any failure, `{ sha256 }` (hex digest of the bytes
 * written) on success — never throws.
 */
async function downloadWithStallGuard(url, destPath, signal, { headerMs = DOWNLOAD_HEADER_TIMEOUT_MS, idleMs = DOWNLOAD_IDLE_TIMEOUT_MS } = {}) {
  const ac = new AbortController()
  let stall = null
  let timer = null
  const arm = (ms, message) => {
    clearTimeout(timer)
    timer = setTimeout(() => { stall = message; ac.abort() }, ms)
  }
  const onExternalAbort = () => ac.abort()
  if (signal?.aborted) return { error: 'Download cancelled.' }
  signal?.addEventListener('abort', onExternalAbort, { once: true })
  try {
    arm(headerMs, `Download stalled — no response from the server within ${Math.round(headerMs / 1000)} s. Check the connection and retry.`)
    const dl = await fetch(url, { signal: ac.signal })
    if (!dl?.ok || !dl.body) return { error: `Download failed: ${dl?.statusText || 'no response body'}` }
    const idleMessage = `Download stalled — no data for ${Math.round(idleMs / 1000)} s. Check the connection and retry.`
    arm(idleMs, idleMessage)
    const hash = createHash('sha256')
    const touch = new Transform({ transform(chunk, _enc, cb) { arm(idleMs, idleMessage); hash.update(chunk); cb(null, chunk) } })
    await pipeline(Readable.fromWeb(dl.body), touch, createWriteStream(destPath), { signal: ac.signal })
    return { sha256: hash.digest('hex') }
  } catch (err) {
    if (stall) return { error: stall }
    if (signal?.aborted) return { error: 'Download cancelled.' }
    return { error: `Download failed: ${err.message}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}

const OLLAMA_RELEASE_DOWNLOAD_PREFIX = 'https://github.com/ollama/ollama/releases/download/'
// Apple Developer Team ID that signs official Ollama.app releases.
const OLLAMA_TEAM_ID = '3MU9H2V9Y9'

// Trusted SHA-256 for a release asset: GitHub's `asset.digest` ("sha256:<hex>"),
// else the release's `sha256sum.txt` asset. Returns null when neither yields one
// so the caller fails closed.
async function resolveOllamaAssetDigest(release, asset) {
  const fromApi = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''))
  if (fromApi) return fromApi[1].toLowerCase()
  const sums = (release.assets || []).find((a) => a.name === 'sha256sum.txt')
  if (!sums?.browser_download_url?.startsWith(OLLAMA_RELEASE_DOWNLOAD_PREFIX)) return null
  const text = await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(15000) })
    .then((r) => (r.ok ? r.text() : ''), () => '')
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)$/i.exec(line.trim())
    if (m && m[2] === asset.name) return m[1].toLowerCase()
  }
  return null
}

// Verify the extracted bundle's code signature and that it is signed by Ollama's
// Team ID. Returns an error string, or null when trusted.
async function verifyOllamaBundleSignature(bundlePath) {
  const verify = await runStreaming('codesign', ['--verify', '--deep', '--strict', bundlePath], () => {}, 120_000)
  if (!verify.success) return `codesign verification failed: ${verify.error}`
  const lines = []
  // `codesign -dv` writes its report to stderr; runStreaming merges both streams.
  await runStreaming('codesign', ['-dv', '--verbose=2', bundlePath], (l) => lines.push(l), 30_000)
  const team = lines.map((l) => /^TeamIdentifier=(\S+)/.exec(l.trim())?.[1]).find(Boolean)
  if (team !== OLLAMA_TEAM_ID) return `unexpected code-signing TeamIdentifier (${team || 'none'})`
  return null
}

async function upgradeOllamaMacApp(emit, signal) {
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

  if (!asset.browser_download_url.startsWith(OLLAMA_RELEASE_DOWNLOAD_PREFIX)) {
    return { success: false, error: `Refusing to download Ollama-darwin.zip from an unexpected origin; try ${DOWNLOAD_URL.ollama}.` }
  }
  const expectedSha256 = await resolveOllamaAssetDigest(release, asset)
  if (!expectedSha256) {
    return { success: false, error: `Release ${release.tag_name} publishes no SHA-256 digest for Ollama-darwin.zip, so it cannot be verified and the upgrade was not attempted. Install from ${DOWNLOAD_URL.ollama}.` }
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
  const dl = await downloadWithStallGuard(asset.browser_download_url, zipPath, signal)
  if (dl.error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: dl.error }
  }
  if (dl.sha256 !== expectedSha256) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: 'Downloaded Ollama-darwin.zip failed SHA-256 verification; discarded it and left your install untouched.' }
  }

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

  emit('Verifying code signature…')
  const sigError = await verifyOllamaBundleSignature(extractedApp)
  if (sigError) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: `Downloaded Ollama.app failed signature verification (${sigError}); your install was left untouched.` }
  }

  emit('Stopping running Ollama…')
  await ollamaManager.stopServer().catch(() => null)
  // Force-kill stragglers — the menu-bar .app launches `ollama serve` as a child
  // that doesn't always exit cleanly via the service stop above.
  await runStreaming('pkill', ['-x', 'Ollama'], () => {}, 10_000).catch(() => null)
  await runStreaming('pkill', ['-x', 'ollama'], () => {}, 10_000).catch(() => null)
  // Brief settle so the OS releases the bundle before we replace it.
  await sleep(1500)

  emit('Installing /Applications/Ollama.app…')
  // Stage-and-swap: move the existing bundle ASIDE rather than deleting it. `mv`
  // still can't merge with an existing directory on macOS, so the destination has
  // to be cleared first — but an `rm` there means a failed `mv` (timeout, ENOSPC,
  // an MDM/SIP policy on /Applications) leaves the user with no Ollama at all.
  // The aside copy is the rollback. Its failure is NOT swallowed either: a
  // straggler holding the bundle open makes `rename` fail, and continuing would
  // let `mv` nest the new bundle INSIDE the surviving old one and exit 0.
  const asidePath = `${appPath}.portos-old-${Date.now()}`
  const asideErr = await rename(appPath, asidePath).then(() => null, (err) => err)
  if (asideErr && asideErr.code !== 'ENOENT') {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { success: false, error: `Could not move the existing ${appPath} aside (${asideErr.message}), so the upgrade was not attempted and your current Ollama install is untouched. Quit Ollama completely and retry, or install the official app from ${DOWNLOAD_URL.ollama}.` }
  }
  // ENOENT above just means nothing was installed here — there is no rollback copy.
  const movedAside = !asideErr
  const move = await runStreaming('mv', [extractedApp, appPath], emit, 60_000)
  // The destination was verifiably absent, so a nested Ollama.app/Ollama.app is
  // impossible — assert the installed path really is a bundle directory anyway,
  // since everything downstream (quarantine strip, launch) trusts it.
  const installed = move.success && await stat(appPath).then((s) => s.isDirectory(), () => false)
  if (!installed) {
    // Whatever is at appPath now (nothing, a half-copied cross-device `mv`, or a
    // non-directory) is not a usable bundle, and it is never the user's working
    // install — that was renamed aside. Clear it unconditionally so the restore
    // can't fail on a non-empty destination, which is the exact data loss this
    // staging exists to prevent.
    await rm(appPath, { recursive: true, force: true }).catch(() => {})
    const restoreErr = movedAside ? await rename(asidePath, appPath).then(() => null, (err) => err) : null
    const restored = !movedAside
      ? ''
      : restoreErr
        ? ` Your previous Ollama install could NOT be restored (${restoreErr.message}) — it is at ${asidePath}, move it back to ${appPath} by hand.`
        : ' Your previous Ollama install has been restored.'
    // Keep tmpDir: the downloaded bundle is the user's only way to finish by hand.
    const leftover = (await pathExists(extractedApp)) ? ` The downloaded bundle is still at ${extractedApp} if you want to move it into place yourself.` : ''
    const why = move.success ? `${appPath} is not a directory after the move` : move.error
    return { success: false, error: `Could not install ${appPath}: ${why}.${restored}${leftover} PortOS may not have permission to write to /Applications — try running the official installer manually.` }
  }
  if (movedAside) await rm(asidePath, { recursive: true, force: true }).catch(() => {})
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
  // Verify the version actually moved — same check the Homebrew path below runs,
  // and for the same reason: a second Ollama install ahead of the bundle on PATH
  // can keep serving the old binary, so a swapped .app is not proof of upgrade.
  if ((tagClean && compareSemver(tagClean, after) > 0) || (!tagClean && (!before || compareSemver(after, before) <= 0))) {
    return {
      success: false,
      backend: 'ollama',
      error: `Installed ${appPath} (${release.tag_name}), but the Ollama serving requests is still ${after}${before ? ` (was ${before})` : ''}. Another Ollama installation may be ahead of the app bundle on your PATH. Quit Ollama completely, relaunch it from ${appPath}, or install the official app from ${DOWNLOAD_URL.ollama}.`
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
 * @param {AbortSignal} [signal] - aborts an in-flight Ollama.app download (client disconnect)
 */
export async function upgradeBackend(backend, onProgress = () => {}, signal) {
  if (!isBackend(backend)) return { success: false, error: `Unknown backend: ${backend}` }
  const emit = (message) => onProgress({ event: 'start', message })
  const label = backend === 'ollama' ? 'Ollama' : 'LM Studio'
  const downloadHint = `Download the latest version from ${DOWNLOAD_URL[backend]}.`

  // Linux Ollama: the official install script is also the upgrade path.
  if (process.platform === 'linux' && backend === 'ollama') {
    emit('Upgrading Ollama via the official install script…')
    const r = await runStreaming('bash', [fileURLToPath(new URL('../../scripts/install-ollama.sh', import.meta.url))], emit, BACKEND_INSTALL_TIMEOUT_MS)
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
    return upgradeOllamaMacApp(emit, signal)
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
  const before = backend === 'ollama' ? await readOllamaVersion() : null
  // Homebrew is the verification target, read past its cache: `brew update` below
  // can only make the answer newer, and a stale one would under-report an upgrade.
  if (backend === 'ollama') homebrewOllamaCache = { version: null, fetchedAt: 0 }
  const { latestVersion: target, latestVersionSource: targetSource, upstreamAheadVersion: upstreamAhead } = backend === 'ollama'
    ? await resolveLatestOllamaVersion()
    : { latestVersion: null, latestVersionSource: null, upstreamAheadVersion: null }
  emit('Refreshing Homebrew package metadata…')
  const refresh = await runStreaming('brew', ['update'], emit, BACKEND_INSTALL_TIMEOUT_MS)
  if (!refresh.success) return { success: false, error: `Homebrew refresh failed: ${refresh.error}` }
  emit(`Upgrading ${label} via Homebrew (${source.packageName}) — this can take a few minutes…`)
  const r = await runStreaming('brew', source.upgradeArgs, emit, BACKEND_INSTALL_TIMEOUT_MS)
  if (!r.success) {
    console.error(`⚠️ ${label} upgrade via brew ${source.upgradeArgs.join(' ')} failed: ${r.error}`)
    return { success: false, error: `Homebrew upgrade failed: ${r.error}` }
  }
  console.log(`🍺 Homebrew upgrade command completed for ${label} (${source.source})`)
  if (backend === 'ollama') {
    const stop = await ollamaManager.stopPersistentService().catch((err) => ({ success: false, error: err.message }))
    const restart = await ollamaManager.startPersistentService().catch((err) => ({ success: false, error: err.message }))
    if (!restart.success) {
      return { success: false, backend, error: `Could not verify the Ollama upgrade because its service could not restart (${restart.error || stop.error}). Restart it from the Local LLMs tab.` }
    }
    const after = await waitForOllamaVersion()
    if (!after) return { success: false, backend, error: 'Could not verify the Ollama upgrade: the service did not come back online within 30s.' }
    const moved = Boolean(before) && compareSemver(after, before) > 0
    if ((target && compareSemver(target, after) > 0) || (!target && !moved)) {
      // Homebrew already has the target, so waiting for it cannot help here.
      const cause = targetSource === 'homebrew'
        ? 'Homebrew has published it, so the service may not have restarted on the new binary, or another Ollama installation may be serving requests. Restart Ollama and check which one is running'
        : 'Homebrew may not have packaged the latest release yet, or another Ollama installation may be serving requests. Retry when Homebrew catches up'
      return {
        success: false,
        backend,
        error: `Ollama is still running ${after}${target ? `; the available release is ${target}` : '; no newer running version was verified'}. ${cause}, or install the official app from ${DOWNLOAD_URL.ollama}.`
      }
    }
    // Already on Homebrew's newest with a newer release out: this run delivered
    // nothing, and the caller may need that release (a model pull's 412 upgrade).
    if (!moved && upstreamAhead && compareSemver(upstreamAhead, after) > 0) {
      return {
        success: false,
        backend,
        error: `Ollama ${after} is the newest Homebrew has published. Ollama ${upstreamAhead} is out, and Homebrew can install it once it is packaged. Retry then, or install the official app from ${DOWNLOAD_URL.ollama}.`
      }
    }
    return { success: true, backend, note: `Ollama ${before ? `${before} → ` : ''}${after}. The verified binary is now serving requests.` }
  }
  return { success: true, backend, note: 'Restart LM Studio so the new binary is loaded.' }
}
