/**
 * Curated Hugging Face Safetensors import for Ollama (single caller:
 * localLlm.js), split out of ollamaManager.js: the supervised `ollama create` child and the staged-checkpoint directory it
 * reads from.
 *
 * Neither the Ollama CLI nor its HTTP client puts a deadline on `create`, so a
 * wedged CLI/daemon pair would hold the install request forever. The supervisor
 * bounds SILENCE, not wall time: a conversion that keeps printing new progress,
 * or keeps growing the daemon's blob store, may run as long as it needs.
 *
 * Killing the CLI does not prove the daemon stopped reading the staged files,
 * so the staging directory is deleted only after an open-file probe shows no
 * other process holds any of it. When that cannot be shown the directory is
 * kept, its marker file (the durable recovery record — it lives and dies with
 * the staging it describes) is stamped `retained`, and the next install of the
 * same model reuses it instead of downloading again.
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises'
import { spawn } from '../lib/childProcess.js'
import { atomicWrite, safeJSONParse, sleep } from '../lib/fileUtils.js'
import { killWithEscalation } from '../lib/killWithEscalation.js'
import { findOpenFileHolders } from '../lib/openFileHolders.js'
import { createWriteStream } from 'fs'
import { dirname } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { describeFetchError } from '../lib/fetchErrorChain.js'
import { ensureDir } from '../lib/fileUtils.js'
import { buildHfAuthHeaders, buildHfResolveUrl, HF_API } from '../lib/huggingfaceLora.js'
import { commandExists } from '../lib/commandExists.js'
import { compareSemver } from '../lib/versionUtils.js'
import { isSafeHfRepoRelativePath } from '../lib/hfCache.js'
import { assessDownloadPreflight, diskInsufficientError, DOWNLOAD_VERDICTS } from '../lib/downloadPreflight.js'
import { checkOllamaAvailable, getVersion, getModelsDir, bustInstalledModelsCache } from './ollamaManager.js'

const HF_IMPORT_METADATA_TIMEOUT_MS = 180_000
// Model ids with a Safetensors import running in this process.
const activeImports = new Set()
const STAGING_PREFIX = 'portos-ollama-hf-import-'
const MARKER_NAME = 'portos-import.json'
const CREATE_IDLE_LIMIT_MS = 10 * 60_000
const CREATE_CHECK_INTERVAL_MS = 15_000
const CREATE_KILL_GRACE_MS = 10_000
// After SIGKILL a live child exits within milliseconds; still being there this
// long later means PortOS cannot claim the operation ended.
const CREATE_EXIT_BOUND_MS = 30_000
const RELEASE_PROBE_ATTEMPTS = 4
const RELEASE_PROBE_DELAY_MS = 15_000
const OUTPUT_TAIL_CHARS = 8_192
const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const SEEN_LINES_CAP = 5_000

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
const SPINNER_RE = /[⠀-⣿]/g
// Ollama's progress bar redraws a transfer rate and ETA on every tick even when
// nothing moves; those must not count as progress.
const RATE_RE = /\b\d+(?:\.\d+)?\s?[KMGT]?i?B\/s\b/gi
const DURATION_RE = /\b(?:\d+h)?(?:\d+m)?\d+(?:\.\d+)?(?:ms|s)\b|\b\d+h\d+m\b|\b\d+m\b/g

/** Complete output segments, reduced to the text that changes only on real progress. */
function normalizeCreateOutput(text) {
  return String(text).replace(ANSI_RE, '').split(/[\r\n]+/)
    .map((line) => line.replace(SPINNER_RE, '').replace(RATE_RE, '').replace(DURATION_RE, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function lastErrorLine(tail) {
  const lines = normalizeCreateOutput(tail)
  return lines.reverse().find((line) => /error/i.test(line)) || lines[0] || null
}

/** Size signature of the daemon's blob store — grows while the daemon writes a converted layer. */
export async function blobStoreSignature(modelsDir) {
  const dir = join(modelsDir, 'blobs')
  const names = await readdir(dir).catch(() => null)
  if (!names) return null
  let bytes = 0
  for (const name of names) bytes += await stat(join(dir, name)).then((s) => s.size, () => 0)
  return `${names.length}:${bytes}`
}

/**
 * Run `ollama create` until it exits, or until neither its output nor
 * `probeProgress()` has changed for `idleLimitMs`, in which case the child is
 * stopped (SIGTERM, then SIGKILL). Always resolves, exactly once:
 *   { status: 'completed' } | { status: 'failed', error } |
 *   { status: 'stalled', error, exited } — `exited: false` means the child
 *   outlived SIGKILL and PortOS cannot claim the operation ended.
 */
export function runSupervisedOllamaCreate({
  modelId, modelfile, onStatus, probeProgress,
  idleLimitMs = CREATE_IDLE_LIMIT_MS, checkIntervalMs = CREATE_CHECK_INTERVAL_MS
}) {
  return new Promise((resolve) => {
    const child = spawn('ollama', ['create', modelId, '-f', modelfile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    let exited = false
    let stalled = false
    let probing = false
    let lastProgressAt = Date.now()
    let lastSignature
    let partial = ''
    let tail = ''
    let exitTimer = null
    let interval = null
    const seen = new Set()
    const idleMinutes = Math.round(idleLimitMs / 60_000)
    const stallError = `Ollama stopped reporting progress while importing ${modelId} (nothing for ${idleMinutes} min), so PortOS stopped the import.`

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(exitTimer)
      resolve(outcome)
    }
    const onOutput = (chunk) => {
      const text = partial + chunk.toString()
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)
      // Only judge complete segments, so a redraw split across two chunks
      // cannot masquerade as a new line.
      const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
      partial = text.slice(cut + 1).slice(-OUTPUT_TAIL_CHARS)
      for (const line of normalizeCreateOutput(text.slice(0, cut + 1))) {
        if (seen.has(line)) continue
        if (seen.size >= SEEN_LINES_CAP) seen.clear()
        seen.add(line)
        lastProgressAt = Date.now()
        try { onStatus?.(line) } catch (err) { console.error(`❌ ollama create progress handler failed: ${err.message}`) }
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.on('error', (err) => {
      exited = true
      finish({ status: 'failed', error: `Could not run ollama create: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      exited = true
      if (stalled) return finish({ status: 'stalled', error: stallError, exited: true })
      if (code === 0) return finish({ status: 'completed' })
      finish({ status: 'failed', error: lastErrorLine(tail + partial) || `ollama create exited with ${code ?? signal}` })
    })

    const tick = async () => {
      if (stalled || exited || probing) return
      probing = true
      const signature = await Promise.resolve(probeProgress?.()).catch(() => null).finally(() => { probing = false })
      if (signature != null && signature !== lastSignature) {
        if (lastSignature !== undefined) lastProgressAt = Date.now()
        lastSignature = signature
      }
      if (stalled || exited || Date.now() - lastProgressAt < idleLimitMs) return
      stalled = true
      console.warn(`⚠️ ollama create ${modelId} made no progress for ${idleMinutes} min — stopping it`)
      killWithEscalation(child, { label: `ollama create ${modelId}`, stillRunning: () => !exited, delayMs: CREATE_KILL_GRACE_MS })
      exitTimer = setTimeout(() => finish({ status: 'stalled', error: stallError, exited: false }), CREATE_KILL_GRACE_MS + CREATE_EXIT_BOUND_MS)
      exitTimer.unref?.()
    }
    interval = setInterval(() => {
      tick().catch((err) => console.error(`❌ ollama create watchdog failed: ${err.message}`))
    }, checkIntervalMs)
    interval.unref?.()
  })
}

const markerPath = (tempRoot) => join(tempRoot, MARKER_NAME)

/** Create a staging directory whose marker names the import it belongs to. */
export async function createImportStaging({ modelId, repo, subdir }) {
  const tempRoot = await mkdtemp(join(tmpdir(), STAGING_PREFIX))
  await atomicWrite(markerPath(tempRoot), JSON.stringify({ modelId, repo, subdir, phase: 'downloading', createdAt: new Date().toISOString() }))
  return tempRoot
}

async function readMarker(tempRoot) {
  const raw = await readFile(markerPath(tempRoot), 'utf8').catch(() => null)
  const marker = raw == null ? null : safeJSONParse(raw, null)
  return marker && typeof marker === 'object' ? marker : null
}

export async function updateImportStaging(tempRoot, fields) {
  const marker = await readMarker(tempRoot)
  await atomicWrite(markerPath(tempRoot), JSON.stringify({ ...marker, ...fields }))
}

async function listImportStaging() {
  const names = await readdir(tmpdir()).catch(() => [])
  const entries = []
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const tempRoot = join(tmpdir(), name)
    const mtimeMs = await stat(tempRoot).then((s) => s.mtimeMs, () => null)
    if (mtimeMs == null) continue
    entries.push({ tempRoot, mtimeMs, marker: await readMarker(tempRoot) })
  }
  return entries
}

function newestByModel(entries) {
  const newest = new Map()
  for (const entry of entries) {
    const id = entry.marker?.modelId
    if (!id) continue
    const current = newest.get(id)
    if (!current || String(entry.marker.createdAt) > String(current.marker.createdAt)) newest.set(id, entry)
  }
  return newest
}

/** Newest staging directory left behind for `modelId`, or null. */
export async function findImportStaging(modelId) {
  return newestByModel(await listImportStaging()).get(modelId) ?? null
}

/**
 * Reclaim staging nobody will reuse: older duplicates for a model, and any
 * directory untouched for `maxAgeMs` (including marker-less ones an older
 * PortOS left after a crash). `modelId`'s newest staging is left to the
 * caller, and models in `activeModelIds` are skipped. Each removal still
 * requires the open-file probe to prove nothing holds the directory.
 */
export async function sweepImportStaging({ modelId, activeModelIds = new Set(), maxAgeMs = STAGING_MAX_AGE_MS, now = Date.now() } = {}) {
  const entries = await listImportStaging()
  const newest = newestByModel(entries)
  for (const entry of entries) {
    const id = entry.marker?.modelId
    if (id && id !== modelId && activeModelIds.has(id)) continue
    const isNewest = id ? newest.get(id) === entry : false
    if (isNewest && id === modelId) continue
    const stampedAt = Date.parse(entry.marker?.retainedAt || entry.marker?.createdAt || '')
    const age = now - (Number.isFinite(stampedAt) ? stampedAt : entry.mtimeMs)
    // An older duplicate is never reused; anything else waits out the age limit.
    const ageGated = isNewest || !entry.marker
    if (ageGated && age <= maxAgeMs) continue
    // The probe's canary is the marker, so a marker-less directory gets one first.
    if (!entry.marker) await updateImportStaging(entry.tempRoot, { phase: 'orphaned' })
    const release = await awaitStagingRelease(entry.tempRoot, { attempts: 1 })
    if (!release.free) continue
    console.log(`🧹 Removing unused Safetensors import staging${id ? ` for ${id}` : ''}`)
    await removeImportStaging(entry.tempRoot)
  }
}

/** True when every expected file is staged at its published size. */
export async function stagedFilesComplete(modelDir, files) {
  for (const file of files) {
    if (!(file.size > 0)) return false
    const size = await stat(join(modelDir, ...file.relativePath.split('/'))).then((s) => s.size, () => -1)
    if (size !== file.size) return false
  }
  return true
}

async function listFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? listFilesRecursive(path) : [path]
  }))
  return nested.flat()
}

/**
 * Wait (bounded) for every other process to let go of the staging directory.
 * @returns {Promise<{ free: true } | { free: false, reason: string, pids?: number[] }>}
 */
export async function awaitStagingRelease(tempRoot, { attempts = RELEASE_PROBE_ATTEMPTS, delayMs = RELEASE_PROBE_DELAY_MS, probe = findOpenFileHolders } = {}) {
  const canary = markerPath(tempRoot)
  const files = (await listFilesRecursive(tempRoot)).filter((path) => path !== canary)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await probe(files, { canary })
    if (!result.known) return { free: false, reason: result.reason }
    if (result.pids.length === 0) return { free: true }
    if (attempt === attempts) return { free: false, reason: `still open in process ${result.pids.join(', ')}`, pids: result.pids }
    await sleep(delayMs)
  }
  return { free: false, reason: 'not probed' }
}

export async function removeImportStaging(tempRoot) {
  await rm(tempRoot, { recursive: true, force: true }).catch((err) => {
    console.error(`❌ Ollama Safetensors import cleanup failed: ${err.message}`)
  })
}

function hfImportError(status, statusText) {
  if (status === 401 || status === 403) {
    return 'Hugging Face denied access. Accept the repository terms, then configure a Hugging Face token in Settings.'
  }
  return `Hugging Face request failed: ${status} ${statusText}`
}

async function downloadHfImportFile({ repo, remotePath, destination, headers, progress }) {
  const url = buildHfResolveUrl(repo, 'main', remotePath)
  try {
    const response = await fetchWithTimeout(url, { headers }, 0)
    if (!response.ok || !response.body) throw new Error(hfImportError(response.status, response.statusText))
    await ensureDir(dirname(destination))
    const tracker = new Transform({
      transform(chunk, _encoding, callback) {
        progress(chunk.length)
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body), tracker, createWriteStream(destination))
  } catch (err) {
    if (!(err instanceof TypeError) || !/^(fetch failed|terminated)$/.test(err.message)) throw err
    throw new Error('Hugging Face checkpoint download was interrupted. Check the connection and retry the installation.', { cause: err })
  }
}

/**
 * Download a curated Hugging Face Safetensors subdirectory and import it through
 * Ollama's supported `ollama create` path. The caller supplies only catalog-owned
 * recipes; arbitrary free-text ids continue through pullModel instead.
 *
 * The create step is supervised (see ollamaSafetensorsImport.js): a silent
 * create resolves `OLLAMA_IMPORT_STALLED`, or `OLLAMA_IMPORT_HELD` with
 * `stagingRetained: true` when PortOS cannot prove nothing still reads the
 * staged checkpoint — a retry then reuses that staging.
 *
 * @param {{ modelId: string, repo: string, subdir: string, minVersion?: string }} spec
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number, importing?: boolean }) => void} [onProgress]
 */
export async function importModelFromHfSafetensors(spec, onProgress) {
  const { modelId } = spec
  // One import per model at a time: a second would mistake the first's live
  // staging for one left behind. Checked before any network round-trip.
  if (activeImports.has(modelId)) {
    return { success: false, error: `${modelId} is already being imported.`, modelId, code: 'OLLAMA_IMPORT_IN_PROGRESS' }
  }
  activeImports.add(modelId)
  try {
    return await prepareSafetensorsImport(spec, onProgress)
  } finally {
    activeImports.delete(modelId)
  }
}

async function prepareSafetensorsImport(spec, onProgress) {
  const { modelId, repo, subdir, minVersion = '0.19.0' } = spec
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  const version = await getVersion()
  if (!version || compareSemver(version.replace(/^v/, ''), minVersion.replace(/^v/, '')) < 0) {
    return {
      success: false,
      error: `This MLX import requires Ollama ${minVersion} or newer${version ? ` (installed: ${version})` : ''}.`,
      modelId,
      code: 'OLLAMA_OUTDATED'
    }
  }
  const { getHfToken } = await import('./hfToken.js')
  const token = await getHfToken()
  if (!token) {
    return {
      success: false,
      error: 'This gated model requires a Hugging Face token. Accept the repository terms, then configure a token in Settings.',
      modelId,
      code: 'HF_TOKEN_REQUIRED'
    }
  }
  if (!(await commandExists('ollama', ['--version']))) {
    return { success: false, error: 'The Ollama CLI is required to import Safetensors models.', modelId }
  }

  const headers = buildHfAuthHeaders(token)
  const metadataUrl = `${HF_API}/${repo}?blobs=true`
  const metadataResponse = await fetchWithTimeout(metadataUrl, { headers }, HF_IMPORT_METADATA_TIMEOUT_MS)
    .catch((err) => ({ _err: describeFetchError(err) }))
  if (metadataResponse._err) return { success: false, error: metadataResponse._err, modelId }
  if (!metadataResponse.ok) {
    return { success: false, error: hfImportError(metadataResponse.status, metadataResponse.statusText), modelId }
  }
  const metadata = await metadataResponse.json().catch(() => null)
  const prefix = `${subdir.replace(/\/+$/, '')}/`
  const files = (metadata?.siblings || [])
    .filter((file) => typeof file.rfilename === 'string' && file.rfilename.startsWith(prefix))
    .map((file) => ({
      remotePath: file.rfilename,
      relativePath: file.rfilename.slice(prefix.length),
      size: Number(file.lfs?.size ?? file.size) || 0
    }))
    .filter((file) => isSafeHfRepoRelativePath(file.relativePath))
  if (!files.some((file) => file.relativePath.endsWith('.safetensors')) || !files.some((file) => file.relativePath === 'config.json')) {
    return { success: false, error: `The ${subdir} checkpoint is incomplete or unavailable on Hugging Face.`, modelId }
  }

  // Resolve-not-throw, like every other failure here. A staging write that
  // throws leaves its marker behind; the next attempt reuses or retires it.
  return runSafetensorsImport({ modelId, repo, subdir, files, headers, onProgress })
    .catch((err) => ({ success: false, error: err.message, modelId }))
}

const heldImportResult = (modelId, error, reason) => ({
  success: false,
  modelId,
  code: 'OLLAMA_IMPORT_HELD',
  stagingRetained: true,
  error: `${error} Ollama may still be reading the downloaded checkpoint (${reason}), so PortOS kept it instead of deleting it. Retry the installation to reuse it without downloading again.`
})

async function runSafetensorsImport({ modelId, repo, subdir, files, headers, onProgress }) {
  let tempRoot = null
  let reuse = false
  // A staging directory from an earlier attempt (a stalled create, or a
  // PortOS restart mid-import) is reused when it holds the whole checkpoint;
  // an incomplete one is retired only once nothing holds it open.
  await sweepImportStaging({ modelId, activeModelIds: activeImports })
    .catch((err) => console.error(`❌ Safetensors staging sweep failed: ${err.message}`))
  const retained = await findImportStaging(modelId)
  if (retained) {
    // Equal file sizes alone could pass a checkpoint from another repo or
    // subdir off as this one; a marker that cannot name its source is retired.
    const sameSource = retained.marker.repo === repo && retained.marker.subdir === subdir
    const complete = sameSource && await stagedFilesComplete(join(retained.tempRoot, 'model'), files)
    if (complete) {
      // Reusing is non-destructive, but stacking a second create on one the
      // daemon is still running is not; wait only for a holder we can see.
      const release = await awaitStagingRelease(retained.tempRoot, { attempts: 1 })
      if (release.pids?.length) {
        return heldImportResult(modelId, `A previous import of ${modelId} is still running.`, release.reason)
      }
      tempRoot = retained.tempRoot
      reuse = true
      console.log(`♻️ Reusing retained Safetensors staging for ${modelId}`)
    } else if (retained.marker.phase === 'downloading') {
      // `ollama create` never started, so no other process ever read it.
      await removeImportStaging(retained.tempRoot)
    } else {
      const release = await awaitStagingRelease(retained.tempRoot, { attempts: 1 })
      if (!release.free) {
        return heldImportResult(modelId, `A previous import of ${modelId} left a checkpoint it cannot reuse.`, release.reason)
      }
      await removeImportStaging(retained.tempRoot)
    }
  }

  // This import writes the checkpoint TWICE — once staged under `tmpdir()`,
  // once more when `ollama create` below lands it in the models dir — on
  // volumes that can differ (a temp partition, or OLLAMA_MODELS pointed at
  // external storage). The outer installModel() preflight only checked one
  // copy against one of those volumes using a catalog-string size estimate;
  // this uses the real per-file bytes this import already fetched from HF.
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (!reuse) {
    const stagingPreflight = await assessDownloadPreflight({ destPath: tmpdir(), expectedBytes: total })
    if (stagingPreflight.verdict === DOWNLOAD_VERDICTS.INSUFFICIENT) {
      return { success: false, error: diskInsufficientError(stagingPreflight).message, modelId, code: 'DISK_INSUFFICIENT' }
    }
  }
  const modelsDirPreflight = await assessDownloadPreflight({ destPath: getModelsDir(), expectedBytes: total })
  if (modelsDirPreflight.verdict === DOWNLOAD_VERDICTS.INSUFFICIENT) {
    return { success: false, error: diskInsufficientError(modelsDirPreflight).message, modelId, code: 'DISK_INSUFFICIENT' }
  }

  if (!tempRoot) tempRoot = await createImportStaging({ modelId, repo, subdir })
  const modelDir = join(tempRoot, 'model')
  if (!reuse) {
    let completed = 0
    let lastPercent = -1
    const reportBytes = (bytes) => {
      completed += bytes
      const percent = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null
      if (percent === lastPercent) return
      lastPercent = percent
      if (typeof onProgress === 'function') onProgress({ status: 'downloading MLX checkpoint', percent, completed, total })
    }
    const downloadError = await (async () => {
      for (const file of files) {
        await downloadHfImportFile({
          repo,
          remotePath: file.remotePath,
          destination: join(modelDir, ...file.relativePath.split('/')),
          headers,
          progress: reportBytes
        })
      }
    })().then(() => null, (err) => err)
    if (downloadError) {
      await removeImportStaging(tempRoot)
      return { success: false, error: downloadError.message, modelId }
    }
  }

  const modelfile = join(tempRoot, 'Modelfile')
  await atomicWrite(modelfile, `FROM ${modelDir}\n`)
  await updateImportStaging(tempRoot, { phase: 'creating' })
  const report = (status) => {
    if (typeof onProgress === 'function') onProgress({ status, percent: null, importing: true })
  }
  report('importing checkpoint into Ollama')
  const outcome = await runSupervisedOllamaCreate({
    modelId,
    modelfile,
    onStatus: (line) => report(`importing: ${line}`),
    probeProgress: () => blobStoreSignature(getModelsDir())
  })
  if (outcome.status === 'completed') {
    // A clean CLI exit means the daemon answered the whole create request.
    await removeImportStaging(tempRoot)
    bustInstalledModelsCache()
    console.log(`✅ Ollama Safetensors import complete: ${modelId}`)
    return { success: true, modelId }
  }

  const release = outcome.exited === false
    ? { free: false, reason: 'the ollama create process did not exit after being stopped' }
    : await awaitStagingRelease(tempRoot)
  if (release.free) {
    await removeImportStaging(tempRoot)
    return { success: false, error: outcome.error, modelId, ...(outcome.status === 'stalled' ? { code: 'OLLAMA_IMPORT_STALLED' } : {}) }
  }
  await updateImportStaging(tempRoot, { phase: 'retained', retainedAt: new Date().toISOString(), reason: release.reason })
  console.log(`⏭️ Kept Safetensors staging for ${modelId}: ${release.reason}`)
  return heldImportResult(modelId, outcome.error, release.reason)
}
